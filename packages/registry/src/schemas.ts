/**
 * The three Arkiv entity schemas of the one flow (docs/design/FLOW.md).
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

export type IgrisSchema = typeof ScanSchema | typeof EvidenceSchema | typeof FlowSchema;

/** Every scan attribute except the report payload: what listings select. */
export const SCAN_LIST_COLUMNS = Object.keys(ScanSchema.columns).filter((c) => c !== 'report');
