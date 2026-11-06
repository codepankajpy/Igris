/**
 * Strict validation of registry data. Browser-safe: no Node imports.
 *
 * Registry rows are UNTRUSTED INPUT. Arkiv is permissionless, so anyone can
 * write an entity tagged `igris.scan.v1` with any attribute values and any
 * summary bytes. Every row is validated against the exact shape we publish
 * before any consumer (CLI, viewer, extension) touches it. Invalid rows are
 * dropped and counted, never thrown: one malformed entity must not deny
 * service to every viewer.
 *
 * Validation narrows types and bounds sizes. It does NOT make strings safe
 * to put into HTML (free-text labels stay free text), so renderers must
 * still escape every value.
 */
import type { RegistryRecord, SummaryPayload } from './record.js';

/**
 * Closed sets mirrored from @igris/core (which cannot be imported at runtime
 * here: its index pulls in node:fs). A unit test asserts they stay identical.
 */
export const KNOWN_RECIPIENT_CLASSES = [
  'first-party',
  'rpc-provider',
  'analytics',
  'error-monitoring',
  'support-chat',
  'walletconnect-relay',
  'ipfs-gateway',
  'cdn',
  'anon-rpc',
  'unknown-third-party',
] as const;
export const KNOWN_LEAK_LOCATIONS = [
  'url',
  'request-header',
  'request-body',
  'response-set-cookie',
  'websocket-frame',
  'cookie',
  'local-storage',
  'session-storage',
] as const;
export const KNOWN_STATUSES = ['completed', 'page-load-failed', 'wallet-connect-failed'] as const;
const COVERAGES = ['full', 'pre-connect-only', 'none'] as const;
const CATEGORIES = ['exact', 'hashed', 'partial'] as const;
const PHASES = ['pre-connect', 'post-connect'] as const;

const LIMITS = {
  findings: 2000,
  thirdParties: 2000,
  ledger: 200,
  readsViaWallet: 200,
  connectionLog: 50,
  label: 500,
  logLine: 400,
} as const;

/** Why a row was rejected (first failing path), for diagnostics. */
export class InvalidRecordError extends Error {
  constructor(public readonly path: string) {
    super(`invalid registry record at ${path}`);
    this.name = 'InvalidRecordError';
  }
}

type Obj = Record<string, unknown>;

function fail(path: string): never {
  throw new InvalidRecordError(path);
}
function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path);
  return v as Obj;
}
function arr(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) fail(path);
  return v;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path);
  return v;
}
function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(path);
  return v;
}
function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(path);
  return v;
}
function str(v: unknown, path: string, max: number, pattern?: RegExp): string {
  if (typeof v !== 'string' || v.length > max) fail(path);
  if (pattern && !pattern.test(v)) fail(path);
  return v;
}
function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) fail(path);
  return v as T;
}

/** DNS hostname, IPv4, or bracket-free IPv6 literal. No spaces, no markup. */
const HOST_RE =
  /^[a-z0-9]([a-z0-9-]{0,62})?(\.[a-z0-9]([a-z0-9-]{0,62})?)*\.?$|^[0-9a-f:.]{2,45}$/i;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ENTITY_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const ENCODING_RE = /^[A-Za-z0-9()+_.-]{1,64}$/;
const RULE_RE = /^[A-Za-z0-9._ ×*-]{1,64}$/;
const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HTTP_METHOD_RE = /^[A-Z]{1,10}$/;

function optional<T>(o: Obj, k: string, f: (v: unknown) => T): T | undefined {
  return o[k] === undefined ? undefined : f(o[k]);
}

export function parseSummaryPayload(input: unknown): SummaryPayload {
  const o = obj(input, 'summary');
  const findings = arr(o.findings, 'summary.findings', LIMITS.findings).map((f, i) => {
    const p = `summary.findings[${i}]`;
    const fo = obj(f, p);
    return {
      class: oneOf(fo.class, `${p}.class`, KNOWN_RECIPIENT_CLASSES),
      location: oneOf(fo.location, `${p}.location`, KNOWN_LEAK_LOCATIONS),
      encoding: str(fo.encoding, `${p}.encoding`, 64, ENCODING_RE),
      category: oneOf(fo.category, `${p}.category`, CATEGORIES),
      host: str(fo.host, `${p}.host`, 253, HOST_RE),
      phase: oneOf(fo.phase, `${p}.phase`, PHASES),
      counted: bool(fo.counted, `${p}.counted`),
    };
  });
  const thirdParties = arr(o.thirdParties, 'summary.thirdParties', LIMITS.thirdParties).map(
    (t, i) => {
      const p = `summary.thirdParties[${i}]`;
      const to = obj(t, p);
      const requestCount = optional(to, 'requestCount', (v) =>
        int(v, `${p}.requestCount`, 0, 1_000_000),
      );
      const methods = optional(to, 'methods', (v) =>
        arr(v, `${p}.methods`, 16).map((m, j) => str(m, `${p}.methods[${j}]`, 10, HTTP_METHOD_RE)),
      );
      return {
        host: str(to.host, `${p}.host`, 253, HOST_RE),
        class: oneOf(to.class, `${p}.class`, KNOWN_RECIPIENT_CLASSES),
        phases: arr(to.phases, `${p}.phases`, 2).map((ph, j) =>
          oneOf(ph, `${p}.phases[${j}]`, PHASES),
        ),
        ...(requestCount !== undefined ? { requestCount } : {}),
        ...(methods !== undefined ? { methods } : {}),
      };
    },
  );
  const ledger = arr(o.ledger, 'summary.ledger', LIMITS.ledger).map((l, i) => {
    const p = `summary.ledger[${i}]`;
    const lo = obj(l, p);
    return {
      rule: str(lo.rule, `${p}.rule`, 64, RULE_RE),
      points: num(lo.points, `${p}.points`, 0, 100),
      label: str(lo.label, `${p}.label`, LIMITS.label),
    };
  });
  const readsViaWallet = arr(o.readsViaWallet, 'summary.readsViaWallet', LIMITS.readsViaWallet).map(
    (r, i) => {
      const p = `summary.readsViaWallet[${i}]`;
      const ro = obj(r, p);
      return {
        method: str(ro.method, `${p}.method`, 64, METHOD_RE),
        count: int(ro.count, `${p}.count`, 0, 1_000_000),
      };
    },
  );
  const telemetry = optional(o, 'telemetry', (v) => {
    const t = obj(v, 'summary.telemetry');
    const wsFrames = optional(t, 'wsFrames', (x) =>
      int(x, 'summary.telemetry.wsFrames', 0, 10_000_000),
    );
    return {
      totalRequests: int(t.totalRequests, 'summary.telemetry.totalRequests', 0, 10_000_000),
      preConnectRequests: int(
        t.preConnectRequests,
        'summary.telemetry.preConnectRequests',
        0,
        10_000_000,
      ),
      postConnectRequests: int(
        t.postConnectRequests,
        'summary.telemetry.postConnectRequests',
        0,
        10_000_000,
      ),
      wsConnections: int(t.wsConnections, 'summary.telemetry.wsConnections', 0, 10_000_000),
      ...(wsFrames !== undefined ? { wsFrames } : {}),
    };
  });
  // Security headers are only meaningful when tied to the main document.
  // Records written before report 1.1.0 computed them from REQUEST headers
  // (always "missing") — those carry no `source` and are discarded as
  // unknown rather than shown as a finding.
  const securityHeaders = optional(o, 'securityHeaders', (v) => {
    const h = obj(v, 'summary.securityHeaders');
    if (h.source !== 'main-document') return undefined;
    const xfo = optional(h, 'xFrameOptions', (x) =>
      str(x, 'summary.securityHeaders.xFrameOptions', 200),
    );
    const cspReportOnly = optional(h, 'cspReportOnly', (x) =>
      bool(x, 'summary.securityHeaders.cspReportOnly'),
    );
    const documentStatus = optional(h, 'documentStatus', (x) =>
      int(x, 'summary.securityHeaders.documentStatus', 100, 599),
    );
    return {
      source: 'main-document' as const,
      ...(documentStatus !== undefined ? { documentStatus } : {}),
      cspPresent: bool(h.cspPresent, 'summary.securityHeaders.cspPresent'),
      ...(cspReportOnly !== undefined ? { cspReportOnly } : {}),
      hstsPresent: bool(h.hstsPresent, 'summary.securityHeaders.hstsPresent'),
      ...(xfo !== undefined ? { xFrameOptions: xfo } : {}),
    };
  });
  const connectionLog = optional(o, 'connectionLog', (v) =>
    arr(v, 'summary.connectionLog', LIMITS.connectionLog).map((l, i) =>
      str(l, `summary.connectionLog[${i}]`, LIMITS.logLine),
    ),
  );
  const coverage = optional(o, 'coverage', (v) => oneOf(v, 'summary.coverage', COVERAGES));
  const evidenceSha256 = optional(o, 'evidenceSha256', (v) =>
    str(v, 'summary.evidenceSha256', 64, SHA256_RE),
  );
  const canaryAddress = str(o.canaryAddress, 'summary.canaryAddress', 42);
  if (canaryAddress !== '' && !ADDRESS_RE.test(canaryAddress)) fail('summary.canaryAddress');

  return {
    v: int(o.v, 'summary.v', 0, 1000),
    status: oneOf(o.status, 'summary.status', KNOWN_STATUSES),
    ...(coverage !== undefined ? { coverage } : {}),
    spoofMetaMask: bool(o.spoofMetaMask, 'summary.spoofMetaMask'),
    canaryAddress,
    ...(evidenceSha256 !== undefined ? { evidenceSha256 } : {}),
    findings,
    thirdParties,
    ledger,
    readsViaWallet,
    ...(telemetry !== undefined ? { telemetry } : {}),
    ...(securityHeaders !== undefined ? { securityHeaders } : {}),
    ...(connectionLog !== undefined ? { connectionLog } : {}),
  };
}

export interface ParseRecordOptions {
  /** 'arkiv': id must be an entity key and scanner an address. */
  source: 'arkiv' | 'local';
}

/** Validate a full registry record (attributes + summary). Throws InvalidRecordError. */
export function parseRegistryRecord(input: unknown, opts: ParseRecordOptions): RegistryRecord {
  const o = obj(input, 'record');
  const id =
    opts.source === 'arkiv'
      ? str(o.id, 'id', 66, ENTITY_KEY_RE)
      : str(o.id, 'id', 256, /^[A-Za-z0-9._:-]+$/);
  const scanner =
    opts.source === 'arkiv'
      ? str(o.scanner, 'scanner', 42, ADDRESS_RE)
      : str(o.scanner, 'scanner', 42, /^(local|0x[0-9a-fA-F]{40})$/);
  const leakClasses = str(o.leakClasses, 'leakClasses', 256);
  if (leakClasses !== '') {
    for (const c of leakClasses.split(',')) oneOf(c, 'leakClasses', KNOWN_RECIPIENT_CLASSES);
  }
  const expiresAt = optional(o, 'expiresAt', (v) =>
    str(v, 'expiresAt', 64, /^(block \d{1,20}|\d{4}-\d{2}-\d{2}T[0-9:.]+Z)$/),
  );
  return {
    id,
    scanner,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    hostname: str(o.hostname, 'hostname', 253, HOST_RE),
    score: int(o.score, 'score', 0, 100),
    scannedAt: int(o.scannedAt, 'scannedAt', 0, Number.MAX_SAFE_INTEGER),
    scannerVersion: str(o.scannerVersion, 'scannerVersion', 32, VERSION_RE),
    reportVersion: str(o.reportVersion, 'reportVersion', 32, VERSION_RE),
    chainId: int(o.chainId, 'chainId', 0, Number.MAX_SAFE_INTEGER),
    thirdPartyCount: int(o.thirdPartyCount, 'thirdPartyCount', 0, 1_000_000),
    leakCount: int(o.leakCount, 'leakCount', 0, 1_000_000),
    leakClasses,
    usesAnonRpc: bool(o.usesAnonRpc, 'usesAnonRpc'),
    reportSha256: str(o.reportSha256, 'reportSha256', 64, SHA256_RE),
    summary: parseSummaryPayload(o.summary),
  };
}

export interface ValidatedRecords {
  records: RegistryRecord[];
  /** Rows dropped because they failed validation. */
  dropped: number;
  /** First few rejection paths (diagnostics; never rendered as HTML). */
  reasons: string[];
}

/** Validate many rows, keeping the valid ones. Never throws. */
export function validateRecords(rows: unknown[], opts: ParseRecordOptions): ValidatedRecords {
  const records: RegistryRecord[] = [];
  const reasons: string[] = [];
  let dropped = 0;
  for (const row of rows) {
    try {
      records.push(parseRegistryRecord(row, opts));
    } catch (err) {
      dropped += 1;
      if (reasons.length < 5) {
        reasons.push(err instanceof InvalidRecordError ? err.path : 'unparseable');
      }
    }
  }
  return { records, dropped, reasons };
}
