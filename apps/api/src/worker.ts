/**
 * The request worker (docs/design/SCAN-NETWORK.md): this node fulfils open
 * scan requests (igris.request.v1) that anyone created.
 *
 * Every IGRIS_WORKER_POLL_MS it reads the requests of the last
 * IGRIS_REQUEST_WINDOW_S seconds and, for each one, oldest first:
 *  - skips it when this node already has a job for it (running, or attempted
 *    once already — a failed publish is retried by hand, never re-scanned);
 *  - ignores it when its creator is in IGRIS_BLOCKED_REQUESTERS;
 *  - ignores it when its hostname / URL fail the exact validation of
 *    POST /api/sites/:hostname/scans (a request is untrusted input from
 *    anyone; the scan itself is still forced to public-only egress);
 *  - defers it when its creator already had IGRIS_REQUESTS_PER_CREATOR
 *    requests fulfilled here in the last hour;
 *  - skips it when the registry already holds a scan of it signed by this
 *    node (`fulfilments(key)`);
 *  - otherwise submits it to the same job queue as the website (queue caps
 *    and the one-scan-per-hostname rule apply; a busy queue defers it), and
 *    the scan is published with `{ request: key }`.
 *
 * It never throws into the server, polls never overlap, stop() ends it
 * cleanly, and every decision is logged once — with the request's entity
 * key and hostname, never an address.
 */
import { isHostname, type ScanRequest, type SiteRegistry } from '@igris/registry';
import type { WorkerConfig } from './config.js';
import { ScanInProgress, ScanQueueFull, type SiteScanService } from './jobs.js';
import { errText } from './public.js';
import { scanTarget } from './validate.js';

export type WorkerDecision =
  /** A job was started for it now. */
  | 'submitted'
  /** This node's job for it is queued or running. */
  | 'running'
  /** This node already attempted it (its job finished). */
  | 'attempted'
  /** The registry holds this node's scan of it. */
  | 'fulfilled'
  | 'blocked'
  | 'invalid'
  /** Deferred: its creator is over the per-hour limit. */
  | 'rate-limited'
  /** Deferred: a scan of the hostname is in flight, or the queue is full. */
  | 'busy'
  /** Deferred: the registry or the job service failed. */
  | 'error';

export interface WorkerOptions {
  registry: SiteRegistry;
  jobs: SiteScanService;
  /** This node's publisher (the owner its scans carry). */
  self: string;
  allowedPorts: number[];
  isPublicAddress: (ip: string) => boolean;
  pollMs: number;
  windowS: number;
  perCreatorPerHour: number;
  /** Lower-cased creators whose requests are ignored. */
  blockedRequesters: readonly string[];
  /** Clock in ms (tests). */
  now?: () => number;
  log?: (m: string) => void;
}

/** IGRIS_WORKER: 1 / 0 when set; unset → on in Arkiv mode, off in local mode. */
export function workerEnabled(
  config: Pick<WorkerConfig, 'enabled'>,
  mode: 'arkiv' | 'local',
): boolean {
  return config.enabled ?? mode === 'arkiv';
}

const HOUR_MS = 3_600_000;
/** Bound on remembered final decisions (requests leave the window anyway). */
const MAX_REMEMBERED = 10_000;

export class RequestWorker {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private started = false;
  private halted = false;
  /** Final decisions (fulfilled / blocked / invalid): never looked at again. */
  private readonly decided = new Map<string, WorkerDecision>();
  /** Last logged deferral reason per request (logged once, not every poll). */
  private readonly deferred = new Map<string, string>();
  /** Fulfilment start times (ms) per lower-cased creator, last hour only. */
  private readonly perCreator = new Map<string, number[]>();
  private readonly blocked: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly o: WorkerOptions) {
    this.blocked = new Set(o.blockedRequesters.map((b) => b.toLowerCase()));
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => undefined);
  }

  get isRunning(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.halted = false;
    this.schedule(0);
  }

  /** Stop polling; resolves once a poll in progress has finished. */
  async stop(): Promise<void> {
    this.started = false;
    this.halted = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.current = this.poll()
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          this.current = null;
          if (this.started) this.schedule(this.o.pollMs);
        });
    }, ms);
    this.timer.unref();
  }

  private remember(key: string, d: WorkerDecision): void {
    this.decided.set(key, d);
    this.deferred.delete(key);
    while (this.decided.size > MAX_REMEMBERED) {
      this.decided.delete(this.decided.keys().next().value as string);
    }
  }

  private defer(r: ScanRequest, key: string, why: string): void {
    if (this.deferred.get(key) === why) return;
    this.deferred.set(key, why);
    while (this.deferred.size > MAX_REMEMBERED) {
      this.deferred.delete(this.deferred.keys().next().value as string);
    }
    this.log(`request ${r.key} (${r.hostname}): deferred — ${why}`);
  }

  private recentFor(creator: string, nowMs: number): number[] {
    const kept = (this.perCreator.get(creator) ?? []).filter((t) => nowMs - t < HOUR_MS);
    if (kept.length === 0) this.perCreator.delete(creator);
    else this.perCreator.set(creator, kept);
    return kept;
  }

  /**
   * One pass over the open requests. Never throws; returns the decision per
   * request (in registry order) for tests and diagnostics.
   */
  async poll(): Promise<Array<{ key: string; decision: WorkerDecision }>> {
    const out: Array<{ key: string; decision: WorkerDecision }> = [];
    const nowMs = this.now();
    for (const c of [...this.perCreator.keys()]) this.recentFor(c, nowMs);
    let requests: ScanRequest[];
    try {
      const since = Math.max(0, Math.floor(nowMs / 1000) - this.o.windowS);
      requests = await this.o.registry.openRequests({ since });
    } catch (err) {
      this.log(`request worker: could not read open requests (${errText(err)})`);
      return out;
    }
    let queueFull = false;
    for (const r of requests) {
      if (this.halted) break;
      let decision: WorkerDecision;
      try {
        decision = await this.decide(r, nowMs, queueFull);
      } catch (err) {
        // Registry unreachable mid-poll: try again next time.
        this.defer(r, r.key.toLowerCase(), `error: ${errText(err)}`);
        decision = 'error';
      }
      if (decision === 'busy' && !this.o.jobs.canAccept()) queueFull = true;
      out.push({ key: r.key, decision });
    }
    return out;
  }

  private async decide(r: ScanRequest, nowMs: number, queueFull: boolean): Promise<WorkerDecision> {
    const key = r.key.toLowerCase();
    const prior = this.decided.get(key);
    if (prior) return prior;

    const job = this.o.jobs.forRequest(r.key);
    if (job) return job.state === 'queued' || job.state === 'running' ? 'running' : 'attempted';

    const creator = r.creator.toLowerCase();
    if (this.blocked.has(creator)) {
      this.remember(key, 'blocked');
      this.log(`request ${r.key} (${r.hostname}): ignored — the requester is blocked`);
      return 'blocked';
    }

    // Exactly the POST route's checks: anyone can write a request.
    let target: { hostname: string; url: string };
    try {
      target = scanTarget(r.hostname, r.url, this.o.allowedPorts, this.o.isPublicAddress);
      if (!isHostname(target.hostname) || target.hostname !== r.hostname) {
        throw new Error('hostname cannot be published to the site registry');
      }
    } catch (err) {
      this.remember(key, 'invalid');
      this.log(`request ${r.key}: ignored — invalid target (${errText(err)})`);
      return 'invalid';
    }

    if (this.recentFor(creator, nowMs).length >= this.o.perCreatorPerHour) {
      this.defer(r, key, `its requester reached ${this.o.perCreatorPerHour} requests this hour`);
      return 'rate-limited';
    }
    if (queueFull) {
      this.defer(r, key, 'the scan queue is full');
      return 'busy';
    }

    const self = this.o.self.toLowerCase();
    const scans = await this.o.registry.fulfilments(r.key);
    if (scans.some((s) => s.owner.toLowerCase() === self)) {
      this.remember(key, 'fulfilled');
      this.log(`request ${r.key} (${r.hostname}): already fulfilled by this node`);
      return 'fulfilled';
    }

    try {
      const started = this.o.jobs.submit(target.hostname, target.url, { request: r.key });
      this.deferred.delete(key);
      this.perCreator.set(creator, [...this.recentFor(creator, nowMs), nowMs]);
      this.log(`request ${r.key} (${r.hostname}): scanning (job ${started.id})`);
      return 'submitted';
    } catch (err) {
      if (err instanceof ScanInProgress) {
        this.defer(r, key, 'a scan of this hostname is running');
        return 'busy';
      }
      if (err instanceof ScanQueueFull) {
        this.defer(r, key, 'the scan queue is full');
        return 'busy';
      }
      throw err;
    }
  }
}
