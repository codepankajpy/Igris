/**
 * API configuration from the environment. Every limit has a conservative
 * default; nothing here can disable the egress policy (scans are ALWAYS
 * public-only — see jobs.ts).
 *
 * Registry configuration (IGRIS_REGISTRY, ARKIV_*, IGRIS_SCANNER,
 * IGRIS_TRUSTED_SCANNERS) is read by registry.ts.
 *
 * The request worker (docs/design/SCAN-NETWORK.md, worker.ts):
 *   IGRIS_WORKER               1 | 0 (default: on in Arkiv mode, off in local mode)
 *   IGRIS_WORKER_POLL_MS       poll interval, ms (default 15000)
 *   IGRIS_REQUEST_WINDOW_S     how far back requests are read, s (default 3600)
 *   IGRIS_REQUESTS_PER_CREATOR requests fulfilled per creator per hour (default 5)
 *   IGRIS_BLOCKED_REQUESTERS   comma-separated creators whose requests are ignored
 */
import { resolve } from 'node:path';

export interface ApiConfig {
  port: number;
  /** Exact origins allowed by CORS. Never "*". */
  allowedOrigins: string[];
  /** Concurrent scans (each scan is a Chromium). */
  concurrency: number;
  /** Scans allowed to wait; beyond this → 503. */
  maxQueued: number;
  /** Hard per-scan timeout, ms. */
  jobTimeoutMs: number;
  /** Requests per client per window on the POST endpoints. */
  rateLimitMax: number;
  /** Requests per client per window on the expensive reads (verified report loads). */
  readRateLimitMax: number;
  rateLimitWindowMs: number;
  /**
   * Number of reverse-proxy hops in front of the API (IGRIS_TRUST_PROXY, 0 =
   * none). Passed to Express's 'trust proxy', so the client identity is the
   * address that many hops from the RIGHT of X-Forwarded-For — the one the
   * nearest trusted proxy saw — never the client-controlled first entry.
   */
  trustProxy: number;
  /** Ports a scan target (and its subresources) may use. */
  allowedPorts: number[];
  /** Dwell time per scan phase, ms. */
  dwellMs: number;
  /** Job metadata and the local cache of finished scans live here. */
  dataDir: string;
  worker: WorkerConfig;
}

export interface WorkerConfig {
  /** IGRIS_WORKER; null = not set (on in Arkiv mode, off in local mode). */
  enabled: boolean | null;
  pollMs: number;
  windowS: number;
  perCreatorPerHour: number;
  /** Creators (addresses, or local labels) whose requests are ignored; lower-cased. */
  blockedRequesters: string[];
}

const REQUESTER_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

function workerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const raw = env.IGRIS_WORKER?.trim();
  if (raw !== undefined && raw !== '' && raw !== '0' && raw !== '1') {
    throw new Error(`IGRIS_WORKER must be 1 or 0 (got "${raw}")`);
  }
  const blocked = (env.IGRIS_BLOCKED_REQUESTERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const b of blocked) {
    if (!REQUESTER_RE.test(b)) {
      throw new Error('IGRIS_BLOCKED_REQUESTERS must be a comma-separated list of addresses');
    }
  }
  return {
    enabled: raw === undefined || raw === '' ? null : raw === '1',
    pollMs: int(env, 'IGRIS_WORKER_POLL_MS', 15_000, 1_000, 3_600_000),
    windowS: int(env, 'IGRIS_REQUEST_WINDOW_S', 3600, 60, 7 * 86_400),
    perCreatorPerHour: int(env, 'IGRIS_REQUESTS_PER_CREATOR', 5, 1, 1000),
    blockedRequesters: blocked.map((b) => b.toLowerCase()),
  };
}

function int(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be an integer in [${min}, ${max}] (got "${raw}")`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const origins = (env.IGRIS_ALLOWED_ORIGINS ?? 'http://localhost:5180,http://127.0.0.1:5180')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  for (const o of origins) {
    if (o === '*' || !/^https?:\/\/[^/]+$/.test(o)) {
      throw new Error(`IGRIS_ALLOWED_ORIGINS: "${o}" must be an exact origin (no "*", no path)`);
    }
  }
  const ports = (env.IGRIS_ALLOWED_PORTS ?? '80,443').split(',').map((p) => Number(p.trim()));
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error('IGRIS_ALLOWED_PORTS must be a comma-separated list of ports');
  }
  return {
    port: int(env, 'PORT', 3001, 1, 65535),
    allowedOrigins: origins,
    concurrency: int(env, 'IGRIS_CONCURRENCY', 1, 1, 8),
    maxQueued: int(env, 'IGRIS_MAX_QUEUED', 4, 0, 100),
    jobTimeoutMs: int(env, 'IGRIS_JOB_TIMEOUT_MS', 120_000, 5_000, 600_000),
    rateLimitMax: int(env, 'IGRIS_RATE_LIMIT_MAX', 5, 1, 1000),
    readRateLimitMax: int(env, 'IGRIS_READ_RATE_LIMIT_MAX', 120, 1, 100_000),
    rateLimitWindowMs: int(env, 'IGRIS_RATE_LIMIT_WINDOW_MS', 60_000, 1_000, 3_600_000),
    trustProxy: int(env, 'IGRIS_TRUST_PROXY', 0, 0, 10),
    allowedPorts: ports,
    dwellMs: int(env, 'IGRIS_DWELL_MS', 4000, 1000, 20_000),
    dataDir: resolve(env.IGRIS_DATA_DIR ?? '.igris-data'),
    worker: workerConfig(env),
  };
}
