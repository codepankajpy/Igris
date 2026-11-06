/**
 * IGRIS hosted scanner API — an OPTIONAL convenience node.
 *
 * What it is: one scanner among many. It runs the same open-source scanner
 * as the CLI, behind abuse controls, with egress forced to public-only.
 *
 * What it is NOT: a registry, a trust anchor, or an Arkiv publisher. It holds
 * no scanner key and never attributes a result to one. Every response carries
 * `provenance: "unpublished"`; publishing an attestation is done by a scanner
 * operator with their own key (`igris publish`), so the claim is theirs.
 *
 * It keeps no store of results and logs no client identity.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIP } from 'node:net';
import type { EvidenceBundleV1, ReportV2, ScanResult } from '@igris/core';
import type { ScanOptions } from '@igris/scanner';
import type { ScanRecord } from '@igris/registry';
import type { ApiConfig } from './config.js';
import { JobQueue, JobTimeoutError, QueueFullError, RateLimiter } from './limits.js';
import { RepoRejectedError, cloneRepo, enforceRepoLimits, validateRepoUrl } from './repo.js';
import { ScanQueueFull, type ScanMeta, type ScanService } from './scans.js';

export interface FixResultLike {
  diff: string;
  changedFiles: string[];
  notes: Array<{ file: string; line: number; message: string }>;
}

/** Side-effectful collaborators, injected so the HTTP layer is testable. */
export interface ApiDeps {
  scan: (options: ScanOptions) => Promise<ScanResult>;
  fix: (options: { targetDir: string }) => FixResultLike;
  recordFromReport: (report: ReportV2, bundle: EvidenceBundleV1) => ScanRecord;
  isPublicAddress: (ip: string) => boolean;
  /** Clone step (default: hardened git clone). */
  clone?: typeof cloneRepo;
  log?: (msg: string) => void;
  /** Scan jobs + persistence for the web application (optional). */
  scans?: ScanService;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Dashboard aggregates — computed only from stored scan summaries. */
export function aggregateStats(metas: ScanMeta[]) {
  const done = metas.filter((m) => m.state === 'completed' && m.summary);
  const scored = done.filter((m) => m.summary!.score !== null);
  const severity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const thirdParties = new Map<string, number>();
  const leakDomains = new Map<string, number>();
  const kits = new Map<string, number>();
  for (const m of done) {
    const s = m.summary!;
    for (const k of Object.keys(severity) as Array<keyof typeof severity>)
      severity[k] += s.findings.bySeverity[k];
    for (const d of s.thirdPartyDomains) thirdParties.set(d, (thirdParties.get(d) ?? 0) + 1);
    for (const d of s.leakDomains) leakDomains.set(d, (leakDomains.get(d) ?? 0) + 1);
    if (s.kit) kits.set(s.kit.id, (kits.get(s.kit.id) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([domain, scans]) => ({ domain, scans }));
  return {
    totals: {
      scans: metas.length,
      completed: done.length,
      failed: metas.filter((m) => m.state === 'failed').length,
      inProgress: metas.filter((m) => m.state === 'queued' || m.state === 'running').length,
      scored: scored.length,
      notScored: done.length - scored.length,
      dapps: new Set(done.map((m) => m.hostname)).size,
    },
    averageScore: scored.length
      ? Math.round(scored.reduce((a, m) => a + m.summary!.score!, 0) / scored.length)
      : null,
    severity,
    addressLeaks: done.reduce((a, m) => a + m.summary!.addressLeaks, 0),
    topThirdParties: top(thirdParties),
    topLeakDomains: top(leakDomains),
    kits: Object.fromEntries(kits),
  };
}

export class BadRequest extends Error {}

/** Validate a scan target URL. The egress proxy is the real control; this fails fast. */
export function validateScanUrl(
  input: unknown,
  allowedPorts: number[],
  isPublic: (ip: string) => boolean,
): string {
  if (typeof input !== 'string' || input.length > 2048)
    throw new BadRequest('url must be a string');
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new BadRequest('url is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new BadRequest('url must be http(s)');
  if (u.username || u.password) throw new BadRequest('url must not contain credentials');
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (!allowedPorts.includes(port)) throw new BadRequest(`port ${port} is not allowed`);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new BadRequest(
      'internal hostnames are not scanned by the hosted node; use the local CLI',
    );
  }
  if (isIP(host) && !isPublic(host)) {
    throw new BadRequest(
      'non-public addresses are not scanned by the hosted node; use the local CLI',
    );
  }
  return u.toString();
}

function clientId(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function createApp(config: ApiConfig, deps: ApiDeps): express.Express {
  const log = deps.log ?? ((m: string) => console.log(`[igris-api] ${m}`));
  const queue = new JobQueue(config.concurrency, config.maxQueued, config.jobTimeoutMs);
  const limiter = new RateLimiter(config.rateLimitMax, config.rateLimitWindowMs);
  const clone = deps.clone ?? cloneRepo;

  const app = express();
  app.disable('x-powered-by');
  app.use(
    cors({
      origin: (origin, cb) =>
        cb(null, origin !== undefined && config.allowedOrigins.includes(origin)),
      methods: ['GET', 'POST'],
    }),
  );
  app.use(express.json({ limit: '16kb' }));

  const rateLimited = (req: Request, res: Response, next: NextFunction) => {
    if (!limiter.take(clientId(req, config.trustProxy))) {
      res.status(429).json({ error: 'rate limit exceeded; try again later' });
      return;
    }
    next();
  };

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'igris-scanner-api',
      role: 'optional hosted scanner (results are unpublished; no scanner key held)',
      egress: 'public-only',
      queue: queue.stats,
    });
  });

  app.post('/api/scan', rateLimited, async (req, res) => {
    let url: string;
    try {
      url = validateScanUrl(req.body?.url, config.allowedPorts, deps.isPublicAddress);
    } catch (err) {
      res.status(400).json({ error: err instanceof BadRequest ? err.message : 'invalid request' });
      return;
    }
    const dwellMs =
      typeof req.body?.dwellMs === 'number'
        ? Math.min(Math.max(Math.round(req.body.dwellMs), 1000), 20000)
        : 4000;
    try {
      const { report, bundle } = await queue.run((signal) =>
        deps.scan({
          url,
          dwellMs,
          spoofMetaMask: req.body?.spoofMetaMask !== false,
          signal,
          // NOT configurable by the request: hosted scans are public-only.
          egress: { mode: 'public-only', allowedPorts: config.allowedPorts },
        }),
      );
      // A preview of what an operator COULD publish; null when nothing was
      // measured. Never an entity, never attributed to a scanner.
      let preview: ScanRecord | null = null;
      try {
        preview = deps.recordFromReport(report, bundle);
      } catch {
        preview = null;
      }
      log(`scan finished: status=${report.scan.status} score=${report.privacy.score ?? 'none'}`);
      res.json({ provenance: 'unpublished', report, evidence: bundle, preview });
    } catch (err) {
      sendJobError(res, err, log);
    }
  });

  app.post('/api/scan-repo', rateLimited, async (req, res) => {
    let url: string;
    try {
      url = validateRepoUrl(req.body?.repoUrl);
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof RepoRejectedError ? err.message : 'invalid request' });
      return;
    }
    try {
      const result = await queue.run(async (signal) => {
        const work = mkdtempSync(join(tmpdir(), 'igris-repo-'));
        const dest = join(work, 'repo');
        try {
          await clone(url, dest, work, config.repo.cloneTimeoutMs, signal);
          enforceRepoLimits(dest, config.repo);
          return deps.fix({ targetDir: dest });
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      });
      log(`repo analysed: ${result.changedFiles.length} file(s) changed`);
      res.json({
        repoUrl: url,
        changedFiles: result.changedFiles,
        diff: result.diff,
        notes: result.notes,
      });
    } catch (err) {
      if (err instanceof RepoRejectedError) {
        res.status(422).json({ error: err.message });
        return;
      }
      sendJobError(res, err, log);
    }
  });

  // ---------------- web application: scan jobs ----------------
  const scans = deps.scans;
  if (scans) {
    app.post('/api/scans', rateLimited, (req, res) => {
      let url: string;
      try {
        url = validateScanUrl(req.body?.url, config.allowedPorts, deps.isPublicAddress);
      } catch (err) {
        res
          .status(400)
          .json({ error: err instanceof BadRequest ? err.message : 'invalid request' });
        return;
      }
      const dwellMs =
        typeof req.body?.dwellMs === 'number'
          ? Math.min(Math.max(Math.round(req.body.dwellMs), 1000), 20000)
          : 4000;
      try {
        const meta = scans.submit(url, dwellMs);
        res.status(202).json({ id: meta.id, state: meta.state });
      } catch (err) {
        if (err instanceof ScanQueueFull) {
          res.status(503).json({ error: 'scanner busy; try again in a minute' });
          return;
        }
        throw err;
      }
    });

    app.get('/api/scans', (_req, res) => {
      res.json({ scans: scans.list() });
    });

    app.get('/api/stats', (_req, res) => {
      res.json(aggregateStats(scans.list()));
    });

    app.get('/api/scans/:id', (req, res) => {
      const meta = UUID_RE.test(req.params.id) ? scans.get(req.params.id) : undefined;
      if (!meta) {
        res.status(404).json({ error: 'scan not found' });
        return;
      }
      res.json({ scan: meta });
    });

    app.get('/api/scans/:id/report', (req, res) => {
      const meta = UUID_RE.test(req.params.id) ? scans.get(req.params.id) : undefined;
      if (!meta) {
        res.status(404).json({ error: 'scan not found' });
        return;
      }
      if (meta.state !== 'completed') {
        res.status(409).json({ error: `scan is ${meta.state}` });
        return;
      }
      try {
        const a = scans.artifacts(meta.id)!;
        res.json({ report: a.report, evidence: a.bundle, verification: a.verification });
      } catch (err) {
        log(`stored artifacts for ${meta.id} failed verification: ${String(err).slice(0, 200)}`);
        res
          .status(500)
          .json({ error: 'stored report failed verification', detail: String(err).slice(0, 300) });
      }
    });

    // Server-sent events: replay what already happened, then stream live.
    app.get('/api/scans/:id/events', (req, res) => {
      const meta = UUID_RE.test(req.params.id) ? scans.get(req.params.id) : undefined;
      if (!meta) {
        res.status(404).json({ error: 'scan not found' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      let lastState = meta.state;
      send('state', { state: meta.state });
      for (const e of meta.events) send('progress', e);
      if (meta.state === 'completed' || meta.state === 'failed') {
        send('done', { state: meta.state, error: meta.error ?? null });
        res.end();
        return;
      }
      const unsubscribe = scans.subscribe(meta.id, (e) => {
        if ('done' in e) {
          send('done', { state: e.done.state, error: e.done.error ?? null });
          unsubscribe();
          res.end();
        } else {
          if (meta.state !== lastState) {
            lastState = meta.state;
            send('state', { state: meta.state }); // only on transitions
          }
          send('progress', e);
        }
      });
      const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
      req.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
      });
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // Body-parser errors (oversized / malformed JSON) and anything unexpected.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status;
    if (status === 413) {
      res.status(413).json({ error: 'request body too large' });
      return;
    }
    if (status === 400) {
      res.status(400).json({ error: 'malformed JSON body' });
      return;
    }
    log(`unhandled error: ${String(err).slice(0, 200)}`);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

function sendJobError(res: Response, err: unknown, log: (m: string) => void): void {
  if (err instanceof QueueFullError) {
    res.status(503).json({ error: 'scanner busy; try again later' });
    return;
  }
  if (err instanceof JobTimeoutError) {
    res.status(504).json({ error: 'job timed out' });
    return;
  }
  log(`job failed: ${String(err).slice(0, 200)}`);
  res.status(500).json({ error: 'job failed' });
}
