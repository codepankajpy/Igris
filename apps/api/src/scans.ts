/**
 * Scan jobs for the web application: submission, real progress, persistence.
 *
 * Truthfulness rules:
 *  - progress events are the scanner's own (scan({ onProgress })) — the
 *    service never invents a stage or a percentage;
 *  - a scan whose page never loaded is `completed` with no score (the report
 *    says why), not a success with a number;
 *  - a scan interrupted by a server restart is marked `failed`
 *    ("interrupted"), never left looking alive;
 *  - every report served from disk is re-verified (schema + integrity) on
 *    load, and the verification result is returned with it.
 *
 * Storage (local to the operator's machine): <dataDir>/scans/<id>/
 *   meta.json      job metadata + progress events + summary
 *   report.json    Report v2.x (pretty)
 *   evidence.json  evidence bundle (canonical bytes)
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assess, type CanaryMatchEvidence, type ReportV2, type ScanResult } from '@igris/core';
import type { ScanOptions, ScanProgressEvent } from '@igris/scanner';
import { loadScanArtifacts, writeScanArtifacts } from '@igris/cli';
import { JobQueue, JobTimeoutError } from './limits.js';

export type JobState = 'queued' | 'running' | 'completed' | 'failed';

export interface ScanSummary {
  /** Deterministic assessment level (core assess()). */
  level: string;
  headline: string;
  status: ReportV2['scan']['status'];
  score: number | null;
  coverage: ReportV2['privacy']['coverage'];
  failure: { category: string; detail: string } | null;
  findings: {
    total: number;
    bySeverity: Record<'critical' | 'high' | 'medium' | 'low' | 'info', number>;
    byKind: Record<'issue' | 'risk' | 'observation', number>;
  };
  securityObservations: number;
  addressLeaks: number;
  leakDomains: string[];
  thirdPartyDomains: string[];
  kit: { id: string; confidence: string } | null;
  walletConnected: boolean;
  usesAnonRpc: boolean;
  evidence: { sha256: string; itemCount: number };
  findingSet: { sha256: string; count: number };
}

export interface ScanMeta {
  id: string;
  url: string;
  hostname: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  state: JobState;
  error?: string;
  events: ScanProgressEvent[];
  summary?: ScanSummary;
}

export function summarize({ report, bundle }: ScanResult): ScanSummary {
  const all = [...report.privacy.findings, ...report.security.observations];
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byKind = { issue: 0, risk: 0, observation: 0 };
  for (const f of all) {
    bySeverity[f.severity] += 1;
    byKind[f.kind] += 1;
  }
  const leaks = report.privacy.findings.filter(
    (f) => f.detector === 'canary-leak' && f.countsTowardPrivacyScore,
  );
  const conn = report.scan.connection;
  const assessment = assess(report, bundle);
  return {
    level: assessment.level,
    headline: assessment.headline,
    status: report.scan.status,
    score: report.privacy.score,
    coverage: report.privacy.coverage,
    failure: report.scan.failure ?? null,
    findings: { total: all.length, bySeverity, byKind },
    securityObservations: report.security.observations.length,
    addressLeaks: leaks.length,
    // From the canary-match evidence itself, not from finding titles.
    leakDomains: [
      ...new Set(
        leaks.flatMap((f) =>
          f.evidence
            .map((ref) => bundle.items[ref.id])
            .filter((i): i is CanaryMatchEvidence => i?.type === 'canary-match')
            .map((i) => i.registrableDomain),
        ),
      ),
    ].sort(),
    thirdPartyDomains: [...new Set(report.contacts.map((c) => c.registrableDomain))].sort(),
    kit:
      conn && conn.kit.id !== 'none' ? { id: conn.kit.id, confidence: conn.kit.confidence } : null,
    walletConnected: report.scan.status === 'completed',
    usesAnonRpc: report.wallet.usesAnonRpc,
    evidence: { sha256: report.evidence.sha256, itemCount: report.evidence.itemCount },
    findingSet: report.findingSet,
  };
}

export type ScanFn = (options: ScanOptions) => Promise<ScanResult>;

export interface ScanServiceOptions {
  dataDir: string;
  queue: JobQueue;
  scan: ScanFn;
  /** Options forced on every scan (egress policy etc.). */
  scanDefaults: Pick<ScanOptions, 'egress'>;
  log?: (m: string) => void;
}

export class ScanQueueFull extends Error {}

export class ScanService {
  private readonly metas = new Map<string, ScanMeta>();
  private readonly listeners = new Map<
    string,
    Set<(e: ScanProgressEvent | { done: ScanMeta }) => void>
  >();
  private readonly root: string;

  constructor(private readonly o: ScanServiceOptions) {
    this.root = join(o.dataDir, 'scans');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.loadExisting();
  }

  private dir(id: string): string {
    return join(this.root, id);
  }

  private persist(meta: ScanMeta): void {
    mkdirSync(this.dir(meta.id), { recursive: true });
    writeFileSync(join(this.dir(meta.id), 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  }

  private loadExisting(): void {
    for (const id of readdirSync(this.root)) {
      const p = join(this.root, id, 'meta.json');
      if (!/^[0-9a-f-]{36}$/.test(id) || !existsSync(p)) continue;
      try {
        const meta = JSON.parse(readFileSync(p, 'utf8')) as ScanMeta;
        if (meta.state === 'queued' || meta.state === 'running') {
          // The process that ran it is gone: say so instead of pretending.
          meta.state = 'failed';
          meta.error = 'interrupted: the server restarted before this scan finished';
          meta.finishedAt = meta.finishedAt ?? new Date().toISOString();
          this.persist(meta);
        }
        this.metas.set(meta.id, meta);
      } catch {
        this.o.log?.(`skipping unreadable scan metadata ${id}`);
      }
    }
  }

  list(): ScanMeta[] {
    return [...this.metas.values()]
      .map(({ events: _e, ...m }) => ({ ...m, events: [] }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  get(id: string): ScanMeta | undefined {
    return this.metas.get(id);
  }

  /** Report + evidence, re-verified from disk. */
  artifacts(
    id: string,
  ): (ScanResult & { verification: { schema: true; integrity: true } }) | undefined {
    const meta = this.metas.get(id);
    if (!meta || meta.state !== 'completed') return undefined;
    const loaded = loadScanArtifacts(join(this.dir(id), 'report.json')); // throws on any mismatch
    return {
      report: loaded.report,
      bundle: loaded.bundle,
      verification: { schema: true, integrity: true },
    };
  }

  subscribe(id: string, fn: (e: ScanProgressEvent | { done: ScanMeta }) => void): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(fn);
    this.listeners.set(id, set);
    return () => set.delete(fn);
  }

  private publish(id: string, e: ScanProgressEvent | { done: ScanMeta }): void {
    for (const fn of this.listeners.get(id) ?? []) {
      try {
        fn(e);
      } catch {
        /* a broken subscriber must not affect the scan */
      }
    }
  }

  /** Create a job. Throws ScanQueueFull when the queue cannot take it. */
  submit(url: string, dwellMs: number): ScanMeta {
    if (!this.o.queue.canAccept()) throw new ScanQueueFull();
    const meta: ScanMeta = {
      id: randomUUID(),
      url,
      hostname: new URL(url).hostname,
      createdAt: new Date().toISOString(),
      state: 'queued',
      events: [],
    };
    const promise = this.o.queue.run(async (signal) => {
      meta.state = 'running';
      meta.startedAt = new Date().toISOString();
      this.persist(meta);
      return this.o.scan({
        url,
        dwellMs,
        signal,
        ...this.o.scanDefaults,
        onProgress: (e) => {
          meta.events.push(e);
          this.publish(meta.id, e);
        },
      });
    });
    this.metas.set(meta.id, meta);
    this.persist(meta);
    promise.then(
      (result) => {
        writeScanArtifacts(this.dir(meta.id), result);
        meta.summary = summarize(result);
        meta.state = 'completed';
        meta.finishedAt = new Date().toISOString();
        this.persist(meta);
        this.publish(meta.id, { done: meta });
        this.o.log?.(`scan ${meta.id} completed: score ${meta.summary.score ?? 'none'}`);
      },
      (err: unknown) => {
        meta.state = 'failed';
        meta.error =
          err instanceof JobTimeoutError
            ? `timed out: ${err.message}`
            : `scan failed: ${String(err).slice(0, 300)}`;
        meta.finishedAt = new Date().toISOString();
        this.persist(meta);
        this.publish(meta.id, { done: meta });
        this.o.log?.(`scan ${meta.id} failed`);
      },
    );
    return meta;
  }
}
