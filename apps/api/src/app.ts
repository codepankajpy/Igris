/**
 * IGRIS backend — the one flow (docs/design/FLOW.md):
 *
 *   search a site → show its published versions → scan / retest → the scan
 *   is cached locally and published to the site registry (Arkiv) as the
 *   hostname's next version → any version is served back verified.
 *
 * The backend makes every judgement (summary, verdicts, changes between
 * versions); the website only displays. Scans always run with egress forced
 * to public-only. No client identity is logged or stored.
 *
 * Scan network (docs/design/SCAN-NETWORK.md): a scan started here is also an
 * open request (igris.request.v1) any trusted node may fulfil; a site's
 * versions are grouped into rounds (one request and the scans that fulfilled
 * it) and the API compares the nodes of a round per recipient. Nodes are
 * "Scanner n"; no response carries a signer address outside report and
 * evidence payloads (public.ts).
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import {
  bundleHash,
  contentHash,
  summarise,
  validateReport,
  verifyReportIntegrity,
  type EvidenceBundle,
  type ReportV3,
  type WalletRequestKind,
} from '@igris/core';
import {
  ARKIV_KEY_RE,
  LOCAL_KEY_RE,
  PUBLISHED_WALLET_REQUEST_KINDS,
  RABDI_EXPLORER_URL,
  isHostname,
  requestUrlProblem,
  type Changes,
  type PublishedScan,
  type ScanRequest,
  type SiteRegistry,
} from '@igris/registry';
import { compareRound, type Agreement, type NodeReport } from './agreement.js';
import { readCachedScan, type CachedScan } from './artifacts.js';
import type { ApiConfig } from './config.js';
import {
  PublishConflict,
  ScanInProgress,
  ScanQueueFull,
  doneOf,
  isJobId,
  type Job,
  type SiteScanService,
} from './jobs.js';
import { RateLimiter } from './limits.js';
import { websiteHandler } from './static.js';
import { NodeLabels } from './nodes.js';
import {
  errText,
  publicFlow,
  publicRequest,
  publicScan,
  publicWalletRequest,
  type PublicRequest,
} from './public.js';
import type { RegistryInfo } from './registry.js';
import { BadRequest, limitParam, positiveInt, scanTarget, validateHostname } from './validate.js';

export interface ApiDeps {
  registry: SiteRegistry;
  registryInfo: RegistryInfo;
  jobs: SiteScanService;
  isPublicAddress: (ip: string) => boolean;
  diffVersions: (prev: ReportV3, next: ReportV3) => Changes;
  log?: (msg: string) => void;
  /** Live registry probe for GET /api/registry (defaults: 5 s timeout, 30 s cache). */
  probe?: { timeoutMs?: number; ttlMs?: number; now?: () => number };
  /** Scan-request cache: how long a "no such request" is remembered (default 10 min). */
  requestCache?: { nullTtlMs?: number; now?: () => number };
}

/** Verified registry loads kept in memory (published content is immutable). */
export const VERIFIED_CACHE_ENTRIES = 64;
/** Scan requests kept in memory (readonly entities: their content never changes). */
export const REQUEST_CACHE_ENTRIES = 512;
/** Request lookups in flight at once while building a site's rounds. */
const REQUEST_LOOKUP_CONCURRENCY = 8;
/**
 * GET /api/sites/:hostname looks up the requests of the newest this-many
 * versions only (rounds of older versions show request null): one site read
 * costs at most this many registry reads, however long its history.
 */
export const ROUND_REQUEST_VERSIONS = 50;
/** How long a request lookup that found nothing is remembered. */
export const REQUEST_NULL_TTL_MS = 10 * 60_000;

/** One round of a site (light): a request and the scans that fulfilled it. */
export interface RoundSummary {
  /** null for a scan made without a request, or a request no longer on the registry. */
  request: PublicRequest | null;
  /** Newest first. */
  scans: Array<{ version: number; key: string; node: string }>;
}
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_TTL_MS = 30_000;

type Probe = () => Promise<{ ready: boolean; reason?: string }>;

/** The backend's own readiness probe (ArkivSiteRegistry / LocalSiteRegistry `status()`), if it has one. */
function probeOf(registry: SiteRegistry): Probe | null {
  const status = (registry as { status?: unknown }).status;
  return typeof status === 'function'
    ? () => (status as Probe).call(registry) as ReturnType<Probe>
    : null;
}

/** A tiny LRU: Map iteration order is insertion order; a hit re-inserts. */
export class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  get size(): number {
    return this.map.size;
  }
}

interface Loaded {
  report: ReportV3;
  bundle: EvidenceBundle;
  verified: boolean;
  problems: string[];
  source: 'arkiv' | 'local';
}

class RegistryUnavailable extends Error {}

/**
 * Rate-limit identity. With IGRIS_TRUST_PROXY=n Express's 'trust proxy' is
 * set to n hops, so req.ip is the address n hops from the right of
 * X-Forwarded-For (what our own proxy saw), never the client-written first
 * entry; with 0 it is the socket's peer.
 */
function clientId(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** A path parameter as a string ('' when absent or not a plain string). */
function param(req: Request, name: string): string {
  const v = (req.params as Record<string, unknown>)[name];
  return typeof v === 'string' ? v : '';
}

/**
 * Re-verify a cached scan — schema, integrity and hashes — against what it
 * must be: a published entity's scanId/evidenceSha256 (the cache is only
 * served for a version when it IS that version's content), or, for a scan
 * not (yet) published, its own cache key and report.evidence.sha256.
 *
 * A draft 3.0.0 scan was verified on its stored files by readCachedScan
 * (its report hash against the cache key = scanId) and is shown upgraded,
 * which hashes differently by design: only its stored evidence hash is
 * compared here, and its problems (incl. the draft note) are kept.
 */
function verifyCached(
  expected: { scanId: string; evidenceSha256: string },
  cached: CachedScan,
): string[] {
  const { report, bundle } = cached;
  if (cached.draft) {
    const problems = [...cached.problems];
    if (cached.draft.evidenceSha256 !== expected.evidenceSha256)
      problems.push('evidence hash does not match evidenceSha256');
    return problems;
  }
  const problems: string[] = [];
  try {
    validateReport(report);
  } catch (err) {
    problems.push(`schema: ${errText(err)}`);
  }
  if (contentHash(report) !== expected.scanId) problems.push('report hash does not match scanId');
  const b = bundleHash(bundle);
  if (b !== expected.evidenceSha256) problems.push('evidence hash does not match evidenceSha256');
  if (report.evidence.sha256 !== expected.evidenceSha256)
    problems.push('report.evidence.sha256 does not match evidenceSha256');
  problems.push(...verifyReportIntegrity(report, bundle).problems);
  return problems;
}

/** Max ?limit= of GET /api/wallet-requests (the registries return at most 100). */
export const WALLET_REQUESTS_MAX_LIMIT = 100;

/**
 * GET /api/wallet-requests filters, validated: kind ∈ the published kinds,
 * unlimited ∈ true|false, hostname a publishable DNS name, limit in
 * [1, 100] (default 50). Absent or empty → no filter. BadRequest otherwise.
 */
export function walletRequestFilters(query: Record<string, unknown>): {
  kind?: WalletRequestKind;
  unlimited?: boolean;
  hostname?: string;
  limit: number;
} {
  const given = (name: string): string | undefined => {
    const v = query[name];
    if (v === undefined || v === '') return undefined;
    if (typeof v !== 'string') throw new BadRequest(`${name} must be given once`);
    return v;
  };
  const out: { kind?: WalletRequestKind; unlimited?: boolean; hostname?: string; limit: number } = {
    limit: limitParam(query.limit, 50, WALLET_REQUESTS_MAX_LIMIT),
  };
  const kind = given('kind');
  if (kind !== undefined) {
    if (!(PUBLISHED_WALLET_REQUEST_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequest(`kind must be one of ${PUBLISHED_WALLET_REQUEST_KINDS.join(', ')}`);
    }
    out.kind = kind as WalletRequestKind;
  }
  const unlimited = given('unlimited');
  if (unlimited !== undefined) {
    if (unlimited !== 'true' && unlimited !== 'false') {
      throw new BadRequest('unlimited must be true or false');
    }
    out.unlimited = unlimited === 'true';
  }
  const hostname = given('hostname');
  if (hostname !== undefined) {
    const h = validateHostname(hostname);
    if (!isHostname(h)) throw new BadRequest('hostname is longer than the registry stores');
    out.hostname = h;
  }
  return out;
}

export function createApp(config: ApiConfig, deps: ApiDeps): express.Express {
  const log = deps.log ?? ((m: string) => console.log(`[igris-api] ${m}`));
  const { registry, registryInfo, jobs } = deps;
  const limiter = new RateLimiter(config.rateLimitMax, config.rateLimitWindowMs);
  const readLimiter = new RateLimiter(config.readRateLimitMax, config.rateLimitWindowMs);
  const verifiedLoads = new Lru<Loaded>(VERIFIED_CACHE_ENTRIES);
  /** Hits forever (requests are readonly); misses ("null") for nullTtlMs. */
  const requests = new Lru<{ request: ScanRequest | null; at: number }>(REQUEST_CACHE_ENTRIES);
  const requestNullTtlMs = deps.requestCache?.nullTtlMs ?? REQUEST_NULL_TTL_MS;
  const requestNow = deps.requestCache?.now ?? Date.now;
  const nodes = new NodeLabels(registryInfo.publisher, registryInfo.trustedOwners);
  const requestKeyRe = registry.mode === 'arkiv' ? ARKIV_KEY_RE : LOCAL_KEY_RE;

  const app = express();
  app.disable('x-powered-by');
  // A hop count, never `true`: `true` would trust whatever the client wrote first.
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);
  app.use(
    cors({
      origin: (origin, cb) =>
        cb(null, origin !== undefined && config.allowedOrigins.includes(origin)),
      methods: ['GET', 'POST'],
    }),
  );
  app.use(express.json({ limit: '16kb' }));

  const limitedBy = (l: RateLimiter) => (req: Request, res: Response, next: NextFunction) => {
    if (!l.take(clientId(req))) {
      res.status(429).json({ error: 'rate limit exceeded; try again later' });
      return;
    }
    next();
  };
  /** POST endpoints (scans, publishes). */
  const rateLimited = limitedBy(limiter);
  /** Expensive reads (registry fetch + full re-verification). */
  const readLimited = limitedBy(readLimiter);

  /** Wrap an async handler: BadRequest → 400, registry failure → 502. */
  const handle =
    (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
      fn(req, res).catch((err: unknown) => {
        if (res.headersSent) return;
        if (err instanceof BadRequest) {
          res.status(400).json({ error: err.message });
          return;
        }
        log(`registry error on ${req.method} ${req.route?.path ?? ''}: ${errText(err)}`);
        res.status(502).json({ error: `registry unavailable: ${errText(err)}` });
      });
    };

  /**
   * Load a version's report + evidence: the registry first, the cache as
   * fallback. Verified registry loads are kept in an LRU keyed by the entity
   * (key + the hashes it attests to): an entity's content never changes.
   */
  async function loadVersion(scan: PublishedScan): Promise<Loaded> {
    const memo = `${scan.key}|${scan.scanId}|${scan.evidenceSha256}`;
    const hit = verifiedLoads.get(memo);
    if (hit) return hit;
    try {
      const l = await registry.load(scan);
      const loaded: Loaded = {
        report: l.report,
        bundle: l.bundle,
        verified: l.verified,
        problems: l.problems,
        source: registry.mode,
      };
      if (loaded.verified && loaded.problems.length === 0) verifiedLoads.set(memo, loaded);
      return loaded;
    } catch (err) {
      const cached = readCachedScan(config.dataDir, scan.scanId);
      if (!cached) throw new RegistryUnavailable(errText(err));
      const problems = verifyCached(scan, cached);
      return {
        report: cached.report,
        bundle: cached.bundle,
        verified: problems.length === 0,
        problems: [
          `served from this server's local cache: the ${registry.mode} registry copy could not be loaded (${errText(err)})`,
          ...problems,
        ],
        source: 'local',
      };
    }
  }

  /** Diff against the verified previous version `scan.previous` points at, or why not. */
  async function changesSincePrevious(
    scan: PublishedScan,
    report: ReportV3,
  ): Promise<{ changes: Changes } | { why: string }> {
    if (scan.previous === null) return { why: 'this version does not link to a previous one' };
    try {
      const prev = await registry.byKey(scan.previous);
      if (!prev) return { why: `entity ${scan.previous} was not found` };
      // One version sequence per site across all trusted scanners
      // (SCAN-NETWORK.md): v{n−1} may be another trusted node's — byKey only
      // returns trusted entities — but it must be this hostname's v{n−1}.
      if (prev.hostname !== scan.hostname || prev.version !== scan.version - 1) {
        return {
          why: `entity ${scan.previous} is not ${scan.hostname} v${scan.version - 1}`,
        };
      }
      const loaded = await loadVersion(prev);
      if (!loaded.verified) return { why: loaded.problems.join('; ') || 'verification failed' };
      return { changes: deps.diffVersions(loaded.report, report) };
    } catch (err) {
      return { why: errText(err) };
    }
  }

  /**
   * A scan request by key, null when absent. Cached: a request found is
   * kept (requests are readonly), a request not found is remembered for
   * requestNullTtlMs (so a site page full of expired requests does not
   * re-ask the registry on every read). Registry errors are not cached.
   */
  async function getRequest(key: string): Promise<ScanRequest | null> {
    const memo = key.toLowerCase();
    const hit = requests.get(memo);
    if (hit && (hit.request !== null || requestNow() - hit.at < requestNullTtlMs)) {
      return hit.request;
    }
    const r = await registry.request(key);
    requests.set(memo, { request: r, at: requestNow() });
    return r;
  }

  /** getRequest, but a failing lookup is logged and reads as null (never fails the route). */
  async function getRequestOrNull(key: string): Promise<ScanRequest | null> {
    try {
      return await getRequest(key);
    } catch (err) {
      log(`request ${key} could not be read (${errText(err)})`);
      return null;
    }
  }

  /**
   * A site's versions (newest first) grouped into rounds: scans sharing a
   * request key form one round, a scan without a request is a round of one.
   * Rounds are ordered by their newest scan.
   */
  async function roundsOf(hostname: string, versions: PublishedScan[]): Promise<RoundSummary[]> {
    const groups = new Map<string, PublishedScan[]>();
    const rounds: Array<{ key: string | null; scans: PublishedScan[] }> = [];
    for (const v of versions) {
      if (v.request === null) {
        rounds.push({ key: null, scans: [v] });
        continue;
      }
      const k = v.request.toLowerCase();
      let g = groups.get(k);
      if (!g) {
        g = [];
        groups.set(k, g);
        rounds.push({ key: v.request, scans: g });
      }
      g.push(v);
    }
    // Only the requests of the newest ROUND_REQUEST_VERSIONS versions are
    // looked up (distinct keys); a failing lookup is request null.
    const keys = [
      ...new Set(
        versions
          .slice(0, ROUND_REQUEST_VERSIONS)
          .flatMap((v) => (v.request === null ? [] : [v.request.toLowerCase()])),
      ),
    ];
    const found = new Map<string, ScanRequest | null>();
    for (let i = 0; i < keys.length; i += REQUEST_LOOKUP_CONCURRENCY) {
      const batch = keys.slice(i, i + REQUEST_LOOKUP_CONCURRENCY);
      const got = await Promise.all(batch.map((k) => getRequestOrNull(k)));
      // A request for another hostname is not this site's round.
      batch.forEach((k, j) => found.set(k, got[j]?.hostname === hostname ? got[j]! : null));
    }
    return rounds.map((r) => {
      const req = r.key === null ? null : (found.get(r.key.toLowerCase()) ?? null);
      return {
        request: req ? publicRequest(req) : null,
        scans: r.scans.map((s) => ({ version: s.version, key: s.key, node: nodes.label(s.owner) })),
      };
    });
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Live readiness: in Arkiv mode the configured info (key loaded?) is merged
  // with a probe of the node. One probe at a time, bounded by a timeout, and
  // its result reused for ttl — this route cannot be used to hammer the node.
  const probe = registry.mode === 'arkiv' ? probeOf(registry) : null;
  const probeTimeoutMs = deps.probe?.timeoutMs ?? PROBE_TIMEOUT_MS;
  const probeTtlMs = deps.probe?.ttlMs ?? PROBE_TTL_MS;
  const now = deps.probe?.now ?? Date.now;
  let probed: { at: number; value: { ready: boolean; reason?: string } } | null = null;
  let probing: Promise<{ ready: boolean; reason?: string }> | null = null;

  async function liveStatus(p: Probe): Promise<{ ready: boolean; reason?: string }> {
    if (probed && now() - probed.at < probeTtlMs) return probed.value;
    probing ??= (async () => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<{ ready: boolean; reason: string }>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              ready: false,
              reason: `the Arkiv node did not answer within ${probeTimeoutMs} ms`,
            }),
          probeTimeoutMs,
        );
        timer.unref();
      });
      try {
        const value = await Promise.race([
          p().catch((err: unknown) => ({ ready: false, reason: errText(err) })),
          timeout,
        ]);
        probed = { at: now(), value };
        return value;
      } finally {
        clearTimeout(timer);
        probing = null;
      }
    })();
    return probing;
  }

  app.get(
    '/api/registry',
    handle(async (_req, res) => {
      // Public view: no publisher or trusted-owner addresses (they are on
      // Arkiv for anyone who looks; the website does not advertise them).
      const view = (ready: boolean, reason: string | undefined) => ({
        mode: registryInfo.mode,
        network: registryInfo.network,
        explorer: registryInfo.mode === 'arkiv' ? RABDI_EXPLORER_URL : null,
        publishing: registryInfo.publisher !== null,
        ready,
        ...(reason !== undefined ? { reason } : {}),
      });
      if (!probe) {
        res.json(view(registryInfo.ready, registryInfo.reason));
        return;
      }
      const live = await liveStatus(probe);
      const ready = registryInfo.ready && live.ready;
      const reason = registryInfo.reason ?? (live.ready ? undefined : live.reason);
      res.json(view(ready, reason));
    }),
  );

  app.get(
    '/api/sites',
    handle(async (req, res) => {
      const limit = limitParam(req.query.limit, 20, 100);
      res.json({ sites: (await registry.recentSites({ limit })).map(publicScan) });
    }),
  );

  app.get(
    '/api/sites/:hostname',
    readLimited,
    handle(async (req, res) => {
      const hostname = validateHostname(param(req, 'hostname'));
      const versions = await registry.versions(hostname);
      const rounds = await roundsOf(hostname, versions);
      const job = jobs.inFlight(hostname);
      res.json({
        hostname,
        versions: versions.map(publicScan),
        scanning: job ? { id: job.id, state: job.state } : null,
        rounds,
      });
    }),
  );

  app.get(
    '/api/sites/:hostname/versions/:n',
    readLimited,
    handle(async (req, res) => {
      const hostname = validateHostname(param(req, 'hostname'));
      const n = positiveInt(param(req, 'n'), 'version');
      const scan = await registry.version(hostname, n);
      if (!scan) {
        res.status(404).json({ error: `${hostname} has no version ${n}` });
        return;
      }
      let current: Loaded;
      try {
        current = await loadVersion(scan);
      } catch (err) {
        res.status(502).json({ error: `version ${n} could not be loaded: ${errText(err)}` });
        return;
      }
      // Changes are computed only against the VERIFIED entity this version
      // links to (scan.previous), never against "whatever is numbered n − 1".
      const problems = [...current.problems];
      let changes: Changes | null = null;
      if (n > 1) {
        const c = await changesSincePrevious(scan, current.report);
        if ('changes' in c) changes = c.changes;
        else {
          log(`changes for ${hostname} v${n}: previous version not verified (${c.why})`);
          problems.push(
            `changes not shown: previous version v${n - 1} could not be verified: ${c.why}`,
          );
        }
      }
      res.json({
        scan: publicScan(scan),
        report: current.report,
        evidence: current.bundle,
        verified: current.verified,
        problems,
        // The backend's own descriptive summary; the website never computes one.
        summary: summarise(current.report, current.bundle),
        changes,
        source: current.source,
        node: nodes.label(scan.owner),
      });
    }),
  );

  // One round: each scan loaded and verified, and the agreement between the
  // nodes (per recipient) when ≥ 2 nodes have a verified scan in it.
  app.get(
    '/api/sites/:hostname/rounds/:requestKey',
    readLimited,
    handle(async (req, res) => {
      const hostname = validateHostname(param(req, 'hostname'));
      const key = param(req, 'requestKey');
      if (!requestKeyRe.test(key)) throw new BadRequest('requestKey is not a scan request key');
      // The request entity may have expired (7 days unless extended) while
      // trusted scans still reference it: the round is shown with request
      // null. 404 only when no trusted scan of this site references the key
      // and no live request of this site has it.
      const [found, all] = await Promise.all([getRequestOrNull(key), registry.fulfilments(key)]);
      const request = found && found.hostname === hostname ? found : null;
      const fulfilled = all.filter((s) => s.hostname === hostname);
      if (!request && fulfilled.length === 0) {
        res.status(404).json({
          error: `${hostname} has no scan request ${key} on the registry (requests expire after 7 days unless extended)`,
        });
        return;
      }
      const loaded = await Promise.all(
        fulfilled.map(async (scan) => {
          try {
            return await loadVersion(scan);
          } catch (err) {
            log(`round ${key}: v${scan.version} could not be loaded (${errText(err)})`);
            return null;
          }
        }),
      );
      const scans = fulfilled.map((scan, i) => ({
        scan,
        node: nodes.label(scan.owner),
        verified: loaded[i]?.verified === true,
        report: loaded[i]?.report ?? null,
      }));
      // One report per node: its newest verified scan of the round (scans are newest first).
      const perNode = new Map<string, NodeReport>();
      for (const s of scans) {
        if (s.verified && s.report && !perNode.has(s.node)) {
          perNode.set(s.node, { node: s.node, report: s.report });
        }
      }
      const agreement: Agreement | null = compareRound(
        [...perNode.values()].sort((a, b) => nodes.rank(a.node) - nodes.rank(b.node)),
      );
      res.json({
        request: request ? publicRequest(request) : null,
        scans: scans.map((s) => ({ scan: publicScan(s.scan), node: s.node, verified: s.verified })),
        agreement,
      });
    }),
  );

  app.get('/api/nodes', (_req, res) => {
    res.json({ nodes: nodes.list() });
  });

  // A scan here is also an open request (igris.request.v1) other nodes may
  // fulfil. The job is reserved first (one scan per hostname holds while the
  // request transaction runs), then the request is created; the job's publish
  // waits for it and carries { request: key }. When the request cannot be
  // created the scan still runs and publishes without one (request: null).
  app.post('/api/sites/:hostname/scans', rateLimited, (req, res) => {
    let target: { hostname: string; url: string };
    try {
      target = scanTarget(
        param(req, 'hostname'),
        (req.body as { url?: unknown } | undefined)?.url,
        config.allowedPorts,
        deps.isPublicAddress,
      );
    } catch (err) {
      res.status(400).json({ error: err instanceof BadRequest ? err.message : 'invalid request' });
      return;
    }
    // The registry's own rule for a publishable hostname (e.g. Arkiv's
    // 128-byte attribute limit): never run a scan that could not be published.
    if (!isHostname(target.hostname)) {
      res.status(400).json({
        error: 'hostname cannot be published to the site registry (at most 128 characters)',
      });
      return;
    }
    if (!registryInfo.ready) {
      res.status(503).json({
        error: `scanning is unavailable: the registry cannot publish (${registryInfo.reason ?? 'not ready'})`,
      });
      return;
    }
    let settle!: (key: string | null) => void;
    const requestKey = new Promise<string | null>((r) => (settle = r));
    let job: Job;
    try {
      job = jobs.submit(target.hostname, target.url, { request: requestKey });
    } catch (err) {
      settle(null);
      if (err instanceof ScanInProgress) {
        res.status(409).json({ error: err.message, id: err.id });
        return;
      }
      if (err instanceof ScanQueueFull) {
        res.status(503).json({ error: err.message });
        return;
      }
      throw err;
    }
    void createRequestFor(job, target)
      .then((request) => {
        settle(request?.key ?? null);
        res.status(202).json({ id: job.id, request: request ? publicRequest(request) : null });
      })
      .catch((err: unknown) => {
        settle(null);
        log(`scan ${job.id}: ${errText(err)}`);
        if (!res.headersSent) res.status(202).json({ id: job.id, request: null });
      });
  });

  /** The request for a job just started here; null (logged) when it cannot be created. */
  async function createRequestFor(
    job: Job,
    target: { hostname: string; url: string },
  ): Promise<ScanRequest | null> {
    const problem = requestUrlProblem(target.hostname, target.url);
    if (problem !== null) {
      log(`scan ${job.id}: no scan request (${problem}); scanning without one`);
      return null;
    }
    try {
      const created = await registry.createRequest(target.hostname, target.url);
      // Known now: a site read right after must not cache it as missing.
      requests.set(created.key.toLowerCase(), { request: created, at: requestNow() });
      return created;
    } catch (err) {
      log(
        `scan ${job.id}: the scan request could not be created (${errText(err)}); scanning without one`,
      );
      return null;
    }
  }

  app.get('/api/scans/:id', (req, res) => {
    const job = isJobId(param(req, 'id')) ? jobs.get(param(req, 'id')) : undefined;
    if (!job) {
      res.status(404).json({ error: 'scan not found' });
      return;
    }
    res.json({ scan: job });
  });

  // A finished scan straight from this server's cache — so a scan whose
  // publish failed (or is pending) can still be viewed. Re-verified on every
  // read (schema, integrity, hashes); never trusted because it is on disk.
  app.get('/api/scans/:id/report', readLimited, (req, res) => {
    const id = param(req, 'id');
    const job = isJobId(id) ? jobs.get(id) : undefined;
    if (!job) {
      res.status(404).json({ error: 'scan not found' });
      return;
    }
    if (job.state !== 'completed') {
      res.status(409).json({ error: `scan is ${job.state}` });
      return;
    }
    const scanId = jobs.scanIdOf(id);
    const cached = scanId ? readCachedScan(config.dataDir, scanId) : null;
    if (!scanId || !cached) {
      res
        .status(404)
        .json({ error: "this scan is not in the server's local cache (or is unreadable)" });
      return;
    }
    const problems = verifyCached(
      {
        scanId,
        evidenceSha256: cached.draft?.evidenceSha256 ?? cached.report.evidence.sha256,
      },
      cached,
    );
    res.json({
      report: cached.report,
      evidence: cached.bundle,
      verified: problems.length === 0,
      problems,
      summary: summarise(cached.report, cached.bundle),
      source: 'local',
    });
  });

  app.post(
    '/api/scans/:id/publish',
    rateLimited,
    handle(async (req, res) => {
      const id = param(req, 'id');
      const job = isJobId(id) ? jobs.get(id) : undefined;
      if (!job) {
        res.status(404).json({ error: 'scan not found' });
        return;
      }
      try {
        res.json({ publish: await jobs.retryPublish(id) });
      } catch (err) {
        if (err instanceof PublishConflict) {
          res.status(409).json({ error: err.message });
          return;
        }
        throw err;
      }
    }),
  );

  // Server-sent events: replay what already happened, then stream live.
  app.get('/api/scans/:id/events', (req, res) => {
    const job = isJobId(param(req, 'id')) ? jobs.get(param(req, 'id')) : undefined;
    if (!job) {
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
    send('state', { state: job.state });
    for (const e of job.events) send('progress', e);
    if (job.state === 'completed' || job.state === 'failed') {
      send('done', doneOf(job));
      res.end();
      return;
    }
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    const unsubscribe = jobs.subscribe(job.id, (e) => {
      if (e.kind === 'state') send('state', { state: e.state });
      else if (e.kind === 'progress') send('progress', e.event);
      else {
        send('done', e.done);
        clearInterval(keepAlive);
        unsubscribe();
        res.end();
      }
    });
    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  app.get(
    '/api/recipients/:domain',
    handle(async (req, res) => {
      const domain = validateHostname(param(req, 'domain'));
      const limit = limitParam(req.query.limit, 100, 500);
      res.json({ flows: (await registry.flowsTo(domain, { limit })).map(publicFlow) });
    }),
  );

  // What sites asked wallets to sign (latest version per site), filtered.
  app.get(
    '/api/wallet-requests',
    readLimited,
    handle(async (req, res) => {
      res.json({
        requests: (await registry.walletRequests(walletRequestFilters(req.query))).map(
          publicWalletRequest,
        ),
      });
    }),
  );

  // The built website, same origin (static.ts). After every API route, and
  // it never handles /api paths, so it cannot shadow one.
  if (config.staticDir !== null) app.use(websiteHandler(config.staticDir));

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
    log(`unhandled error: ${errText(err)}`);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
