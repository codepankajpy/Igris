/**
 * The site registry: IGRIS's single source of truth for published scans.
 * One interface, two backends with identical behaviour:
 *  - ArkivSiteRegistry: Arkiv Rabdi testnet (production);
 *  - LocalSiteRegistry: a JSON file (tests, offline development).
 *
 * Per scanned site (hostname) the registry keeps a VERSION HISTORY: every
 * publish creates version n+1 whose `previous` points at version n's entity
 * key. See docs/design/FLOW.md for the entities and their attributes.
 *
 * Reads only trust entities owned by `trustedOwners` (anyone can write to
 * Arkiv; an entity is an attestation by its owner, not a fact).
 */
import type {
  EvidenceBundle,
  RecordedWalletMethod,
  ReportV3,
  SummaryState,
  Verdict,
  WalletRequestKind,
} from '@igris/core';

/** A published scan version (the igris.scan.v2 entity, decoded). */
export interface PublishedScan {
  /** Arkiv entity key (local backend: a stable synthetic key). */
  key: string;
  /** Address that signed the entity. */
  owner: string;
  hostname: string;
  /** 1 for the first scan of a hostname by this owner, then +1 per retest. */
  version: number;
  /** Entity key of the previous version, null for version 1. */
  previous: string | null;
  /** Unix seconds. */
  scannedAt: number;
  /** contentHash(report) — the report's canonical sha256. */
  scanId: string;
  evidenceSha256: string;
  findingSetSha256: string;
  state: SummaryState;
  coverage: 'full' | 'pre-connect-only';
  recipients: number;
  addressRecipients: number;
  /** Recipients with verdict tracking or unidentified. */
  trackingRecipients: number;
  usesAnonRpc: boolean;
  scannerVersion: string;
  reportVersion: string;
  /** Block at which the entity expires, when known. */
  expiresAtBlock: number | null;
}

/** One decoded wallet request of a published version (igris.walletreq.v1). */
export interface WalletRequestEntity {
  key: string;
  owner: string;
  hostname: string;
  kind: WalletRequestKind;
  method: RecordedWalletMethod;
  outcome: 'answered' | 'signed' | 'rejected' | 'error';
  unlimited: boolean;
  chainIdMismatch: boolean;
  domainMismatch: boolean;
  preConnect: boolean;
  /** Checksummed address or "" when none. */
  verifyingContract: string;
  /** Checksummed address or "" when none. */
  spender: string;
  version: number;
  scanId: string;
  scannedAt: number;
}

/** One dApp → recipient data flow of a published version (igris.flow.v1). */
export interface FlowEntity {
  key: string;
  owner: string;
  hostname: string;
  recipient: string;
  class: string;
  verdict: Verdict;
  address: 'exact' | 'hashed' | 'possible' | 'none';
  preConnect: boolean;
  version: number;
  scanId: string;
  scannedAt: number;
}

export interface PublishResult {
  scan: PublishedScan;
  evidenceKey: string;
  flowKeys: string[];
  /**
   * igris.walletreq.v1 keys, in report order. Optional only so results built
   * elsewhere (test doubles) still type-check; both backends always set it.
   */
  walletRequestKeys?: string[];
  /** Transaction hash of the atomic batch (null for the local backend). */
  txHash: string | null;
}

export interface LoadedScan {
  report: ReportV3;
  bundle: EvidenceBundle;
  /** Every check passed: hashes match the entity, schema valid, integrity ok. */
  verified: boolean;
  /**
   * Why `verified` is false. A verified version may still carry one
   * informational note: DRAFT_V3_NOTE for a draft 3.0.0 report (published
   * before wallet-request auditing; shown upgraded, walletRequests null).
   */
  problems: string[];
}

export interface SiteRegistry {
  readonly mode: 'arkiv' | 'local';
  /** Address that signs publishes; null when the registry is read-only. */
  readonly publisher: string | null;
  /** Newest version first. */
  versions(hostname: string, opts?: { limit?: number }): Promise<PublishedScan[]>;
  latest(hostname: string): Promise<PublishedScan | null>;
  version(hostname: string, version: number): Promise<PublishedScan | null>;
  /**
   * The published version of `hostname` whose scanId (contentHash(report))
   * is `scanId`, among trusted owners only; null when none (or when either
   * argument is malformed). Lets a caller detect that a report is already
   * published before publishing it again. When several trusted owners
   * published the same report, the highest version wins.
   */
  findByScanId(hostname: string, scanId: string): Promise<PublishedScan | null>;
  /**
   * The scan entity with this exact key, among trusted owners only; null
   * when absent, untrusted, malformed or not a valid igris.scan.v2 row.
   * Follows a version's `previous` pointer exactly.
   */
  byKey(key: string): Promise<PublishedScan | null>;
  /** Latest version of each recently scanned hostname, newest first. */
  recentSites(opts?: { limit?: number }): Promise<PublishedScan[]>;
  /** Fetch the published report + evidence and verify them against the entity. */
  load(scan: PublishedScan): Promise<LoadedScan>;
  /**
   * Publish a 3.0.0 report: version = latest(hostname).version + 1 (1 if none),
   * previous = latest key. Refuses reports that are not 3.0.0, fail
   * validation/integrity, have coverage "none", or exceed the size limit,
   * and reports whose scan.scannedAt is strictly older than the current
   * latest version's (history never runs backwards).
   *
   * Idempotent per (hostname, scanId): when that report is already published
   * (by a trusted owner or this publisher), nothing is written and the
   * existing version is returned with txHash null and its evidence / flow
   * keys looked up ("" / [] when they cannot be found).
   *
   * Recipients whose domain is not a hostname (IP literals) get no flow
   * entity; the scan and its full report are still published.
   */
  publish(report: ReportV3, bundle: EvidenceBundle): Promise<PublishResult>;
  /** Decoded wallet requests across sites (latest version per site), filtered. */
  walletRequests(opts: {
    kind?: WalletRequestKind;
    unlimited?: boolean;
    hostname?: string;
    limit?: number;
  }): Promise<WalletRequestEntity[]>;
  /**
   * Flows to one recipient across all sites: only flows of each site's
   * latest version, newest scannedAt first (ties by hostname), at most
   * `limit` (default 50) after that filtering.
   */
  flowsTo(recipient: string, opts?: { limit?: number }): Promise<FlowEntity[]>;
}

export class PublishRefusedError extends Error {}
