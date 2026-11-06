/**
 * Arkiv backend (Rabdi testnet).
 *
 * Writes: one atomic `executeBatch` per published version — 1 igris.scan.v2
 * + 1 igris.evidence.v1 + N igris.flow.v1 + M igris.walletreq.v1 creates,
 * all readonly and signed by the scanner key; the whole batch lands or none
 * of it does. `createRequest` writes one igris.request.v1 (readonly +
 * permissionlessExtension, 7-day expiry); requests of other creators are
 * read whether readonly or not.
 *
 * Reads: raw `arkiv_query` JSON-RPC calls, with query strings built by the
 * SDK's expression builders, filtered server-side to `trustedOwners` AND
 * re-checked client-side. Every returned entity is decoded by rows.ts and
 * skipped when invalid: the SDK's own row decoding throws for a whole page
 * when one hostile entity carries a malformed value, so it is not used here.
 */
import {
  createPublicClient,
  createWalletClient,
  ExpirationTime,
  type ExecuteBatchParameters,
} from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import {
  and,
  checkAgainstSchema,
  eq,
  gte,
  lte,
  or,
  projectSelection,
  type Expression,
  type RpcSelect,
} from '@arkiv-network/sdk/query';
import { addr, i32, key, SCHEMA_ATTRIBUTE, u64 } from '@arkiv-network/sdk/schema';
import { getAddress, http, numberToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { EvidenceBundle, ReportV3 } from '@igris/core';
import type { LoadedScanner } from './identity.js';
import type { WalletRequestKind } from '@igris/core';
import { estimateBatchGas, MAX_TRANSACTION_GAS } from './gas.js';
import {
  buildPublication,
  canonicalRequestUrl,
  withVersion,
  type VersionedPublication,
} from './payload.js';
import {
  ARKIV_FORMAT,
  ARKIV_KEY_RE,
  ARKIV_OWNER_RE,
  MAX_UNIX,
  PUBLISHED_WALLET_REQUEST_KINDS,
  REQUEST_CLOCK_SKEW_S,
  RequestPicker,
  SHA256_RE,
  byNewestFlow,
  byRequestedAt,
  byVersionDesc,
  isHostname,
  isOfVersion,
  latestPerHostname,
  ownerSet,
  parseEvidenceRow,
  parseFlowRow,
  parseRequestRow,
  parseScanRow,
  parseWalletRequestRow,
  scanReportPayload,
  type EvidenceRow,
  type VersionRow,
} from './rows.js';
import {
  EvidenceSchema,
  FlowSchema,
  RequestSchema,
  SCAN_LIST_COLUMNS,
  ScanSchema,
  WalletRequestSchema,
  type IgrisSchema,
} from './schemas.js';
import {
  PublishRefusedError,
  type FlowEntity,
  type LoadedScan,
  type PublishedScan,
  type PublishResult,
  type ScanRequest,
  type SiteRegistry,
  type WalletRequestEntity,
} from './site-registry.js';
import { ScanLoadError, verifyLoaded } from './verify.js';

export const RABDI_RPC_URL = 'https://rpc.rabdi.db-chain.testnet.arkiv.network';
export const RABDI_EXPLORER_URL = 'https://rabdi.explorer.arkiv.network';
export const ARKIV_NETWORK = 'rabdi';
/** Default entity lifetime: as long as Arkiv allows, rounded down (max ≈ 182.5 days). */
export const DEFAULT_EXPIRY_DAYS = 180;
export const MAX_EXPIRY_DAYS = 182;
/** Lifetime of an igris.request.v1 (anyone may extend it: permissionlessExtension). */
export const REQUEST_EXPIRY_DAYS = 7;
/** Default / largest number of requests openRequests returns. */
const DEFAULT_REQUESTS = 100;
/** Arkiv's page size limit. */
const PAGE = 100;
const DEFAULT_LIMIT = 50;
/** Upper bound on rows one read walks (pages of 100). */
const MAX_ROWS = 1000;
/**
 * Upper bound on request rows openRequests walks. Higher than MAX_ROWS: rows
 * of a creator over its per-creator cap are skipped and reading goes on, so
 * one creator must write this many in-window requests to hide anyone else's.
 */
export const MAX_REQUEST_ROWS = 5000;
/** Hostnames resolved per "latest version" query in flowsTo (one OR group). */
const HOSTS_PER_QUERY = 25;

/** The node calls the registry makes. Replaceable for tests. */
export interface ArkivIo {
  query(query: string, options: { select: RpcSelect; limit: Hex; offset?: Hex }): Promise<unknown>;
  executeBatch(
    params: ExecuteBatchParameters,
  ): Promise<{ txHash: string; createdEntities: readonly string[] }>;
}

export interface ArkivSiteRegistryOptions {
  /** Signing scanner (loadScanner()); null ⇒ read-only. */
  scanner: LoadedScanner | null;
  /** Arkiv RPC access key (rides in the RPC URL path); "" or absent ⇒ public endpoint. */
  accessKey?: string;
  /** Override the RPC URL (the access key is then not added). */
  rpcUrl?: string;
  /** Owners whose entities reads accept (default: [scanner address] when there is one). */
  trustedOwners?: string[];
  /** Entity lifetime in days, 1–182 (default 180). */
  expiryDays?: number;
  /** Tests only: replace the node calls. */
  io?: Partial<ArkivIo>;
  /** Clock for requestedAt, unix seconds (default: the system clock). */
  now?: () => number;
}

/** A query string: schema tag AND filters (validated against the schema), optional sort. */
export function buildQuery(
  schema: IgrisSchema,
  filters: Expression[],
  order?: { name: string; type: 'i32' | 'u64'; dir: 'ASC' | 'DESC' },
): string {
  for (const f of filters) checkAgainstSchema(f, schema);
  const q = and([eq(SCHEMA_ATTRIBUTE, schema.name as string), ...filters]).toString();
  return order ? `${q} ORDER BY ${order.name}:${order.type} ${order.dir}` : q;
}

/**
 * `$creator` is one of `owners` (lower-case or checksummed addresses).
 * The creator, not `$owner`: ownership can be transferred to any address
 * without its consent, so `$owner` would let anyone forge a trusted scan.
 */
export function ownersFilter(owners: readonly string[]): Expression {
  return or(owners.map((o) => eq('$creator', addr(o.toLowerCase()))));
}

const listSelect = (schema: IgrisSchema, columns: readonly string[]): RpcSelect =>
  projectSelection(
    Object.fromEntries([
      ['$key', true],
      ['$owner', true],
      ['$creator', true],
      ['$expiresAt', true],
      ...columns.map((c) => [c, true]),
    ]),
    schema,
  ).select;

const SCAN_LIST_SELECT = listSelect(ScanSchema, SCAN_LIST_COLUMNS);
const SCAN_FULL_SELECT = listSelect(ScanSchema, [...SCAN_LIST_COLUMNS, 'report']);
const EVIDENCE_SELECT = listSelect(EvidenceSchema, Object.keys(EvidenceSchema.columns));
const FLOW_SELECT = listSelect(FlowSchema, Object.keys(FlowSchema.columns));
const WALLET_REQUEST_SELECT = listSelect(
  WalletRequestSchema,
  Object.keys(WalletRequestSchema.columns),
);
const REQUEST_SELECT = listSelect(RequestSchema, Object.keys(RequestSchema.columns));

const systemNow = (): number => Math.floor(Date.now() / 1000);

function checksummed<T extends { owner: string }>(row: T): T {
  return { ...row, owner: getAddress(row.owner) };
}

export class ArkivSiteRegistry implements SiteRegistry {
  readonly mode = 'arkiv' as const;
  readonly network = ARKIV_NETWORK;
  readonly publisher: string | null;
  readonly trustedOwners: string[];
  readonly expiryDays: number;
  private readonly io: ArkivIo;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: ArkivSiteRegistryOptions) {
    this.now = opts.now ?? systemNow;
    const expiryDays = opts.expiryDays ?? DEFAULT_EXPIRY_DAYS;
    if (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > MAX_EXPIRY_DAYS) {
      throw new Error(`expiryDays must be an integer in 1..${MAX_EXPIRY_DAYS}, got ${expiryDays}`);
    }
    this.expiryDays = expiryDays;
    this.publisher = opts.scanner ? getAddress(opts.scanner.address) : null;
    const trusted = opts.trustedOwners ?? (this.publisher ? [this.publisher] : []);
    for (const o of trusted) {
      if (!ARKIV_OWNER_RE.test(o))
        throw new Error(`invalid trusted owner address ${JSON.stringify(o)}`);
    }
    this.trustedOwners = trusted.map((o) => getAddress(o.toLowerCase()));

    const chain = rabdi({ accessKey: opts.accessKey ?? '' });
    const transport = opts.rpcUrl ? http(opts.rpcUrl) : http();
    let query = opts.io?.query;
    if (!query) {
      const client = createPublicClient({ chain, transport });
      query = (q, options) =>
        client.request({ method: 'arkiv_query', params: [q, options] }) as Promise<unknown>;
    }
    let executeBatch = opts.io?.executeBatch;
    if (!executeBatch) {
      const scanner = opts.scanner;
      executeBatch = async (params) => {
        if (!scanner) throw new PublishRefusedError('this registry is read-only (no scanner key)');
        const wallet = createWalletClient({
          chain,
          transport,
          account: privateKeyToAccount(scanner.privateKey),
        });
        return wallet.executeBatch(params);
      };
    }
    this.io = { query, executeBatch };
  }

  /** Readiness for /api/registry: one tiny query against the node. */
  async status(): Promise<{ ready: boolean; reason?: string }> {
    try {
      const owners = this.trustedOwners.length ? this.trustedOwners : [this.publisher ?? ''];
      if (!owners[0]) return { ready: false, reason: 'no trusted owners configured' };
      await this.io.query(buildQuery(ScanSchema, [ownersFilter(owners)]), {
        select: { key: true },
        limit: numberToHex(1),
      });
      return { ready: true };
    } catch (err) {
      return { ready: false, reason: `Arkiv query failed: ${(err as Error).message}` };
    }
  }

  // --- raw reads --------------------------------------------------------------

  /** One page of one query (≤ limit entities). Network errors propagate. */
  private async fetchPage(
    query: string,
    select: RpcSelect,
    limit: number,
    offset: number,
  ): Promise<unknown[]> {
    const res = (await this.io.query(query, {
      select,
      limit: numberToHex(limit),
      ...(offset > 0 ? { offset: numberToHex(offset) } : {}),
    })) as { data?: unknown } | null;
    return Array.isArray(res?.data) ? (res.data as unknown[]).slice(0, limit) : [];
  }

  /** Walk pages of one query (≤ maxRows entities). Network errors propagate. */
  private async fetchRows(query: string, select: RpcSelect, maxRows: number): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let offset = 0; offset < maxRows; offset += PAGE) {
      const limit = Math.min(PAGE, maxRows - offset);
      const data = await this.fetchPage(query, select, limit, offset);
      out.push(...data);
      if (data.length < limit) break;
    }
    return out;
  }

  private trustedScans(rows: unknown[], owners: readonly string[]): PublishedScan[] {
    const set = ownerSet(owners);
    return rows
      .map((r) => parseScanRow(r, ARKIV_FORMAT))
      .filter((s): s is PublishedScan => s !== null && set.has(s.owner.toLowerCase()))
      .map(checksummed);
  }

  private async scansOf(
    hostname: string,
    owners: readonly string[],
    extra: Expression[] = [],
    maxRows = MAX_ROWS,
  ): Promise<PublishedScan[]> {
    if (!isHostname(hostname) || owners.length === 0) return [];
    const q = buildQuery(ScanSchema, [eq('hostname', hostname), ...extra, ownersFilter(owners)], {
      name: 'version',
      type: 'i32',
      dir: 'DESC',
    });
    return this.trustedScans(await this.fetchRows(q, SCAN_LIST_SELECT, maxRows), owners).sort(
      byVersionDesc,
    );
  }

  // --- SiteRegistry -----------------------------------------------------------

  async versions(hostname: string, opts: { limit?: number } = {}): Promise<PublishedScan[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? MAX_ROWS, MAX_ROWS));
    return (await this.scansOf(hostname, this.trustedOwners, [], limit)).slice(0, limit);
  }

  async latest(hostname: string): Promise<PublishedScan | null> {
    return (await this.scansOf(hostname, this.trustedOwners, [], PAGE))[0] ?? null;
  }

  async version(hostname: string, version: number): Promise<PublishedScan | null> {
    if (!Number.isInteger(version) || version < 1 || version > 2_147_483_647) return null;
    const rows = await this.scansOf(
      hostname,
      this.trustedOwners,
      [eq('version', i32(version))],
      PAGE,
    );
    return rows.find((s) => s.version === version) ?? null;
  }

  async findByScanId(hostname: string, scanId: string): Promise<PublishedScan | null> {
    if (typeof scanId !== 'string' || !SHA256_RE.test(scanId)) return null;
    const rows = await this.scansOf(hostname, this.trustedOwners, [eq('scanId', scanId)], PAGE);
    return rows.find((s) => s.scanId === scanId) ?? null;
  }

  async byKey(entityKey: string): Promise<PublishedScan | null> {
    if (typeof entityKey !== 'string' || !ARKIV_KEY_RE.test(entityKey)) return null;
    if (this.trustedOwners.length === 0) return null;
    const q = buildQuery(ScanSchema, [
      eq('$key', key(entityKey as Hex)),
      ownersFilter(this.trustedOwners),
    ]);
    const rows = await this.fetchRows(q, SCAN_LIST_SELECT, 1);
    return (
      this.trustedScans(rows, this.trustedOwners).find(
        (s) => s.key.toLowerCase() === entityKey.toLowerCase(),
      ) ?? null
    );
  }

  /**
   * Latest trusted version of each hostname, in as few queries as possible:
   * one query (an OR group of hostnames, version DESC) per HOSTS_PER_QUERY
   * hostnames. Version DESC guarantees that a hostname present in a page
   * already had its highest version returned; only when a query is cut at
   * MAX_ROWS are that chunk's hostnames resolved one by one instead.
   */
  private async latestOf(hostnames: readonly string[]): Promise<Map<string, PublishedScan>> {
    const owners = this.trustedOwners;
    const out = new Map<string, PublishedScan>();
    const valid = [...new Set(hostnames)].filter(isHostname);
    if (owners.length === 0) return out;
    for (let i = 0; i < valid.length; i += HOSTS_PER_QUERY) {
      const chunk = valid.slice(i, i + HOSTS_PER_QUERY);
      const q = buildQuery(
        ScanSchema,
        [or(chunk.map((h) => eq('hostname', h))), ownersFilter(owners)],
        { name: 'version', type: 'i32', dir: 'DESC' },
      );
      const rows = await this.fetchRows(q, SCAN_LIST_SELECT, MAX_ROWS);
      if (rows.length >= MAX_ROWS) {
        for (const h of chunk) {
          const l = await this.latest(h);
          if (l) out.set(h, l);
        }
        continue;
      }
      const wanted = new Set(chunk);
      const scans = this.trustedScans(rows, owners).filter((s) => wanted.has(s.hostname));
      for (const s of latestPerHostname(scans, Infinity)) out.set(s.hostname, s);
    }
    return out;
  }

  async recentSites(opts: { limit?: number } = {}): Promise<PublishedScan[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, PAGE));
    if (this.trustedOwners.length === 0) return [];
    const q = buildQuery(ScanSchema, [ownersFilter(this.trustedOwners)], {
      name: 'scannedAt',
      type: 'u64',
      dir: 'DESC',
    });
    const seen = new Map<string, PublishedScan>();
    const all: PublishedScan[] = [];
    for (let offset = 0; offset < MAX_ROWS && seen.size < limit; offset += PAGE) {
      const res = (await this.io.query(q, {
        select: SCAN_LIST_SELECT,
        limit: numberToHex(PAGE),
        ...(offset > 0 ? { offset: numberToHex(offset) } : {}),
      })) as { data?: unknown } | null;
      const data = Array.isArray(res?.data) ? (res.data as unknown[]) : [];
      for (const s of this.trustedScans(data, this.trustedOwners)) {
        all.push(s);
        if (!seen.has(s.hostname)) seen.set(s.hostname, s);
      }
      if (data.length < PAGE) break;
    }
    return latestPerHostname(all, limit);
  }

  async load(scan: PublishedScan): Promise<LoadedScan> {
    if (!ARKIV_KEY_RE.test(scan.key)) throw new ScanLoadError(`invalid entity key ${scan.key}`);
    if (!ownerSet(this.trustedOwners).has(scan.owner.toLowerCase()))
      throw new ScanLoadError(`scan ${scan.key} is not owned by a trusted owner`);
    const q = buildQuery(ScanSchema, [
      eq('$key', key(scan.key as Hex)),
      ownersFilter(this.trustedOwners),
    ]);
    const rows = await this.fetchRows(q, SCAN_FULL_SELECT, 1);
    const raw = rows.find(
      (r) => parseScanRow(r, ARKIV_FORMAT)?.key.toLowerCase() === scan.key.toLowerCase(),
    );
    const stored = raw === undefined ? null : parseScanRow(raw, ARKIV_FORMAT);
    if (!stored || !ownerSet(this.trustedOwners).has(stored.owner.toLowerCase()))
      throw new ScanLoadError(`no valid trusted scan entity ${scan.key} on Arkiv`);
    const eq_ = buildQuery(EvidenceSchema, [
      eq('sha256', stored.evidenceSha256),
      eq('scanId', stored.scanId),
      ownersFilter([stored.owner]),
    ]);
    const evidence =
      (await this.fetchRows(eq_, EVIDENCE_SELECT, 10))
        .map((r) => parseEvidenceRow(r, ARKIV_FORMAT))
        .find(
          (r): r is EvidenceRow =>
            r !== null &&
            r.owner.toLowerCase() === stored.owner.toLowerCase() &&
            r.sha256 === stored.evidenceSha256 &&
            r.scanId === stored.scanId,
        ) ?? null;
    return verifyLoaded(checksummed(stored), scanReportPayload(raw), evidence);
  }

  async flowsTo(recipient: string, opts: { limit?: number } = {}): Promise<FlowEntity[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, PAGE));
    if (!isHostname(recipient) || this.trustedOwners.length === 0) return [];
    const q = buildQuery(
      FlowSchema,
      [eq('recipient', recipient), ownersFilter(this.trustedOwners)],
      {
        name: 'scannedAt',
        type: 'u64',
        dir: 'DESC',
      },
    );
    const set = ownerSet(this.trustedOwners);
    const flows = (await this.fetchRows(q, FLOW_SELECT, MAX_ROWS))
      .map((r) => parseFlowRow(r, ARKIV_FORMAT))
      .filter(
        (f): f is FlowEntity =>
          f !== null && f.recipient === recipient && set.has(f.owner.toLowerCase()),
      )
      .map(checksummed);
    return this.onlyLatestVersions(flows, limit);
  }

  /**
   * Keep only rows of each site's LATEST trusted version (a site whose latest
   * version no longer has such a row drops out), newest scannedAt first, at
   * most `limit`. Filter FIRST, then trim. Sites are resolved newest first, a
   * chunk of hostnames per query, and resolution stops once no unresolved
   * site can still enter the first `limit` results.
   */
  private async onlyLatestVersions<T extends VersionRow>(rows: T[], limit: number): Promise<T[]> {
    // Per site, the newest row …
    const best = new Map<string, T>();
    const byHost = new Map<string, T[]>();
    for (const f of rows) {
      const cur = best.get(f.hostname);
      if (
        !cur ||
        f.version > cur.version ||
        (f.version === cur.version && f.scannedAt > cur.scannedAt)
      )
        best.set(f.hostname, f);
      const list = byHost.get(f.hostname);
      if (list) list.push(f);
      else byHost.set(f.hostname, [f]);
    }
    // … kept only when it IS the site's latest version.
    const candidates = [...best.values()].sort(byNewestFlow);
    const out: T[] = [];
    for (let i = 0; i < candidates.length; i += HOSTS_PER_QUERY) {
      const chunk = candidates.slice(i, i + HOSTS_PER_QUERY);
      const latest = await this.latestOf(chunk.map((f) => f.hostname));
      for (const b of chunk) {
        const l = latest.get(b.hostname);
        if (l) out.push(...byHost.get(b.hostname)!.filter((f) => isOfVersion(f, l)));
      }
      out.sort(byNewestFlow);
      const next = candidates[i + HOSTS_PER_QUERY];
      if (out.length >= limit && (!next || next.scannedAt < out[limit - 1]!.scannedAt)) break;
    }
    return out.slice(0, limit);
  }

  async walletRequests(opts: {
    kind?: WalletRequestKind;
    unlimited?: boolean;
    hostname?: string;
    limit?: number;
  }): Promise<WalletRequestEntity[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, PAGE));
    if (this.trustedOwners.length === 0) return [];
    const filters: Expression[] = [];
    if (opts.kind !== undefined) {
      if (!(PUBLISHED_WALLET_REQUEST_KINDS as readonly string[]).includes(opts.kind)) return [];
      filters.push(eq('kind', opts.kind));
    }
    if (opts.unlimited !== undefined) {
      if (typeof opts.unlimited !== 'boolean') return [];
      filters.push(eq('unlimited', i32(opts.unlimited ? 1 : 0)));
    }
    if (opts.hostname !== undefined) {
      if (!isHostname(opts.hostname)) return [];
      filters.push(eq('hostname', opts.hostname));
    }
    const q = buildQuery(WalletRequestSchema, [...filters, ownersFilter(this.trustedOwners)], {
      name: 'scannedAt',
      type: 'u64',
      dir: 'DESC',
    });
    const set = ownerSet(this.trustedOwners);
    const rows = (await this.fetchRows(q, WALLET_REQUEST_SELECT, MAX_ROWS))
      .map((r) => parseWalletRequestRow(r, ARKIV_FORMAT))
      .filter(
        (w): w is WalletRequestEntity =>
          w !== null &&
          set.has(w.owner.toLowerCase()) &&
          (opts.kind === undefined || w.kind === opts.kind) &&
          (opts.unlimited === undefined || w.unlimited === opts.unlimited) &&
          (opts.hostname === undefined || w.hostname === opts.hostname),
      )
      .map(checksummed);
    return this.onlyLatestVersions(rows, limit);
  }

  // --- open scan requests (docs/design/SCAN-NETWORK.md) ------------------------

  /** The batch one request writes: readonly + permissionlessExtension, 7-day expiry. */
  requestBatch(hostname: string, url: string, requestedAt: number): ExecuteBatchParameters {
    return {
      creates: [
        {
          schema: RequestSchema,
          values: { hostname, url, requestedAt: u64(BigInt(requestedAt)) },
          expiration: ExpirationTime.fromDays(REQUEST_EXPIRY_DAYS),
          // readonly: the URL can never be patched after a node fulfilled it
          // (readonly does not block extension: Arkiv's ReadOnlyEntity rule
          // leaves expiry, transfer and delete open).
          flags: { readonly: true, permissionlessExtension: true },
        },
      ],
    } as unknown as ExecuteBatchParameters;
  }

  async createRequest(hostname: string, url: string): Promise<ScanRequest> {
    const creator = this.publisher;
    if (creator === null)
      throw new PublishRefusedError('this registry is read-only (no scanner key)');
    const href = canonicalRequestUrl(hostname, url);
    const requestedAt = this.now();
    if (!Number.isSafeInteger(requestedAt) || requestedAt < 1 || requestedAt > MAX_UNIX)
      throw new Error(`invalid clock value ${requestedAt}`);
    const { txHash, createdEntities } = await this.io.executeBatch(
      this.requestBatch(hostname, href, requestedAt),
    );
    const k = createdEntities[0];
    if (createdEntities.length !== 1 || k === undefined || !ARKIV_KEY_RE.test(k)) {
      throw new Error(
        `Arkiv batch ${txHash} created ${createdEntities.length} entities, expected 1 request`,
      );
    }
    return { key: k, creator, hostname, url: href, requestedAt, expiresAtBlock: null };
  }

  async request(entityKey: string): Promise<ScanRequest | null> {
    if (typeof entityKey !== 'string' || !ARKIV_KEY_RE.test(entityKey)) return null;
    // Any creator: anyone may ask for a scan. The row itself is checked strictly.
    const q = buildQuery(RequestSchema, [eq('$key', key(entityKey as Hex))]);
    const rows = await this.fetchRows(q, REQUEST_SELECT, 1);
    const now = this.now();
    const r = rows
      .map((row) => parseRequestRow(row, ARKIV_FORMAT, { now }))
      .find((x) => x !== null && x.key.toLowerCase() === entityKey.toLowerCase());
    return r ? { ...r, creator: getAddress(r.creator) } : null;
  }

  /**
   * Requests with since ≤ requestedAt ≤ now + REQUEST_CLOCK_SKEW_S, any
   * creator, at most `limit` (default 100, ≤ 1000): the NEWEST ones when
   * there are more (so a burst of old requests cannot hide new ones), at
   * most MAX_REQUESTS_PER_CREATOR per creator, returned oldest first. Rows
   * are read newest first; a creator over its cap is skipped and reading
   * goes on (up to MAX_REQUEST_ROWS rows), so one creator's flood cannot
   * hide other creators' requests.
   */
  async openRequests(opts: { since: number; limit?: number }): Promise<ScanRequest[]> {
    const since = opts.since;
    if (!Number.isSafeInteger(since) || since < 0 || since > MAX_UNIX) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_REQUESTS, MAX_ROWS));
    const now = this.now();
    if (!Number.isSafeInteger(now)) return [];
    const latest = Math.min(now + REQUEST_CLOCK_SKEW_S, MAX_UNIX);
    if (since > latest) return [];
    const q = buildQuery(
      RequestSchema,
      [gte('requestedAt', u64(BigInt(since))), lte('requestedAt', u64(BigInt(latest)))],
      { name: 'requestedAt', type: 'u64', dir: 'DESC' },
    );
    const picker = new RequestPicker(limit);
    for (let offset = 0; offset < MAX_REQUEST_ROWS && !picker.full; offset += PAGE) {
      const page = await this.fetchPage(q, REQUEST_SELECT, PAGE, offset);
      page
        .map((row) => parseRequestRow(row, ARKIV_FORMAT, { now }))
        .filter((r): r is ScanRequest => r !== null && r.requestedAt >= since)
        .sort((a, b) => byRequestedAt(b, a)) // newest first within the page too
        .forEach((r) => picker.offer(r));
      if (page.length < PAGE) break;
    }
    return picker.result().map((r) => ({ ...r, creator: getAddress(r.creator) }));
  }

  async fulfilments(requestKey: string): Promise<PublishedScan[]> {
    if (typeof requestKey !== 'string' || !ARKIV_KEY_RE.test(requestKey)) return [];
    if (this.trustedOwners.length === 0) return [];
    const k = requestKey.toLowerCase();
    const q = buildQuery(ScanSchema, [eq('request', k), ownersFilter(this.trustedOwners)], {
      name: 'version',
      type: 'i32',
      dir: 'DESC',
    });
    return this.trustedScans(
      await this.fetchRows(q, SCAN_LIST_SELECT, MAX_ROWS),
      this.trustedOwners,
    )
      .filter((s) => s.request?.toLowerCase() === k)
      .sort(byVersionDesc);
  }

  publish(
    report: ReportV3,
    bundle: EvidenceBundle,
    opts: { request?: string } = {},
  ): Promise<PublishResult> {
    const run = this.queue.then(() => this.publishNow(report, bundle, opts.request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The batch one version writes (exported shape for tests and docs). */
  batchFor(v: VersionedPublication): ExecuteBatchParameters {
    const expiration = ExpirationTime.fromDays(this.expiryDays);
    // Published history is immutable: no attribute can ever be patched, not
    // even by the publisher (expiry can still be extended).
    const flags = { readonly: true };
    const creates = [
      {
        schema: ScanSchema,
        values: { ...v.scan, scannedAt: u64(BigInt(v.scan.scannedAt)) },
        expiration,
        flags,
      },
      { schema: EvidenceSchema, values: v.evidence, expiration, flags },
      ...v.flows.map((f) => ({
        schema: FlowSchema,
        values: { ...f, scannedAt: u64(BigInt(f.scannedAt)) },
        expiration,
        flags,
      })),
      ...v.walletRequests.map((w) => ({
        schema: WalletRequestSchema,
        values: { ...w, scannedAt: u64(BigInt(w.scannedAt)) },
        expiration,
        flags,
      })),
    ];
    return { creates } as unknown as ExecuteBatchParameters;
  }

  private async publishNow(
    report: ReportV3,
    bundle: EvidenceBundle,
    request: string | undefined,
  ): Promise<PublishResult> {
    const owner = this.publisher;
    if (owner === null)
      throw new PublishRefusedError('this registry is read-only (no scanner key)');
    if (request !== undefined && (typeof request !== 'string' || !ARKIV_KEY_RE.test(request)))
      throw new PublishRefusedError('opts.request is not an Arkiv entity key');
    const pub = buildPublication(report, bundle);
    const owners = [...new Set([...this.trustedOwners, owner])];
    const history = await this.scansOf(pub.hostname, owners, [], PAGE);
    const prev = history[0] ?? null;
    // Idempotent per (hostname, scanId): the same report is never a second version.
    const same =
      history.find((s) => s.scanId === pub.scan.scanId) ??
      (await this.scansOf(pub.hostname, owners, [eq('scanId', pub.scan.scanId)], PAGE)).find(
        (s) => s.scanId === pub.scan.scanId,
      );
    if (same) return this.existingResult(same);
    if (prev && pub.scan.scannedAt < prev.scannedAt) {
      throw new PublishRefusedError(
        `report scannedAt ${pub.scan.scannedAt} is older than ${pub.hostname} version ${prev.version} (${prev.scannedAt}); history does not run backwards`,
      );
    }
    if (request !== undefined) {
      const r = await this.request(request);
      if (!r)
        throw new PublishRefusedError(
          `request ${request} is not a live, valid igris.request.v1 entity`,
        );
      if (r.hostname !== pub.hostname)
        throw new PublishRefusedError(
          `request ${request} is for ${r.hostname}, not ${pub.hostname}`,
        );
    }
    const version = prev ? prev.version + 1 : 1;
    const v = withVersion(pub, version, prev?.key ?? null, request ?? null);
    const batch = this.batchFor(v);
    const gas = estimateBatchGas(batch);
    if (gas.lowerBound > MAX_TRANSACTION_GAS) {
      throw new PublishRefusedError(
        `the batch needs at least ${gas.lowerBound} gas for its calldata alone, over the ${MAX_TRANSACTION_GAS} per-transaction cap`,
      );
    }
    const { txHash, createdEntities } = await this.io.executeBatch(batch);
    const expected = 2 + v.flows.length + v.walletRequests.length;
    if (createdEntities.length !== expected) {
      throw new Error(
        `Arkiv batch ${txHash} created ${createdEntities.length} entities, expected ${expected}`,
      );
    }
    const [scanKey, evidenceKey, ...rest] = createdEntities as [string, string, ...string[]];
    const flowKeys = rest.slice(0, v.flows.length);
    const walletRequestKeys = rest.slice(v.flows.length);
    const scan: PublishedScan = {
      key: scanKey,
      owner,
      hostname: v.scan.hostname,
      version,
      previous: prev?.key ?? null,
      scannedAt: v.scan.scannedAt,
      scanId: v.scan.scanId,
      evidenceSha256: v.scan.evidenceSha256,
      findingSetSha256: v.scan.findingSetSha256,
      state: v.scan.state as PublishedScan['state'],
      coverage: v.scan.coverage as PublishedScan['coverage'],
      recipients: v.scan.recipients,
      addressRecipients: v.scan.addressRecipients,
      trackingRecipients: v.scan.trackingRecipients,
      usesAnonRpc: v.scan.usesAnonRpc,
      scannerVersion: v.scan.scannerVersion,
      reportVersion: v.scan.reportVersion,
      expiresAtBlock: null,
      request: v.scan.request === '' ? null : v.scan.request,
    };
    return { scan, evidenceKey, flowKeys, walletRequestKeys, txHash };
  }

  /** The PublishResult of an already-published version (nothing written). */
  private async existingResult(scan: PublishedScan): Promise<PublishResult> {
    const sameOwner = (o: string) => o.toLowerCase() === scan.owner.toLowerCase();
    const evQuery = buildQuery(EvidenceSchema, [
      eq('sha256', scan.evidenceSha256),
      eq('scanId', scan.scanId),
      ownersFilter([scan.owner]),
    ]);
    const flowQuery = buildQuery(FlowSchema, [
      eq('hostname', scan.hostname),
      eq('scanId', scan.scanId),
      eq('version', i32(scan.version)),
      ownersFilter([scan.owner]),
    ]);
    const evidenceKey =
      (await this.fetchRows(evQuery, EVIDENCE_SELECT, 10))
        .map((r) => parseEvidenceRow(r, ARKIV_FORMAT))
        .find(
          (r): r is EvidenceRow =>
            r !== null &&
            sameOwner(r.owner) &&
            r.sha256 === scan.evidenceSha256 &&
            r.scanId === scan.scanId,
        )?.key ?? '';
    const flowKeys = (await this.fetchRows(flowQuery, FLOW_SELECT, MAX_ROWS))
      .map((r) => parseFlowRow(r, ARKIV_FORMAT))
      .filter(
        (f): f is FlowEntity =>
          f !== null &&
          sameOwner(f.owner) &&
          f.hostname === scan.hostname &&
          f.version === scan.version &&
          f.scanId === scan.scanId,
      )
      .map((f) => f.key);
    const wrQuery = buildQuery(WalletRequestSchema, [
      eq('hostname', scan.hostname),
      eq('scanId', scan.scanId),
      eq('version', i32(scan.version)),
      ownersFilter([scan.owner]),
    ]);
    const walletRequestKeys = (await this.fetchRows(wrQuery, WALLET_REQUEST_SELECT, MAX_ROWS))
      .map((r) => parseWalletRequestRow(r, ARKIV_FORMAT))
      .filter(
        (w): w is WalletRequestEntity => w !== null && sameOwner(w.owner) && isOfVersion(w, scan),
      )
      .map((w) => w.key);
    return { scan, evidenceKey, flowKeys, walletRequestKeys, txHash: null };
  }
}
