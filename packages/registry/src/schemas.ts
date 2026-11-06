/**
 * The Arkiv entity schemas of the one flow (docs/design/FLOW.md), the open
 * scan requests (docs/design/SCAN-NETWORK.md) and the decoded wallet
 * requests (docs/design/WALLET-REQUESTS.md).
 *
 * Schema names are versioned: a breaking attribute change gets a new name
 * rather than corrupting old rows. Every `bytes` column holds gzip of the
 * canonical JSON (payload.ts). Justification for each attribute is in
 * arkiv/schema.md.
 */
import { bool, bytes, defineSchema, i32, str, u64 } from '@arkiv-network/sdk/schema';

export const SCAN_SCHEMA_NAME = 'igris.scan.v2';
export const EVIDENCE_SCHEMA_NAME = 'igris.evidence.v1';
export const FLOW_SCHEMA_NAME = 'igris.flow.v1';
export const REQUEST_SCHEMA_NAME = 'igris.request.v1';
export const WALLET_REQUEST_SCHEMA_NAME = 'igris.walletreq.v1';

/** One per published version of a site. */
export const ScanSchema = defineSchema(SCAN_SCHEMA_NAME, {
  hostname: str().indexed(),
  version: i32().indexed(),
  /** Entity key of version − 1; "" for version 1. */
  previous: str(),
  /** Unix seconds ($createdAt cannot be sorted on). */
  scannedAt: u64().indexed(),
  /** contentHash(report). */
  scanId: str().indexed(),
  /** bundleHash(bundle). */
  evidenceSha256: str().indexed(),
  findingSetSha256: str().indexed(),
  state: str().indexed(),
  coverage: str().indexed(),
  recipients: i32().indexed(),
  addressRecipients: i32().indexed(),
  trackingRecipients: i32().indexed(),
  usesAnonRpc: bool().indexed(),
  scannerVersion: str(),
  reportVersion: str(),
  /**
   * Entity key (lower-case 0x hex) of the igris.request.v1 this version
   * fulfilled; "" when none. Entities published before requests existed have
   * no such attribute and decode as `request: null`.
   */
  request: str().indexed(),
  /** gzip(canonical Report 3.0.0). */
  report: bytes(),
});

/** One per published version: the canonical evidence bundle. */
export const EvidenceSchema = defineSchema(EVIDENCE_SCHEMA_NAME, {
  sha256: str().indexed(),
  scanId: str().indexed(),
  bundleVersion: str(),
  /** gzip(canonical evidence bundle). */
  bundle: bytes(),
});

/** One per recipient of a published version (the cross-site view). */
export const FlowSchema = defineSchema(FLOW_SCHEMA_NAME, {
  hostname: str().indexed(),
  recipient: str().indexed(),
  class: str().indexed(),
  verdict: str().indexed(),
  address: str().indexed(),
  preConnect: bool().indexed(),
  version: i32().indexed(),
  scanId: str().indexed(),
  scannedAt: u64().indexed(),
});

/**
 * An open scan request: anyone may create one, any scanner node may fulfil
 * it. Created readonly + permissionlessExtension with a 7-day expiry.
 */
export const RequestSchema = defineSchema(REQUEST_SCHEMA_NAME, {
  hostname: str().indexed(),
  /** The http(s) URL to scan, on `hostname`; ≤ 128 UTF-8 bytes (longer URLs are refused). */
  url: str(),
  /** Unix seconds. */
  requestedAt: u64().indexed(),
});

/**
 * One per wallet request of a published version, except kind "connect".
 * Booleans are i32 0/1 so they can be filtered with `= i32(1)`.
 */
export const WalletRequestSchema = defineSchema(WALLET_REQUEST_SCHEMA_NAME, {
  hostname: str().indexed(),
  kind: str().indexed(),
  method: str().indexed(),
  outcome: str().indexed(),
  unlimited: i32().indexed(),
  chainIdMismatch: i32().indexed(),
  domainMismatch: i32().indexed(),
  preConnect: i32().indexed(),
  /** Checksummed address, "" when none. */
  verifyingContract: str().indexed(),
  /** Checksummed address, "" when none. */
  spender: str().indexed(),
  version: i32().indexed(),
  scanId: str().indexed(),
  scannedAt: u64().indexed(),
});

export type IgrisSchema =
  | typeof ScanSchema
  | typeof EvidenceSchema
  | typeof FlowSchema
  | typeof RequestSchema
  | typeof WalletRequestSchema;

/** Every scan attribute except the report payload: what listings select. */
export const SCAN_LIST_COLUMNS = Object.keys(ScanSchema.columns).filter((c) => c !== 'report');
