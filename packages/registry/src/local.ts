/**
 * Local backend: the same entities, attributes and bytes as Arkiv, stored in
 * one JSON file in Arkiv's JSON-RPC entity shape (so one decoder, rows.ts,
 * reads both). For tests and offline development.
 *
 * Writes are atomic (temp file + rename) and serialised within the process.
 * Two processes writing the same file are not coordinated.
 * Entity keys are deterministic: "local:" + sha256 of what identifies them.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  contentHash,
  type EvidenceBundle,
  type ReportV3,
  type WalletRequestKind,
} from '@igris/core';
import {
  buildPublication,
  canonicalRequestUrl,
  toWireAttributes,
  withVersion,
  type WireEntity,
} from './payload.js';
import {
  LOCAL_FORMAT,
  LOCAL_KEY_RE,
  LOCAL_OWNER_RE,
  MAX_UNIX,
  PERMISSIONLESS_EXTENSION_FLAG,
  PUBLISHED_WALLET_REQUEST_KINDS,
  READONLY_FLAG,
  RequestPicker,
  SHA256_RE,
  byNewestFlow,
  byRequestedAt,
  byVersionDesc,
  isFlowOf,
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
} from './rows.js';
import {
  EvidenceSchema,
  FlowSchema,
  RequestSchema,
  ScanSchema,
  WalletRequestSchema,
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

export const LOCAL_FILE_FORMAT = 'igris.local-site-registry.v1' as const;

export interface LocalSiteRegistryOptions {
  file: string;
  /** Owner written on publishes; null ⇒ read-only. */
  publisher: string | null;
  /** Owners whose entities reads accept (default: [publisher] when there is one). */
  trustedOwners?: string[];
  /** Clock, unix seconds (default: the system clock): requestedAt and request expiry. */
  now?: () => number;
}

interface LocalFile {
  format: typeof LOCAL_FILE_FORMAT;
  entities: unknown[];
}

const DEFAULT_LIMIT = 50;
/** Same cap as the Arkiv backend (its page size). */
const MAX_FLOWS_LIMIT = 100;
/** Same as the Arkiv backend: requests live 7 days (emulated here from requestedAt). */
const REQUEST_LIFETIME_S = 7 * 86_400;
const DEFAULT_REQUESTS = 100;
const MAX_REQUESTS = 1000;
/** Creation flags written locally, as on Arkiv. */
const READONLY = READONLY_FLAG;
const REQUEST_FLAGS = READONLY_FLAG | PERMISSIONLESS_EXTENSION_FLAG;

export class LocalSiteRegistry implements SiteRegistry {
  readonly mode = 'local' as const;
  readonly network = 'local';
  readonly publisher: string | null;
  readonly trustedOwners: string[];
  readonly file: string;
  /** Why the last read found the file unusable (null when it was fine or absent). */
  lastReadProblem: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(opts: LocalSiteRegistryOptions) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    if (opts.publisher !== null && !LOCAL_OWNER_RE.test(opts.publisher)) {
      throw new Error(`invalid local publisher ${JSON.stringify(opts.publisher)}`);
    }
    this.file = opts.file;
    this.publisher = opts.publisher;
    this.trustedOwners = [
      ...(opts.trustedOwners ?? (opts.publisher !== null ? [opts.publisher] : [])),
    ];
  }

  /** Readiness for /api/registry: the file is absent (empty registry) or readable. */
  async status(): Promise<{ ready: boolean; reason?: string }> {
    try {
      this.readFile(true);
      return { ready: true };
    } catch (err) {
      return { ready: false, reason: (err as Error).message };
    }
  }

  // --- file ---------------------------------------------------------------

  /** strict: throw on a corrupt file (publish must never overwrite one). */
  private readFile(strict: boolean): unknown[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LocalFile> | null;
      if (raw?.format !== LOCAL_FILE_FORMAT || !Array.isArray(raw.entities)) {
        throw new Error(`${this.file} is not an ${LOCAL_FILE_FORMAT} file`);
      }
      this.lastReadProblem = null;
      return raw.entities;
    } catch (err) {
      const msg = `cannot read local registry ${this.file}: ${(err as Error).message}`;
      if (strict) throw new Error(msg);
      this.lastReadProblem = msg;
      return [];
    }
  }

  private writeFile(entities: unknown[]): void {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const file: LocalFile = { format: LOCAL_FILE_FORMAT, entities };
    writeFileSync(tmp, JSON.stringify(file, null, 1) + '\n', { flag: 'wx' });
    renameSync(tmp, this.file);
  }

  private trusted(owners: readonly string[] = this.trustedOwners): (o: string) => boolean {
    const set = ownerSet(owners);
    return (o) => set.has(o.toLowerCase());
  }

  private scans(entities: unknown[], owners?: readonly string[]): PublishedScan[] {
    const ok = this.trusted(owners);
    return entities
      .map((e) => parseScanRow(e, LOCAL_FORMAT))
      .filter((s): s is PublishedScan => s !== null && ok(s.owner));
  }

  // --- reads ----------------------------------------------------------------

  async versions(hostname: string, opts: { limit?: number } = {}): Promise<PublishedScan[]> {
    return this.scans(this.readFile(false))
      .filter((s) => s.hostname === hostname)
      .sort(byVersionDesc)
      .slice(0, opts.limit ?? 1000);
  }

  async latest(hostname: string): Promise<PublishedScan | null> {
    return (await this.versions(hostname, { limit: 1 }))[0] ?? null;
  }

  async version(hostname: string, version: number): Promise<PublishedScan | null> {
    return (await this.versions(hostname)).find((s) => s.version === version) ?? null;
  }

  async findByScanId(hostname: string, scanId: string): Promise<PublishedScan | null> {
    if (typeof scanId !== 'string' || !SHA256_RE.test(scanId)) return null;
    return (
      this.scans(this.readFile(false))
        .filter((s) => s.hostname === hostname && s.scanId === scanId)
        .sort(byVersionDesc)[0] ?? null
    );
  }

  async byKey(key: string): Promise<PublishedScan | null> {
    if (typeof key !== 'string' || !LOCAL_KEY_RE.test(key)) return null;
    return this.scans(this.readFile(false)).find((s) => s.key === key) ?? null;
  }

  async recentSites(opts: { limit?: number } = {}): Promise<PublishedScan[]> {
    return latestPerHostname(this.scans(this.readFile(false)), opts.limit ?? DEFAULT_LIMIT);
  }

  async load(scan: PublishedScan): Promise<LoadedScan> {
    const entities = this.readFile(false);
    const raw = entities.find((e) => (e as { key?: unknown } | null)?.key === scan.key);
    const stored = raw === undefined ? null : parseScanRow(raw, LOCAL_FORMAT);
    if (!stored) throw new ScanLoadError(`no valid scan entity ${scan.key}`);
    if (!this.trusted()(stored.owner))
      throw new ScanLoadError(`scan ${scan.key} is not owned by a trusted owner`);
    const evidence =
      entities
        .map((e) => parseEvidenceRow(e, LOCAL_FORMAT))
        .find(
          (r) =>
            r !== null &&
            r.owner.toLowerCase() === stored.owner.toLowerCase() &&
            r.sha256 === stored.evidenceSha256 &&
            r.scanId === stored.scanId,
        ) ?? null;
    return verifyLoaded(stored, scanReportPayload(raw), evidence);
  }

  async flowsTo(recipient: string, opts: { limit?: number } = {}): Promise<FlowEntity[]> {
    const entities = this.readFile(false);
    const ok = this.trusted();
    const latest = new Map(
      latestPerHostname(this.scans(entities), Infinity).map((s) => [s.hostname, s]),
    );
    return entities
      .map((e) => parseFlowRow(e, LOCAL_FORMAT))
      .filter((f): f is FlowEntity => {
        if (f === null || f.recipient !== recipient || !ok(f.owner)) return false;
        const l = latest.get(f.hostname);
        return l !== undefined && isFlowOf(f, l);
      })
      .sort(byNewestFlow)
      .slice(0, Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_FLOWS_LIMIT)));
  }

  async walletRequests(opts: {
    kind?: WalletRequestKind;
    unlimited?: boolean;
    hostname?: string;
    limit?: number;
  }): Promise<WalletRequestEntity[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_FLOWS_LIMIT));
    if (
      opts.kind !== undefined &&
      !(PUBLISHED_WALLET_REQUEST_KINDS as readonly string[]).includes(opts.kind)
    )
      return [];
    if (opts.unlimited !== undefined && typeof opts.unlimited !== 'boolean') return [];
    if (opts.hostname !== undefined && !isHostname(opts.hostname)) return [];
    const entities = this.readFile(false);
    const ok = this.trusted();
    const latest = new Map(
      latestPerHostname(this.scans(entities), Infinity).map((s) => [s.hostname, s]),
    );
    return entities
      .map((e) => parseWalletRequestRow(e, LOCAL_FORMAT))
      .filter((w): w is WalletRequestEntity => {
        if (w === null || !ok(w.owner)) return false;
        if (opts.kind !== undefined && w.kind !== opts.kind) return false;
        if (opts.unlimited !== undefined && w.unlimited !== opts.unlimited) return false;
        if (opts.hostname !== undefined && w.hostname !== opts.hostname) return false;
        const l = latest.get(w.hostname);
        return l !== undefined && isOfVersion(w, l);
      })
      .sort(byNewestFlow)
      .slice(0, limit);
  }

  // --- open scan requests ---------------------------------------------------

  /**
   * Live (not expired), valid requests of the file, any creator; not dated
   * more than REQUEST_CLOCK_SKEW_S in the future (parseRequestRow).
   */
  private requests(entities: unknown[]): ScanRequest[] {
    const now = this.now();
    return entities
      .map((e) => parseRequestRow(e, LOCAL_FORMAT, { now }))
      .filter((r): r is ScanRequest => r !== null && r.requestedAt + REQUEST_LIFETIME_S > now);
  }

  createRequest(hostname: string, url: string): Promise<ScanRequest> {
    const run = this.queue.then(() => this.createRequestNow(hostname, url));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private createRequestNow(hostname: string, url: string): ScanRequest {
    const creator = this.publisher;
    if (creator === null)
      throw new PublishRefusedError('this registry is read-only (no publisher)');
    const href = canonicalRequestUrl(hostname, url);
    const requestedAt = this.now();
    if (!Number.isSafeInteger(requestedAt) || requestedAt < 1 || requestedAt > MAX_UNIX)
      throw new Error(`invalid clock value ${requestedAt}`);
    const entities = this.readFile(true);
    const key = `local:${contentHash({
      s: RequestSchema.name,
      creator,
      hostname,
      url: href,
      requestedAt,
      n: entities.length,
    })}`;
    const entity: WireEntity = {
      key,
      owner: creator,
      creator,
      expiresAt: null,
      creationFlags: REQUEST_FLAGS,
      attributes: toWireAttributes(RequestSchema, { hostname, url: href, requestedAt }),
    };
    this.writeFile([...entities, entity]);
    const r = parseRequestRow(entity, LOCAL_FORMAT);
    if (!r) throw new Error('internal: the written request entity does not decode');
    return r;
  }

  async request(key: string): Promise<ScanRequest | null> {
    if (typeof key !== 'string' || !LOCAL_KEY_RE.test(key)) return null;
    return this.requests(this.readFile(false)).find((r) => r.key === key) ?? null;
  }

  async openRequests(opts: { since: number; limit?: number }): Promise<ScanRequest[]> {
    const since = opts.since;
    if (!Number.isSafeInteger(since) || since < 0 || since > MAX_UNIX) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_REQUESTS, MAX_REQUESTS));
    // Same selection as Arkiv: newest first, per-creator cap, then oldest first.
    const picker = new RequestPicker(limit);
    for (const r of this.requests(this.readFile(false))
      .filter((x) => x.requestedAt >= since)
      .sort((a, b) => byRequestedAt(b, a))) {
      if (picker.full) break;
      picker.offer(r);
    }
    return picker.result();
  }

  async fulfilments(key: string): Promise<PublishedScan[]> {
    if (typeof key !== 'string' || !LOCAL_KEY_RE.test(key)) return [];
    return this.scans(this.readFile(false))
      .filter((s) => s.request === key)
      .sort(byVersionDesc);
  }

  // --- publish --------------------------------------------------------------

  publish(
    report: ReportV3,
    bundle: EvidenceBundle,
    opts: { request?: string } = {},
  ): Promise<PublishResult> {
    const run = this.queue.then(() => this.publishNow(report, bundle, opts.request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private publishNow(
    report: ReportV3,
    bundle: EvidenceBundle,
    request: string | undefined,
  ): PublishResult {
    const owner = this.publisher;
    if (owner === null) throw new PublishRefusedError('this registry is read-only (no publisher)');
    if (request !== undefined && (typeof request !== 'string' || !LOCAL_KEY_RE.test(request)))
      throw new PublishRefusedError('opts.request is not a local entity key');
    const pub = buildPublication(report, bundle);
    const entities = this.readFile(true);
    const history = this.scans(entities, [...this.trustedOwners, owner])
      .filter((s) => s.hostname === pub.hostname)
      .sort(byVersionDesc);
    const prev = history[0] ?? null;
    // Idempotent per (hostname, scanId): the same report is never a second version.
    const same = history.find((s) => s.scanId === pub.scan.scanId);
    if (same) return this.existingResult(entities, same);
    if (prev && pub.scan.scannedAt < prev.scannedAt) {
      throw new PublishRefusedError(
        `report scannedAt ${pub.scan.scannedAt} is older than ${pub.hostname} version ${prev.version} (${prev.scannedAt}); history does not run backwards`,
      );
    }
    if (request !== undefined) {
      const r = this.requests(entities).find((x) => x.key === request);
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
    const localKey = (id: unknown) => `local:${contentHash(id)}`;

    const scanKey = localKey({
      s: ScanSchema.name,
      owner,
      hostname: pub.hostname,
      version,
      id: v.scan.scanId,
    });
    const evidenceKey = localKey({
      s: EvidenceSchema.name,
      owner,
      hostname: pub.hostname,
      version,
      sha: v.evidence.sha256,
    });
    const flowKeys = v.flows.map((f) =>
      localKey({
        s: FlowSchema.name,
        owner,
        hostname: pub.hostname,
        version,
        r: f.recipient,
        c: f.class,
      }),
    );
    const walletRequestKeys = v.walletRequests.map((_, i) =>
      localKey({
        s: WalletRequestSchema.name,
        owner,
        hostname: pub.hostname,
        version,
        id: v.scan.scanId,
        i,
      }),
    );
    const existing = new Set(entities.map((e) => (e as { key?: unknown } | null)?.key));
    for (const k of [scanKey, evidenceKey, ...flowKeys, ...walletRequestKeys]) {
      if (existing.has(k)) throw new Error(`local entity key collision ${k}`);
    }
    const entity = (key: string, attributes: WireEntity['attributes']): WireEntity => ({
      key,
      owner,
      creator: owner,
      expiresAt: null,
      creationFlags: READONLY,
      attributes,
    });
    const created: WireEntity[] = [
      entity(scanKey, toWireAttributes(ScanSchema, v.scan)),
      entity(evidenceKey, toWireAttributes(EvidenceSchema, v.evidence)),
      ...v.flows.map((f, i) => entity(flowKeys[i]!, toWireAttributes(FlowSchema, f))),
      ...v.walletRequests.map((w, i) =>
        entity(walletRequestKeys[i]!, toWireAttributes(WalletRequestSchema, w)),
      ),
    ];
    this.writeFile([...entities, ...created]);
    const scan = parseScanRow(created[0], LOCAL_FORMAT);
    if (!scan) throw new Error('internal: the written scan entity does not decode');
    return { scan, evidenceKey, flowKeys, walletRequestKeys, txHash: null };
  }

  /** The PublishResult of an already-published version (nothing written). */
  private existingResult(entities: unknown[], scan: PublishedScan): PublishResult {
    const sameOwner = (o: string) => o.toLowerCase() === scan.owner.toLowerCase();
    const evidenceKey =
      entities
        .map((e) => parseEvidenceRow(e, LOCAL_FORMAT))
        .find(
          (r) =>
            r !== null &&
            sameOwner(r.owner) &&
            r.sha256 === scan.evidenceSha256 &&
            r.scanId === scan.scanId,
        )?.key ?? '';
    const flowKeys = entities
      .map((e) => parseFlowRow(e, LOCAL_FORMAT))
      .filter(
        (f): f is FlowEntity =>
          f !== null &&
          sameOwner(f.owner) &&
          f.hostname === scan.hostname &&
          f.version === scan.version &&
          f.scanId === scan.scanId,
      )
      .map((f) => f.key);
    const walletRequestKeys = entities
      .map((e) => parseWalletRequestRow(e, LOCAL_FORMAT))
      .filter(
        (w): w is WalletRequestEntity => w !== null && sameOwner(w.owner) && isOfVersion(w, scan),
      )
      .map((w) => w.key);
    return { scan, evidenceKey, flowKeys, walletRequestKeys, txHash: null };
  }
}
