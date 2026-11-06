/**
 * What a publish writes, independent of the backend.
 *
 * `buildPublication` turns a Report 3.0.0 + its evidence bundle into the
 * attribute values of one igris.scan.v2, one igris.evidence.v1 and N
 * igris.flow.v1 entities — or refuses (PublishRefusedError). Both backends
 * write exactly these values, so a local registry and Arkiv hold the same
 * bytes.
 *
 * Payloads (`report`, `bundle`) are gzip of the canonical JSON; a payload
 * larger than MAX_PAYLOAD_BYTES after compression is refused, never truncated.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  addressReceived,
  assertCanaryFree,
  buildCanaryForms,
  bundleHash,
  canonicalize,
  contentHash,
  REPORT_V3_VERSION,
  summarise,
  validateEvidenceBundle,
  validateReport,
  verifyReportIntegrity,
  type EvidenceBundle,
  type Recipient,
  type ReportV3,
} from '@igris/core';
import { bytesToHex, hexToBytes } from 'viem';
import { SCHEMA_ATTRIBUTE } from '@arkiv-network/sdk/schema';
import { PublishRefusedError } from './site-registry.js';
import type { IgrisSchema } from './schemas.js';
import { isHostname, utf8Length, MAX_STR_BYTES } from './rows.js';

/** Largest gzip payload one bytes column may hold (Arkiv's per-entity bytes limit). */
export const MAX_PAYLOAD_BYTES = 128 * 1024;
/** Largest payload we will inflate on read (decompression-bomb guard). */
export const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;

/** A stored payload could not be decoded (not gzip, too large, not JSON). */
export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadError';
  }
}

/** gzip(canonical JSON of value). Refuses (PublishRefusedError) above MAX_PAYLOAD_BYTES. */
export function encodePayload(value: unknown, what = 'payload'): Uint8Array {
  const gz = new Uint8Array(gzipSync(Buffer.from(canonicalize(value), 'utf8'), { level: 9 }));
  if (gz.byteLength > MAX_PAYLOAD_BYTES) {
    throw new PublishRefusedError(
      `${what} is ${gz.byteLength} bytes after gzip, over the ${MAX_PAYLOAD_BYTES}-byte limit; not published (never truncated)`,
    );
  }
  return gz;
}

/** Inverse of encodePayload, for untrusted input (bytes or 0x hex). Throws PayloadError. */
export function decodePayload(input: Uint8Array | string, what = 'payload'): unknown {
  let bytes: Uint8Array;
  if (typeof input === 'string') {
    if (!/^0x([0-9a-fA-F]{2})*$/.test(input)) throw new PayloadError(`${what} is not hex`);
    bytes = hexToBytes(input as `0x${string}`);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    throw new PayloadError(`${what} is not bytes`);
  }
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new PayloadError(`${what} is ${bytes.byteLength} bytes, over the payload limit`);
  }
  let text: string;
  try {
    text = gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString('utf8');
  } catch (err) {
    throw new PayloadError(`${what} is not valid gzip: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PayloadError(`${what} is not JSON`);
  }
}

// ---------------------------------------------------------------------------
// Attribute values (plain JS; u64 as a safe-integer number)
// ---------------------------------------------------------------------------

export interface ScanValues {
  hostname: string;
  version: number;
  previous: string;
  scannedAt: number;
  scanId: string;
  evidenceSha256: string;
  findingSetSha256: string;
  state: string;
  coverage: string;
  recipients: number;
  addressRecipients: number;
  trackingRecipients: number;
  usesAnonRpc: boolean;
  scannerVersion: string;
  reportVersion: string;
  report: Uint8Array;
}

export interface EvidenceValues {
  sha256: string;
  scanId: string;
  bundleVersion: string;
  bundle: Uint8Array;
}

export interface FlowValues {
  hostname: string;
  recipient: string;
  class: string;
  verdict: string;
  address: string;
  preConnect: boolean;
  version: number;
  scanId: string;
  scannedAt: number;
}

/** A validated publication, before a version number is assigned. */
export interface Publication {
  hostname: string;
  scan: Omit<ScanValues, 'version' | 'previous'>;
  evidence: EvidenceValues;
  flows: Array<Omit<FlowValues, 'version'>>;
  /**
   * Recipients that get NO igris.flow.v1 entity because their domain is not
   * a publishable hostname (an IP literal such as "[2606:4700::1111]", or
   * one longer than the str limit). They are still in the published report
   * and counted in the scan's `recipients`; only the cross-site index skips
   * them.
   */
  unindexedRecipients: string[];
}

/** The entity values of one version, ready to write. */
export interface VersionedPublication {
  scan: ScanValues;
  evidence: EvidenceValues;
  flows: FlowValues[];
}

/** Did the recipient receive anything (a contact or the address) before connect? */
export function flowPreConnect(r: Recipient): boolean {
  return r.learned.ip.includes('pre-connect') || r.learned.addressPhases.includes('pre-connect');
}

function refuse(reason: string): never {
  throw new PublishRefusedError(reason);
}

/**
 * Validate a report + bundle for publishing and compute every attribute.
 * Throws PublishRefusedError with the reason when it must not be published.
 */
export function buildPublication(report: ReportV3, bundle: EvidenceBundle): Publication {
  if ((report as { reportVersion?: unknown })?.reportVersion !== REPORT_V3_VERSION) {
    refuse(
      `only Report ${REPORT_V3_VERSION} is published (got ${String((report as { reportVersion?: unknown })?.reportVersion)})`,
    );
  }
  try {
    validateReport(report);
  } catch (err) {
    refuse(`report fails schema validation: ${(err as Error).message}`);
  }
  try {
    validateEvidenceBundle(bundle);
  } catch (err) {
    refuse(`evidence bundle fails schema validation: ${(err as Error).message}`);
  }
  if (report.privacy.coverage === 'none') {
    refuse(
      'the page never loaded (coverage "none"): a scan that observed nothing is not a version',
    );
  }
  const integrity = verifyReportIntegrity(report, bundle);
  if (!integrity.ok) {
    refuse(
      `report fails integrity against its evidence: ${integrity.problems.slice(0, 5).join('; ')}`,
    );
  }
  try {
    assertCanaryFree(bundle, buildCanaryForms(report.scan.canaryAddress));
  } catch (err) {
    refuse((err as Error).message);
  }
  const hostname = report.scan.hostname;
  if (!isHostname(hostname)) {
    refuse(
      `hostname ${JSON.stringify(String(hostname).slice(0, 200))} is not a publishable hostname (≤ ${MAX_STR_BYTES} bytes)`,
    );
  }
  for (const [name, v] of [
    ['scannerVersion', report.scan.scannerVersion],
    ['reportVersion', report.reportVersion],
  ] as const) {
    if (utf8Length(v) > MAX_STR_BYTES) refuse(`${name} exceeds ${MAX_STR_BYTES} bytes`);
  }
  const ms = Date.parse(report.scan.scannedAt);
  if (!Number.isFinite(ms) || ms <= 0) refuse('report.scan.scannedAt is not a valid date');
  const scannedAt = Math.floor(ms / 1000);

  const scanId = contentHash(report);
  const evidenceSha256 = bundleHash(bundle);
  const summary = summarise(report, bundle);
  const recipients = report.recipients;

  const scan: Publication['scan'] = {
    hostname,
    scannedAt,
    scanId,
    evidenceSha256,
    findingSetSha256: report.findingSet.sha256,
    state: summary.state,
    coverage: report.privacy.coverage,
    recipients: recipients.length,
    addressRecipients: recipients.filter((r) => addressReceived(r.learned.address)).length,
    trackingRecipients: recipients.filter(
      (r) => r.verdict === 'tracking' || r.verdict === 'unidentified',
    ).length,
    usesAnonRpc: report.wallet.usesAnonRpc,
    scannerVersion: report.scan.scannerVersion,
    reportVersion: report.reportVersion,
    report: encodePayload(report, 'report'),
  };
  const evidence: EvidenceValues = {
    sha256: evidenceSha256,
    scanId,
    bundleVersion: bundle.bundleVersion,
    bundle: encodePayload(bundle, 'evidence bundle'),
  };
  // A recipient whose domain is not a hostname (an IP literal, an over-long
  // name) cannot be a flow's indexed `recipient` str; the scan is still
  // published and the full report lists it. Only its flow entity is omitted.
  const indexed = recipients.filter((r) => isHostname(r.registrableDomain));
  const unindexedRecipients = recipients
    .filter((r) => !isHostname(r.registrableDomain))
    .map((r) => String(r.registrableDomain));
  const flows = indexed.map((r) => ({
    hostname,
    recipient: r.registrableDomain,
    class: r.class,
    verdict: r.verdict,
    address: r.learned.address,
    preConnect: flowPreConnect(r),
    scanId,
    scannedAt,
  }));
  return { hostname, scan, evidence, flows, unindexedRecipients };
}

/** Assign the version number and the previous version's key. */
export function withVersion(
  pub: Publication,
  version: number,
  previous: string | null,
): VersionedPublication {
  return {
    scan: { ...pub.scan, version, previous: previous ?? '' },
    evidence: pub.evidence,
    flows: pub.flows.map((f) => ({ ...f, version })),
  };
}

// ---------------------------------------------------------------------------
// Wire form: the JSON-RPC shape Arkiv returns entities in, and the shape the
// local registry stores. One decoder (rows.ts) reads both.
// ---------------------------------------------------------------------------

export interface WireAttribute {
  name: string;
  type: string;
  value: unknown;
}

export interface WireEntity {
  key: string;
  owner: string;
  /** Immutable signer of the create (Arkiv `$creator`); the trust identity. */
  creator: string;
  expiresAt: string | null;
  attributes: WireAttribute[];
}

/** Attributes of `values` written through `schema`, as Arkiv returns them (plus the schema tag). */
export function toWireAttributes(schema: IgrisSchema, values: object): WireAttribute[] {
  const record = values as Record<string, unknown>;
  const out: WireAttribute[] = [
    { name: SCHEMA_ATTRIBUTE, type: 'str', value: schema.name as string },
  ];
  for (const [name, column] of Object.entries(schema.columns) as Array<
    [string, { type: string }]
  >) {
    const v = record[name];
    if (v === undefined) throw new Error(`missing value for ${name}`);
    out.push({
      name,
      type: column.type,
      value:
        column.type === 'bytes'
          ? bytesToHex(v as Uint8Array)
          : column.type === 'u64'
            ? String(v)
            : v,
    });
  }
  return out;
}
