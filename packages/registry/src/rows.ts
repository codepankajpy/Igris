/**
 * Strict decoding of registry rows. Rows are UNTRUSTED INPUT: Arkiv is
 * permissionless (anyone can write an entity tagged igris.scan.v2 with any
 * values) and a local file can be edited. Every row is checked against the
 * exact shape we publish — field types, hostname / sha formats, sizes — and
 * an invalid row is SKIPPED (returns null), never thrown: one malformed
 * entity must not deny service to every reader.
 *
 * Validation narrows types and bounds sizes; it does not make strings safe
 * for HTML. Renderers must still escape every value.
 */
import {
  ADDRESS_EXPOSURES,
  RECIPIENT_V3_CLASSES,
  RECORDED_WALLET_METHODS,
  SUMMARY_STATES,
  VERDICTS,
  WALLET_REQUEST_KINDS,
  type SummaryState,
  type Verdict,
  type WalletRequestKind,
} from '@igris/core';
import { SCHEMA_ATTRIBUTE } from '@arkiv-network/sdk/schema';
import { getAddress } from 'viem';
import type { FlowEntity, PublishedScan, WalletRequestEntity } from './site-registry.js';
import {
  EVIDENCE_SCHEMA_NAME,
  FLOW_SCHEMA_NAME,
  SCAN_SCHEMA_NAME,
  WALLET_REQUEST_SCHEMA_NAME,
} from './schemas.js';

/** Arkiv's limit on a str attribute, in UTF-8 bytes. */
export const MAX_STR_BYTES = 128;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const ARKIV_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
export const ARKIV_OWNER_RE = /^0x[0-9a-fA-F]{40}$/;
export const LOCAL_KEY_RE = /^local:[0-9a-f]{64}$/;
export const LOCAL_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

const MAX_COUNT = 100_000;
export const MAX_UNIX = 2 ** 40;
const I32_MAX = 2_147_483_647;
const PUBLISHED_STATES = SUMMARY_STATES.filter((s) => s !== 'not-observed');

export function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Lower-case DNS hostname with at least two labels, ≤ 128 bytes (Arkiv str limit). */
export function isHostname(v: unknown): v is string {
  return typeof v === 'string' && v.length <= MAX_STR_BYTES && HOSTNAME_RE.test(v);
}

/** Readonly bit of Arkiv's `creationFlags` byte. */
export const READONLY_FLAG = 1;

/** Wallet request kinds that get an igris.walletreq.v1 entity (all but "connect"). */
export const PUBLISHED_WALLET_REQUEST_KINDS = WALLET_REQUEST_KINDS.filter(
  (k): k is Exclude<WalletRequestKind, 'connect'> => k !== 'connect',
);
export const WALLET_REQUEST_OUTCOMES = ['answered', 'signed', 'rejected', 'error'] as const;

/** A checksummed 20-byte address (EIP-55), exactly as getAddress() writes it. */
export function isChecksummedAddress(v: unknown): v is string {
  if (typeof v !== 'string' || !ARKIV_OWNER_RE.test(v)) return false;
  try {
    return getAddress(v) === v;
  } catch {
    return false;
  }
}

/** Formats of keys and owners for one backend. */
export interface RowFormat {
  key: RegExp;
  owner: RegExp;
}
export const ARKIV_FORMAT: RowFormat = { key: ARKIV_KEY_RE, owner: ARKIV_OWNER_RE };
export const LOCAL_FORMAT: RowFormat = { key: LOCAL_KEY_RE, owner: LOCAL_OWNER_RE };

class Invalid extends Error {}
const bad = (what: string): never => {
  throw new Invalid(what);
};

type Attrs = Map<string, { type: unknown; value: unknown }>;

function attrsOf(entity: unknown): Attrs {
  const list = (entity as { attributes?: unknown } | null)?.attributes;
  if (!Array.isArray(list) || list.length > 64) bad('attributes');
  const map: Attrs = new Map();
  for (const a of list as unknown[]) {
    if (typeof a !== 'object' || a === null) bad('attribute');
    const { name, type, value } = a as { name?: unknown; type?: unknown; value?: unknown };
    if (typeof name !== 'string' || map.has(name)) bad('attribute name');
    map.set(name as string, { type, value });
  }
  return map;
}

function str(attrs: Attrs, name: string, max = MAX_STR_BYTES): string {
  const a = attrs.get(name);
  if (!a || a.type !== 'str' || typeof a.value !== 'string' || utf8Length(a.value) > max) bad(name);
  return a!.value as string;
}

function integerish(v: unknown): number {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'bigint' && v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= 0n) return Number(v);
  if (typeof v === 'string' && /^(0x[0-9a-fA-F]{1,16}|\d{1,16})$/.test(v)) {
    const n = Number(BigInt(v));
    if (Number.isSafeInteger(n)) return n;
  }
  return NaN;
}

function int(attrs: Attrs, name: string, type: 'i32' | 'u64', min: number, max: number): number {
  const a = attrs.get(name);
  if (!a || a.type !== type) bad(name);
  const n = integerish(a!.value);
  if (!Number.isSafeInteger(n) || n < min || n > max) bad(name);
  return n;
}

function boolean(attrs: Attrs, name: string): boolean {
  const a = attrs.get(name);
  if (!a || a.type !== 'bool' || typeof a.value !== 'boolean') bad(name);
  return a!.value as boolean;
}

function oneOf<T extends string>(attrs: Attrs, name: string, allowed: readonly T[]): T {
  const v = str(attrs, name);
  if (!(allowed as readonly string[]).includes(v)) bad(name);
  return v as T;
}

function sha(attrs: Attrs, name: string): string {
  const v = str(attrs, name);
  if (!SHA256_RE.test(v)) bad(name);
  return v;
}

function hostname(attrs: Attrs, name: string): string {
  const v = str(attrs, name);
  if (!isHostname(v)) bad(name);
  return v;
}

function meta(
  entity: unknown,
  schemaName: string,
  format: RowFormat,
): {
  key: string;
  owner: string;
  expiresAtBlock: number | null;
  attrs: Attrs;
} {
  if (typeof entity !== 'object' || entity === null) bad('entity');
  const e = entity as {
    key?: unknown;
    owner?: unknown;
    creator?: unknown;
    expiresAt?: unknown;
  };
  if (typeof e.key !== 'string' || !format.key.test(e.key)) bad('key');
  // Trust is decided by the CREATOR, which never changes. The current owner
  // does not count: on Arkiv anyone can transfer an entity they created to
  // any address (no acceptance), so `$owner` can be forged into a trusted
  // address. The decoded `owner` field below therefore holds the creator.
  if (typeof e.creator !== 'string' || !format.owner.test(e.creator)) bad('creator');
  let expiresAtBlock: number | null = null;
  if (e.expiresAt !== undefined && e.expiresAt !== null) {
    expiresAtBlock = integerish(e.expiresAt);
    if (!Number.isSafeInteger(expiresAtBlock) || expiresAtBlock < 0) bad('expiresAt');
  }
  const attrs = attrsOf(entity);
  const tag = attrs.get(SCHEMA_ATTRIBUTE);
  if (!tag || tag.type !== 'str' || tag.value !== schemaName) bad('schema tag');
  return {
    key: e.key as string,
    owner: e.creator as string,
    expiresAtBlock,
    attrs,
  };
}

/** i32 0/1 boolean (igris.walletreq.v1). */
function flag01(attrs: Attrs, name: string): boolean {
  return int(attrs, name, 'i32', 0, 1) === 1;
}

/** "" or a checksummed address. */
function addressOrEmpty(attrs: Attrs, name: string): string {
  const v = str(attrs, name);
  if (v !== '' && !isChecksummedAddress(v)) bad(name);
  return v;
}

function guard<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    // Invalid, or anything unexpected in hostile data: the row is skipped.
    return null;
  }
}

/** Decode an igris.scan.v2 row (without its report payload); null when invalid. */
export function parseScanRow(entity: unknown, format: RowFormat): PublishedScan | null {
  return guard(() => {
    const { key, owner, expiresAtBlock, attrs } = meta(entity, SCAN_SCHEMA_NAME, format);
    const version = int(attrs, 'version', 'i32', 1, I32_MAX);
    const prevRaw = str(attrs, 'previous');
    let previous: string | null = null;
    if (version === 1) {
      if (prevRaw !== '') bad('previous');
    } else {
      if (!format.key.test(prevRaw) || prevRaw === key) bad('previous');
      previous = prevRaw;
    }
    const recipients = int(attrs, 'recipients', 'i32', 0, MAX_COUNT);
    const addressRecipients = int(attrs, 'addressRecipients', 'i32', 0, recipients);
    const trackingRecipients = int(attrs, 'trackingRecipients', 'i32', 0, recipients);
    const reportVersion = str(attrs, 'reportVersion');
    if (reportVersion !== '3.0.0') bad('reportVersion');
    // A `request` attribute (on entities of an earlier multi-node release)
    // is ignored, whatever it holds: it is not part of the version.
    const scan: PublishedScan = {
      key,
      owner,
      hostname: hostname(attrs, 'hostname'),
      version,
      previous,
      scannedAt: int(attrs, 'scannedAt', 'u64', 1, MAX_UNIX),
      scanId: sha(attrs, 'scanId'),
      evidenceSha256: sha(attrs, 'evidenceSha256'),
      findingSetSha256: sha(attrs, 'findingSetSha256'),
      state: oneOf(attrs, 'state', PUBLISHED_STATES) as SummaryState,
      coverage: oneOf(attrs, 'coverage', ['full', 'pre-connect-only'] as const),
      recipients,
      addressRecipients,
      trackingRecipients,
      usesAnonRpc: boolean(attrs, 'usesAnonRpc'),
      scannerVersion: str(attrs, 'scannerVersion'),
      reportVersion,
      expiresAtBlock,
    };
    return scan;
  });
}

/** The report payload of a scan row (0x hex), when the row carries it. */
export function scanReportPayload(entity: unknown): string | null {
  return guard(() => {
    const a = attrsOf(entity).get('report');
    if (!a || a.type !== 'bytes' || typeof a.value !== 'string') bad('report');
    return a!.value as string;
  });
}

export interface EvidenceRow {
  key: string;
  owner: string;
  sha256: string;
  scanId: string;
  bundleVersion: string;
  /** 0x hex gzip payload. */
  bundle: string;
}

/** Decode an igris.evidence.v1 row; null when invalid. */
export function parseEvidenceRow(entity: unknown, format: RowFormat): EvidenceRow | null {
  return guard(() => {
    const { key, owner, attrs } = meta(entity, EVIDENCE_SCHEMA_NAME, format);
    const b = attrs.get('bundle');
    if (
      !b ||
      b.type !== 'bytes' ||
      typeof b.value !== 'string' ||
      !/^0x[0-9a-fA-F]*$/.test(b.value)
    )
      bad('bundle');
    return {
      key,
      owner,
      sha256: sha(attrs, 'sha256'),
      scanId: sha(attrs, 'scanId'),
      bundleVersion: str(attrs, 'bundleVersion'),
      bundle: b!.value as string,
    };
  });
}

/** Decode an igris.flow.v1 row; null when invalid. */
export function parseFlowRow(entity: unknown, format: RowFormat): FlowEntity | null {
  return guard(() => {
    const { key, owner, attrs } = meta(entity, FLOW_SCHEMA_NAME, format);
    return {
      key,
      owner,
      hostname: hostname(attrs, 'hostname'),
      recipient: hostname(attrs, 'recipient'),
      class: oneOf(attrs, 'class', RECIPIENT_V3_CLASSES),
      verdict: oneOf(attrs, 'verdict', VERDICTS) as Verdict,
      address: oneOf(attrs, 'address', ADDRESS_EXPOSURES),
      preConnect: boolean(attrs, 'preConnect'),
      version: int(attrs, 'version', 'i32', 1, I32_MAX),
      scanId: sha(attrs, 'scanId'),
      scannedAt: int(attrs, 'scannedAt', 'u64', 1, MAX_UNIX),
    };
  });
}

/** Decode an igris.walletreq.v1 row; null when invalid. */
export function parseWalletRequestRow(
  entity: unknown,
  format: RowFormat,
): WalletRequestEntity | null {
  return guard(() => {
    const { key, owner, attrs } = meta(entity, WALLET_REQUEST_SCHEMA_NAME, format);
    return {
      key,
      owner,
      hostname: hostname(attrs, 'hostname'),
      kind: oneOf(attrs, 'kind', PUBLISHED_WALLET_REQUEST_KINDS),
      method: oneOf(attrs, 'method', RECORDED_WALLET_METHODS),
      outcome: oneOf(attrs, 'outcome', WALLET_REQUEST_OUTCOMES),
      unlimited: flag01(attrs, 'unlimited'),
      chainIdMismatch: flag01(attrs, 'chainIdMismatch'),
      domainMismatch: flag01(attrs, 'domainMismatch'),
      preConnect: flag01(attrs, 'preConnect'),
      verifyingContract: addressOrEmpty(attrs, 'verifyingContract'),
      spender: addressOrEmpty(attrs, 'spender'),
      version: int(attrs, 'version', 'i32', 1, I32_MAX),
      scanId: sha(attrs, 'scanId'),
      scannedAt: int(attrs, 'scannedAt', 'u64', 1, MAX_UNIX),
    };
  });
}

/** Newest version first; ties (two owners) by newest scannedAt, then key. */
export function byVersionDesc(a: PublishedScan, b: PublishedScan): number {
  return b.version - a.version || b.scannedAt - a.scannedAt || (a.key < b.key ? -1 : 1);
}

/** Latest version per hostname, newest scannedAt first. */
export function latestPerHostname(scans: PublishedScan[], limit: number): PublishedScan[] {
  const best = new Map<string, PublishedScan>();
  for (const s of scans) {
    const cur = best.get(s.hostname);
    if (!cur || byVersionDesc(s, cur) < 0) best.set(s.hostname, s);
  }
  return [...best.values()]
    .sort((a, b) => b.scannedAt - a.scannedAt || (a.hostname < b.hostname ? -1 : 1))
    .slice(0, limit);
}

/** Owner set (lower-cased) a registry trusts on read. */
export function ownerSet(owners: readonly string[]): Set<string> {
  return new Set(owners.map((o) => o.toLowerCase()));
}

/** A per-version index row (flow, wallet request). */
export interface VersionRow {
  hostname: string;
  version: number;
  scanId: string;
  owner: string;
  scannedAt: number;
}

/** The row belongs to exactly this published version (same owner, version and scanId). */
export function isOfVersion(f: VersionRow, scan: PublishedScan): boolean {
  return (
    f.hostname === scan.hostname &&
    f.version === scan.version &&
    f.scanId === scan.scanId &&
    f.owner.toLowerCase() === scan.owner.toLowerCase()
  );
}

/** The flow belongs to exactly this published version (same owner, version and scanId). */
export function isFlowOf(f: FlowEntity, scan: PublishedScan): boolean {
  return isOfVersion(f, scan);
}

/**
 * Newest scannedAt first, ties by hostname (the order flowsTo and
 * walletRequests return, both backends; Array#sort is stable, so rows of one
 * version keep their stored order).
 */
export function byNewestFlow(a: VersionRow, b: VersionRow): number {
  return (
    b.scannedAt - a.scannedAt || (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0)
  );
}
