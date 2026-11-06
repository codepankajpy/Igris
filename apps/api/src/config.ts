/**
 * API configuration from the environment. Every limit has a conservative
 * default; nothing here can disable the egress policy (hosted scans are
 * ALWAYS public-only — see app.ts).
 */
export interface ApiConfig {
  port: number;
  /** Exact origins allowed by CORS. Never "*". */
  allowedOrigins: string[];
  /** Concurrent scans/repo jobs (each scan is a Chromium). */
  concurrency: number;
  /** Jobs allowed to wait; beyond this → 503. */
  maxQueued: number;
  /** Hard per-job timeout, ms. */
  jobTimeoutMs: number;
  /** Requests per client per window on job endpoints. */
  rateLimitMax: number;
  rateLimitWindowMs: number;
  /** Use the first X-Forwarded-For hop as client identity (only behind a trusted proxy). */
  trustProxy: boolean;
  /** Ports a scan target (and its subresources) may use. */
  allowedPorts: number[];
  repo: {
    maxBytes: number;
    maxFiles: number;
    maxSourceFileBytes: number;
    cloneTimeoutMs: number;
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
  const origins = (env.IGRIS_ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
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
    rateLimitWindowMs: int(env, 'IGRIS_RATE_LIMIT_WINDOW_MS', 60_000, 1_000, 3_600_000),
    trustProxy: env.IGRIS_TRUST_PROXY === '1',
    allowedPorts: ports,
    repo: {
      maxBytes: int(env, 'IGRIS_REPO_MAX_BYTES', 50 * 1024 * 1024, 1024, 1024 ** 3),
      maxFiles: int(env, 'IGRIS_REPO_MAX_FILES', 20_000, 1, 1_000_000),
      maxSourceFileBytes: int(
        env,
        'IGRIS_REPO_MAX_SOURCE_FILE_BYTES',
        1024 * 1024,
        1024,
        64 * 1024 ** 2,
      ),
      cloneTimeoutMs: int(env, 'IGRIS_CLONE_TIMEOUT_MS', 30_000, 1_000, 300_000),
    },
  };
}
