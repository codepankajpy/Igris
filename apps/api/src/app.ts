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
import type { Report } from '@igris/core';
import type { ScanOptions } from '@igris/scanner';
import type { ScanRecord } from '@igris/registry';
import type { ApiConfig } from './config.js';
import { JobQueue, JobTimeoutError, QueueFullError, RateLimiter } from './limits.js';
import { RepoRejectedError, cloneRepo, enforceRepoLimits, validateRepoUrl } from './repo.js';

export interface FixResultLike {
  diff: string;
  changedFiles: string[];
  notes: Array<{ file: string; line: number; message: string }>;
}

/** Side-effectful collaborators, injected so the HTTP layer is testable. */
export interface ApiDeps {
  scan: (options: ScanOptions) => Promise<Report>;
  fix: (options: { targetDir: string }) => FixResultLike;
  recordFromReport: (report: Report, json: string) => ScanRecord;
  isPublicAddress: (ip: string) => boolean;
  /** Clone step (default: hardened git clone). */
  clone?: typeof cloneRepo;
  log?: (msg: string) => void;
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
      const report = await queue.run((signal) =>
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
        preview = deps.recordFromReport(report, JSON.stringify(report));
      } catch {
        preview = null;
      }
      log(`scan finished: status=${report.status} score=${report.score ?? 'none'}`);
      res.json({ provenance: 'unpublished', report, preview });
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
