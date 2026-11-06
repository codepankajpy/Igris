/**
 * The Arkiv schema for scan entities — shared by the Node publisher and the
 * browser viewer, so it must stay free of Node-only imports.
 *
 * Schema name is versioned: a breaking attribute change gets a new name
 * (igris.scan.v2) rather than corrupting old rows. Justification for every
 * choice is in arkiv/schema.md.
 */
import { defineSchema, bool, bytes, i32, str, u64 } from '@arkiv-network/sdk/schema';

export const SCAN_SCHEMA_NAME = 'igris.scan.v1';

export const ScanSchema = defineSchema(SCAN_SCHEMA_NAME, {
  // Indexed: everything the viewer filters on.
  hostname: str().indexed(),
  score: i32().indexed(),
  scannedAt: u64().indexed(), // unix seconds ($createdAt cannot be sorted on)
  leakCount: i32().indexed(),
  thirdPartyCount: i32().indexed(),
  usesAnonRpc: bool().indexed(),
  // Stored-only: cheaper, still returned with results.
  leakClasses: str(), // comma-joined; no substring filter in Arkiv → client-side
  scannerVersion: str(),
  reportVersion: str(),
  chainId: i32(),
  reportSha256: str(), // 64 hex chars — proves a report.json matches this entity
  summary: bytes(), // compact JSON (SummaryPayload), ≤128 KiB
});
