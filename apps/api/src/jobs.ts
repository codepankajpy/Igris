/**
 * Scan jobs: one flow — scan a site, cache the result, publish it to the
 * site registry as the hostname's next version.
 *
 * Truthfulness rules:
 *  - progress events are the scanner's own (scan({ onProgress })); the
 *    service never invents a stage or a percentage;
 *  - a scan whose page never loaded (coverage "none") is not a version: the
 *    job is `failed` with the scanner's reason and nothing is published;
 *  - a scan that finished but could not be published is `completed` with
 *    `publish: { ok: false, error }`, and can be retried from the cache;
 *  - a scan interrupted by a server restart is marked as such, never left
 *    looking alive;
 *  - a scan is never published twice: before a retry (and after a restart
 *    cut a publish short) the registry is asked for that scanId, and an
 *    existing version is adopted;
 *  - a retry never puts an older scan on top of a newer version of the
 *    hostname (it is refused, and the job says why);
 *  - at most one scan per hostname is in flight (a retest while one runs
 *    would race for the same version number).
 *
 * Job metadata lives in <dataDir>/jobs/<id>.json (operator's machine only);
 * finished scans in the cache (artifacts.ts).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPORT_V3_VERSION,
  type EvidenceBundle,
  type ReportV3,
  type ScanResult,
} from '@igris/core';
import type { EgressPolicy, ScanOptions, ScanProgressEvent } from '@igris/scanner';
import type { SiteRegistry } from '@igris/registry';
import { readCachedScan, writeCachedScan } from './artifacts.js';
import { JobQueue, JobTimeoutError } from './limits.js';
import { errText } from './public.js';

export type JobState = 'queued' | 'running' | 'completed' | 'failed';

export interface JobPublish {
  ok: boolean;
  error?: string;
  mode?: 'arkiv' | 'local';
  scanKey?: string;
  evidenceKey?: string;
  flowKeys?: string[];
  txHash?: string | null;
}

export interface Job {
  id: string;
  hostname: string;
  url: string;
  state: JobState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  events: ScanProgressEvent[];
  /** The published version number; null until (or unless) published. */
  version: number | null;
  /** null until the scan finished and a publish was attempted. */
  publish: JobPublish | null;
}

export interface DonePayload {
  state: JobState;
  hostname: string;
  version: number | null;
  error: string | null;
  publish: JobPublish | null;
}

export type JobEvent =
  | { kind: 'state'; state: JobState }
  | { kind: 'progress'; event: ScanProgressEvent }
  | { kind: 'done'; done: DonePayload };

export type ScanFn = (options: ScanOptions) => Promise<ScanResult>;

export interface SiteScanServiceOptions {
  dataDir: string;
  queue: JobQueue;
  scan: ScanFn;
  registry: SiteRegistry;
  /** Forced on every scan; never taken from a request. Public-only by type. */
  egress: Extract<EgressPolicy, { mode: 'public-only' }>;
  dwellMs: number;
  /** Run Chromium inside its own OS sandbox (IGRIS_CHROMIUM_SANDBOX). */
  chromiumSandbox?: boolean;
  log?: (m: string) => void;
}

export class ScanInProgress extends Error {
  constructor(readonly id: string) {
    super('a scan of this hostname is already running');
  }
}
export class ScanQueueFull extends Error {}
export class PublishConflict extends Error {}

interface JobRecord {
  job: Job;
  /** contentHash(report) of the finished scan (its cache key); null before. */
  scanId: string | null;
}

const MAX_JOBS = 1000;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isJobId = (s: string): boolean => ID_RE.test(s);

export function doneOf(job: Job): DonePayload {
  return {
    state: job.state,
    hostname: job.hostname,
    version: job.version,
    error: job.error ?? null,
    publish: job.publish,
  };
}

/** Why a scan measured nothing, in the scanner's own words. */
function notObservedReason(report: ReportV3): string {
  const f = report.scan.failure;
  const why = f
    ? `${f.category.replaceAll('-', ' ')} (${f.detail})`
    : (report.scan.notes[0] ?? 'the page did not load');
  return `nothing was observed: ${why}`;
}

export class SiteScanService {
  private readonly records = new Map<string, JobRecord>();
  private readonly publishing = new Set<string>();
  private readonly listeners = new Map<string, Set<(e: JobEvent) => void>>();
  private readonly jobsDir: string;

  constructor(private readonly o: SiteScanServiceOptions) {
    this.jobsDir = join(o.dataDir, 'jobs');
    mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
    this.reconciled = this.reconcile(this.loadExisting());
  }

  /** Settles once jobs interrupted mid-publish by a restart were checked against the registry. */
  readonly reconciled: Promise<void>;

  private persist(rec: JobRecord): void {
    writeFileSync(
      join(this.jobsDir, `${rec.job.id}.json`),
      JSON.stringify({ job: rec.job, scanId: rec.scanId }) + '\n',
    );
  }

  private loadExisting(): string[] {
    const loaded: JobRecord[] = [];
    const interruptedPublishes: string[] = [];
    for (const name of readdirSync(this.jobsDir)) {
      const id = name.replace(/\.json$/, '');
      if (!isJobId(id) || name !== `${id}.json`) continue;
      try {
        const raw = JSON.parse(readFileSync(join(this.jobsDir, name), 'utf8')) as JobRecord;
        if (raw?.job?.id !== id) continue;
        // Only what this release writes (earlier records may carry more).
        const { request: _request, ...job } = raw.job as Job & { request?: unknown };
        const rec: JobRecord = { job, scanId: raw.scanId ?? null };
        if (job.state === 'queued' || job.state === 'running') {
          // The process that ran it is gone: say so instead of pretending.
          job.finishedAt = new Date().toISOString();
          if (rec.scanId) {
            // The scan had finished; only the publish was cut short (retryable).
            job.state = 'completed';
            job.publish = {
              ok: false,
              error: 'interrupted: the server restarted while publishing',
              mode: this.o.registry.mode,
            };
            // The publish may have landed before the process died: reconcile()
            // looks it up before anyone can publish it a second time.
            interruptedPublishes.push(id);
          } else {
            job.state = 'failed';
            job.error = 'interrupted: the server restarted before this scan finished';
          }
          this.persist(rec);
        }
        loaded.push(rec);
      } catch {
        this.o.log?.(`skipping unreadable job ${id}`);
      }
    }
    loaded.sort((a, b) => (a.job.createdAt < b.job.createdAt ? -1 : 1));
    for (const rec of loaded) this.records.set(rec.job.id, rec);
    this.prune();
    return interruptedPublishes.filter((id) => this.records.has(id));
  }

  /**
   * After a restart: a job cut short while publishing may in fact be
   * published. Adopt the registry's version when it is (never publish it
   * again); otherwise leave it retryable. Retries wait for this (the job is
   * marked as being published meanwhile).
   */
  private async reconcile(ids: string[]): Promise<void> {
    for (const id of ids) this.publishing.add(id);
    for (const id of ids) {
      const rec = this.records.get(id);
      try {
        if (rec?.scanId) {
          const found = await this.adoptPublished(rec, rec.scanId);
          if (found) this.o.log?.(`scan ${id}: publish had landed as v${rec.job.version}`);
        }
      } catch (err) {
        this.o.log?.(`scan ${id}: could not check the registry after restart (${errText(err)})`);
      } finally {
        this.publishing.delete(id);
      }
    }
  }

  /**
   * If the registry already holds this scan, record that version on the job
   * (publish ok) and return true. Registry errors propagate: a scan is never
   * published blind when we cannot tell whether it already is.
   */
  private async adoptPublished(rec: JobRecord, scanId: string): Promise<boolean> {
    const existing = await this.o.registry.findByScanId(rec.job.hostname, scanId);
    if (!existing) return false;
    rec.job.version = existing.version;
    rec.job.publish = { ok: true, mode: this.o.registry.mode, scanKey: existing.key };
    this.persist(rec);
    return true;
  }

  /** contentHash of a finished job's report (its cache key), null before it finished. */
  scanIdOf(id: string): string | null {
    return this.records.get(id)?.scanId ?? null;
  }

  /** Forget the oldest finished jobs beyond MAX_JOBS (their cached scans stay). */
  private prune(): void {
    if (this.records.size <= MAX_JOBS) return;
    for (const [id, rec] of this.records) {
      if (this.records.size <= MAX_JOBS) break;
      if (rec.job.state !== 'completed' && rec.job.state !== 'failed') continue;
      if (this.publishing.has(id)) continue;
      this.records.delete(id);
      rmSync(join(this.jobsDir, `${id}.json`), { force: true });
    }
  }

  get(id: string): Job | undefined {
    return this.records.get(id)?.job;
  }

  /** Would submit() find room in the queue right now? */
  canAccept(): boolean {
    return this.o.queue.canAccept();
  }

  /** The queued or running job for a hostname, if any. */
  inFlight(hostname: string): Job | undefined {
    for (const { job } of this.records.values()) {
      if (job.hostname === hostname && (job.state === 'queued' || job.state === 'running'))
        return job;
    }
    return undefined;
  }

  subscribe(id: string, fn: (e: JobEvent) => void): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(fn);
    this.listeners.set(id, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(id);
    };
  }

  private emit(id: string, e: JobEvent): void {
    for (const fn of [...(this.listeners.get(id) ?? [])]) {
      try {
        fn(e);
      } catch {
        /* a broken subscriber must not affect the scan */
      }
    }
  }

  private finish(rec: JobRecord): void {
    rec.job.finishedAt = new Date().toISOString();
    this.persist(rec);
    this.emit(rec.job.id, { kind: 'done', done: doneOf(rec.job) });
  }

  /**
   * Start a scan (or retest) of `hostname` at `url`. Throws ScanInProgress
   * when one is already queued/running for the hostname, ScanQueueFull when
   * the queue cannot take it.
   */
  submit(hostname: string, url: string): Job {
    const running = this.inFlight(hostname);
    if (running) throw new ScanInProgress(running.id);
    if (!this.o.queue.canAccept()) throw new ScanQueueFull('scanner busy; try again in a minute');
    const job: Job = {
      id: randomUUID(),
      hostname,
      url,
      state: 'queued',
      createdAt: new Date().toISOString(),
      events: [],
      version: null,
      publish: null,
    };
    const rec: JobRecord = { job, scanId: null };
    this.records.set(job.id, rec);
    this.persist(rec);
    this.prune();

    const scanning = this.o.queue.run(async (signal) => {
      job.state = 'running';
      job.startedAt = new Date().toISOString();
      this.persist(rec);
      this.emit(job.id, { kind: 'state', state: 'running' });
      return this.o.scan({
        url,
        dwellMs: this.o.dwellMs,
        signal,
        // NOT configurable by the request: every scan is public-only.
        egress: this.o.egress,
        ...(this.o.chromiumSandbox === true ? { chromiumSandbox: true } : {}),
        onProgress: (e) => {
          job.events.push(e);
          this.emit(job.id, { kind: 'progress', event: e });
        },
      });
    });
    scanning.then(
      (result) => void this.afterScan(rec, result),
      (err: unknown) => {
        job.state = 'failed';
        job.error =
          err instanceof JobTimeoutError
            ? `timed out: ${err.message}`
            : `scan failed: ${errText(err)}`;
        this.finish(rec);
        this.o.log?.(`scan ${job.id} failed`);
      },
    );
    return job;
  }

  private async afterScan(rec: JobRecord, { report, bundle }: ScanResult): Promise<void> {
    const job = rec.job;
    try {
      if (report.privacy.coverage === 'none') {
        job.state = 'failed';
        job.error = notObservedReason(report);
        this.finish(rec);
        this.o.log?.(`scan ${job.id}: nothing observed, not published`);
        return;
      }
      rec.scanId = writeCachedScan(this.o.dataDir, report, bundle);
      this.persist(rec);
      this.publishing.add(job.id);
      try {
        await this.publishScan(rec, report, bundle);
      } finally {
        this.publishing.delete(job.id);
      }
      job.state = 'completed';
      this.finish(rec);
      this.o.log?.(
        `scan ${job.id} completed; ${job.publish?.ok ? `published as v${job.version}` : 'publish failed'}`,
      );
    } catch (err) {
      // Only reachable if the cache cannot be written.
      job.state = 'failed';
      job.error = `could not store the scan: ${errText(err)}`;
      this.finish(rec);
    }
  }

  private async publishScan(
    rec: JobRecord,
    report: ReportV3,
    bundle: EvidenceBundle,
  ): Promise<void> {
    const { registry } = this.o;
    const job = rec.job;
    if (registry.publisher === null) {
      job.publish = {
        ok: false,
        error: 'the registry is read-only: no scanner key is configured',
        mode: registry.mode,
      };
      return;
    }
    try {
      const r = await registry.publish(report, bundle);
      job.version = r.scan.version;
      job.publish = {
        ok: true,
        mode: registry.mode,
        scanKey: r.scan.key,
        evidenceKey: r.evidenceKey,
        flowKeys: r.flowKeys,
        txHash: r.txHash,
      };
    } catch (err) {
      job.publish = { ok: false, error: errText(err), mode: registry.mode };
    } finally {
      this.persist(rec);
    }
  }

  /**
   * Retry the publish of a completed scan whose publish failed. Throws
   * PublishConflict when the job is not completed, is already published, is
   * being published, another scan of the hostname is in flight, or the scan
   * is older than what the hostname already has (a retry never puts an old
   * scan on top of a newer version; publish then stays ok:false with why).
   * A scan the registry already holds is adopted, never published twice.
   */
  async retryPublish(id: string): Promise<JobPublish | null> {
    const rec = this.records.get(id);
    if (!rec) throw new Error('scan not found');
    const job = rec.job;
    if (job.state !== 'completed') throw new PublishConflict(`scan is ${job.state}`);
    if (job.publish?.ok) throw new PublishConflict('scan is already published');
    if (this.publishing.has(id)) throw new PublishConflict('scan is being published');
    const other = this.inFlight(job.hostname);
    if (other) throw new PublishConflict(`a scan of ${job.hostname} is running (${other.id})`);
    const { registry } = this.o;
    const fail = (error: string): JobPublish => {
      job.publish = { ok: false, error, mode: registry.mode };
      this.persist(rec);
      return job.publish;
    };
    const cached = rec.scanId ? readCachedScan(this.o.dataDir, rec.scanId) : null;
    if (cached?.draft) {
      // Its upgrade is for display: publishing it would publish a document
      // that was never scanned as such (and under another scanId).
      return fail(
        `the cached scan is a draft ${REPORT_V3_VERSION} report (before wallet requests); it is shown, never published`,
      );
    }
    if (!rec.scanId || !cached || cached.problems.length > 0) {
      return fail(
        cached
          ? `the cached scan failed verification: ${cached.problems.join('; ')}`
          : 'the cached scan is missing',
      );
    }
    const scanId = rec.scanId;
    this.publishing.add(id);
    try {
      try {
        if (await this.adoptPublished(rec, scanId)) return job.publish;
      } catch (err) {
        return fail(`could not check whether this scan is already published: ${errText(err)}`);
      }
      let stale: string | null;
      try {
        stale = await this.staleReason(rec, cached.report);
      } catch (err) {
        return fail(`could not read the latest version of ${job.hostname}: ${errText(err)}`);
      }
      if (stale !== null) {
        fail(stale);
        throw new PublishConflict(stale);
      }
      await this.publishScan(rec, cached.report, cached.bundle);
      return job.publish;
    } finally {
      this.publishing.delete(id);
    }
  }

  /**
   * Why publishing `report` now would put an older scan on top of a newer
   * one (null when it would not): the registry's latest version was scanned
   * at or after it, or a later job of the hostname is already published.
   */
  private async staleReason(rec: JobRecord, report: ReportV3): Promise<string | null> {
    const job = rec.job;
    const scannedAt = Math.floor(Date.parse(report.scan.scannedAt) / 1000);
    for (const { job: o } of this.records.values()) {
      if (
        o.id !== job.id &&
        o.hostname === job.hostname &&
        o.publish?.ok &&
        o.createdAt > job.createdAt
      ) {
        return `a newer scan of ${job.hostname} is already published${o.version !== null ? ` as v${o.version}` : ''} (${o.id}); this older scan is not published over it`;
      }
    }
    const latest = await this.o.registry.latest(job.hostname);
    if (latest && latest.scannedAt >= scannedAt) {
      return `${job.hostname} v${latest.version} was scanned at or after this scan; this older scan is not published over it`;
    }
    return null;
  }
}
