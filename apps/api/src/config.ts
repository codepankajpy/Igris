/**
 * API configuration from the environment. Every limit has a conservative
 * default; nothing here can disable the egress policy (scans are ALWAYS
 * public-only — see jobs.ts).
 *
 * Registry configuration (IGRIS_REGISTRY, ARKIV_*, IGRIS_SCANNER,
 * IGRIS_TRUSTED_SCANNERS) is read by registry.ts.
 *
 * IGRIS_CHROMIUM_SANDBOX  "1" runs each scan's Chromium inside its own OS
 *                         sandbox (the host must allow it: docker run
 *                         --cap-add=SYS_ADMIN or a Chrome seccomp profile);
 *                         "0" or unset: off. When on and the sandbox cannot
 *                         start, scans fail rather than run unsandboxed.
 *
 * The website (static.ts):
 *   IGRIS_STATIC_DIR  directory of the built website (apps/app/dist) served
 *                     at / from this same origin. Default: apps/app/dist of
 *                     this checkout when it has been built, else none.
 *                     "off" disables it; any other value must hold an
 *                     index.html.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  /** Built website served at / (same origin); null = API only. */
  staticDir: string | null;
  /** IGRIS_CHROMIUM_SANDBOX: run Chromium inside its own OS sandbox (default false). */
  chromiumSandbox: boolean;
}

function chromiumSandbox(env: NodeJS.ProcessEnv): boolean {
  const raw = env.IGRIS_CHROMIUM_SANDBOX?.trim();
  if (raw === undefined || raw === '' || raw === '0') return false;
  if (raw === '1') return true;
  throw new Error(`IGRIS_CHROMIUM_SANDBOX must be 1 or 0 (got "${raw}")`);
}

/** apps/app/dist, from apps/api/src or apps/api/dist alike. */
export const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../app/dist', import.meta.url));

function staticDir(env: NodeJS.ProcessEnv): string | null {
  const raw = env.IGRIS_STATIC_DIR?.trim();
  if (raw === undefined || raw === '') {
    return existsSync(join(DEFAULT_STATIC_DIR, 'index.html')) ? DEFAULT_STATIC_DIR : null;
  }
  if (raw === 'off') return null;
  const dir = resolve(raw);
  if (!existsSync(join(dir, 'index.html'))) {
    throw new Error(`IGRIS_STATIC_DIR: ${dir} has no index.html (build apps/app, or set "off")`);
  }
  return dir;
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
  const origins = (env.IGRIS_ALLOWED_ORIGINS || 'http://localhost:5180,http://127.0.0.1:5180')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  for (const o of origins) {
    if (o === '*' || !/^https?:\/\/[^/]+$/.test(o)) {
      throw new Error(`IGRIS_ALLOWED_ORIGINS: "${o}" must be an exact origin (no "*", no path)`);
    }
  }
  const ports = (env.IGRIS_ALLOWED_PORTS || '80,443').split(',').map((p) => Number(p.trim()));
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
    dataDir: resolve(env.IGRIS_DATA_DIR || '.igris-data'),
    staticDir: staticDir(env),
    chromiumSandbox: chromiumSandbox(env),
  };
}
