/**
 * Abuse controls: a bounded job queue with hard timeouts, and a per-client
 * rate limiter. Dependency-free and deterministic under test (injectable
 * clock).
 */
import { createHash, randomBytes } from 'node:crypto';

export class QueueFullError extends Error {
  constructor() {
    super('queue full');
    this.name = 'QueueFullError';
  }
}

export class JobTimeoutError extends Error {
  constructor(ms: number) {
    super(`job exceeded ${ms} ms`);
    this.name = 'JobTimeoutError';
  }
}

type Job<T> = (signal: AbortSignal) => Promise<T>;

/**
 * At most `concurrency` jobs run; at most `maxQueued` wait; anything beyond
 * is rejected immediately with QueueFullError (→ HTTP 503). Every job gets an
 * AbortSignal that fires at `timeoutMs`; the job's promise is rejected with
 * JobTimeoutError at that moment even if the job ignores the signal, and its
 * slot is held until it actually settles (so a stuck job cannot be used to
 * exceed the concurrency cap).
 */
export class JobQueue {
  private running = 0;
  private waiting: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxQueued: number,
    private readonly timeoutMs: number,
  ) {}

  get stats() {
    return { running: this.running, queued: this.waiting.length };
  }

  /** Would run() accept a job right now? (synchronous capacity check) */
  canAccept(): boolean {
    return this.running < this.concurrency || this.waiting.length < this.maxQueued;
  }

  run<T>(job: Job<T>): Promise<T> {
    if (this.running >= this.concurrency && this.waiting.length >= this.maxQueued) {
      return Promise.reject(new QueueFullError());
    }
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running += 1;
        const controller = new AbortController();
        let settled = false;
        const timer = setTimeout(() => {
          controller.abort();
          if (!settled) {
            settled = true;
            reject(new JobTimeoutError(this.timeoutMs));
          }
        }, this.timeoutMs);
        job(controller.signal)
          .then(
            (v) => {
              if (!settled) {
                settled = true;
                resolve(v);
              }
            },
            (e: unknown) => {
              if (!settled) {
                settled = true;
                reject(e);
              }
            },
          )
          .finally(() => {
            clearTimeout(timer);
            this.running -= 1;
            this.waiting.shift()?.();
          });
      };
      if (this.running < this.concurrency) start();
      else this.waiting.push(start);
    });
  }
}

/**
 * Fixed-window rate limiter keyed by client identity. Client IPs are hashed
 * with a per-process random salt and never stored or logged in clear (the
 * hosted node must not keep identifying logs — ROADMAP P4-2).
 */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  private readonly salt = randomBytes(16);

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private key(client: string): string {
    return createHash('sha256').update(this.salt).update(client).digest('hex');
  }

  /** true if allowed (and counted), false if over the limit. */
  take(client: string): boolean {
    const k = this.key(client);
    const t = this.now();
    const w = this.windows.get(k);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(k, { start: t, count: 1 });
      this.sweep(t);
      return true;
    }
    if (w.count >= this.max) return false;
    w.count += 1;
    return true;
  }

  private sweep(t: number): void {
    if (this.windows.size < 10_000) return;
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}
