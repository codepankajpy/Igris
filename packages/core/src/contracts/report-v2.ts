/**
 * Report v2 (`reportVersion: "2.0.0"`) — detector-agnostic.
 *
 * Structure:
 *  - `scan`: what was scanned, when, by which scanner build, and how far the
 *    scan got (status). Contains the throwaway canary address.
 *  - `privacy`: the privacy score, its coverage, its ledger, and the privacy
 *    findings it is computed from. Nothing else affects the score.
 *  - `security`: security observations. They are a separate type that can
 *    never count toward the privacy score (enforced in the type and at runtime).
 *  - `contacts` / `wallet` / `telemetry`: volatile measurements (request
 *    counts etc.) that describe the scan but are not evidence.
 *  - `evidence`: the hash of the evidence bundle every finding points into.
 *
 * Versioning policy (docs/CONTRACTS.md): additive optional fields → minor
 * bump; anything else → major bump with a migration function.
 *
 * Browser-safe.
 */
import type {
  PenaltyLine,
  ScanCoverage,
  ScanStatus,
  ThirdPartyContact,
  WalletRead,
} from '../report.js';
import { RECIPIENT_CLASSES } from '../report.js';
import type { EvidenceRef } from './evidence.js';
import { EVIDENCE_BUNDLE_VERSION, EVIDENCE_TYPES } from './evidence.js';
import { CANONICALIZATION } from './hash.js';

export const REPORT_V2_VERSION = '2.0.0' as const;

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** How sure we are that the finding is TRUE (not how bad it is). */
export type Confidence = 'confirmed' | 'likely' | 'possible';
export const CONFIDENCES: readonly Confidence[] = ['confirmed', 'likely', 'possible'];

/**
 * What the finding is:
 *  - issue: a confirmed problem (e.g. the address provably reached a tracker);
 *  - risk: a condition that enables harm but is not itself harm observed
 *    (e.g. no CSP);
 *  - observation: informational, no action implied (e.g. the address is kept
 *    in the page's own localStorage).
 */
export type FindingKind = 'issue' | 'risk' | 'observation';
export const FINDING_KINDS: readonly FindingKind[] = ['issue', 'risk', 'observation'];

export type FindingDomain = 'privacy' | 'security';

export interface FindingV2 {
  /** "F-" + first 16 hex of the fingerprint. Stable across scans of the same behaviour. */
  id: string;
  /** sha256 (64 hex) of the canonical identity {detector, …identity fields}. */
  fingerprint: string;
  detector: string;
  detectorVersion: string;
  domain: FindingDomain;
  kind: FindingKind;
  severity: Severity;
  confidence: Confidence;
  title: string;
  impact: string;
  remediation: string;
  /** ≥ 1 reference into the evidence bundle. */
  evidence: EvidenceRef[];
  countsTowardPrivacyScore: boolean;
}

export interface PrivacyFinding extends FindingV2 {
  domain: 'privacy';
}

/** Security observations never count toward the privacy score (type-level). */
export interface SecurityObservation extends FindingV2 {
  domain: 'security';
  countsTowardPrivacyScore: false;
}

export interface ScanMetaV2 {
  target: string;
  hostname: string;
  scannedAt: string;
  chainId: number;
  status: ScanStatus;
  scannerVersion: string;
  spoofMetaMask: boolean;
  /** The throwaway canary address of this scan (never in the evidence bundle). */
  canaryAddress: string;
  /** Network egress policy the scan ran under ("unknown" for migrated pre-P0 reports). */
  egress: 'unrestricted' | 'public-only' | 'unknown';
  connectionLog: string[];
  /** Scan notes and errors (human-readable). */
  notes: string[];
}

export interface DetectorRun {
  id: string;
  version: string;
  domain: FindingDomain;
}

export interface TelemetryV2 {
  totalRequests: number;
  preConnectRequests: number;
  postConnectRequests: number;
  /** null = not recorded (reports migrated from 1.0.0 mis-counted this field). */
  wsConnections: number | null;
  /** null = not recorded. */
  wsFrames: number | null;
  cookiesCount: number;
  localStorageCount: number;
  sessionStorageCount: number;
}

export interface EvidenceSummary {
  bundleVersion: typeof EVIDENCE_BUNDLE_VERSION;
  canonicalization: typeof CANONICALIZATION;
  /** sha256 (64 hex) of the canonical bundle. */
  sha256: string;
  itemCount: number;
}

export interface ReportV2 {
  reportVersion: typeof REPORT_V2_VERSION;
  scan: ScanMetaV2;
  detectors: DetectorRun[];
  privacy: {
    /** 0–100, or null when nothing was measured (coverage "none"). */
    score: number | null;
    coverage: ScanCoverage;
    ledger: PenaltyLine[];
    findings: PrivacyFinding[];
  };
  security: {
    observations: SecurityObservation[];
  };
  contacts: ThirdPartyContact[];
  wallet: {
    readsViaWallet: WalletRead[];
    usesAnonRpc: boolean;
  };
  /** null when the source report recorded no telemetry (migrated reports). */
  telemetry: TelemetryV2 | null;
  evidence: EvidenceSummary;
  /** Present when this report was produced by migrating an older one. */
  migratedFrom?: string;
}

// ---------------------------------------------------------------------------
// Key lists — compile-time checked for exhaustiveness (contracts.test.ts) and
// runtime-checked against the JSON Schema below, in both directions.
// ---------------------------------------------------------------------------

export const FINDING_KEYS = [
  'id',
  'fingerprint',
  'detector',
  'detectorVersion',
  'domain',
  'kind',
  'severity',
  'confidence',
  'title',
  'impact',
  'remediation',
  'evidence',
  'countsTowardPrivacyScore',
] as const;
export const SCAN_META_KEYS = [
  'target',
  'hostname',
  'scannedAt',
  'chainId',
  'status',
  'scannerVersion',
  'spoofMetaMask',
  'canaryAddress',
  'egress',
  'connectionLog',
  'notes',
] as const;
export const TELEMETRY_KEYS = [
  'totalRequests',
  'preConnectRequests',
  'postConnectRequests',
  'wsConnections',
  'wsFrames',
  'cookiesCount',
  'localStorageCount',
  'sessionStorageCount',
] as const;
export const REPORT_V2_KEYS = [
  'reportVersion',
  'scan',
  'detectors',
  'privacy',
  'security',
  'contacts',
  'wallet',
  'telemetry',
  'evidence',
  'migratedFrom',
] as const;
export const REPORT_V2_REQUIRED = REPORT_V2_KEYS.filter((k) => k !== 'migratedFrom');

const SHA256 = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;
const COUNT = { type: 'integer', minimum: 0 } as const;
const TEXT = (max: number) => ({ type: 'string', minLength: 1, maxLength: max }) as const;

const findingSchema = (domain: FindingDomain) =>
  ({
    type: 'object',
    additionalProperties: false,
    required: [...FINDING_KEYS],
    properties: {
      id: { type: 'string', pattern: '^F-[0-9a-f]{16}$' },
      fingerprint: SHA256,
      detector: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
      detectorVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
      domain: { const: domain },
      kind: { enum: [...FINDING_KINDS] },
      severity: { enum: [...SEVERITIES] },
      confidence: { enum: [...CONFIDENCES] },
      title: TEXT(200),
      impact: TEXT(2000),
      remediation: TEXT(2000),
      evidence: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'type'],
          properties: {
            id: { type: 'string', pattern: '^ev_[0-9a-f]{24}$' },
            type: { enum: [...EVIDENCE_TYPES] },
          },
        },
      },
      countsTowardPrivacyScore: domain === 'security' ? { const: false } : { type: 'boolean' },
    },
  }) as const;

export const REPORT_V2_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://igris.dev/schemas/report-2.0.0.json',
  title: 'IGRIS scan report v2',
  type: 'object',
  additionalProperties: false,
  required: REPORT_V2_REQUIRED,
  properties: {
    reportVersion: { const: REPORT_V2_VERSION },
    scan: {
      type: 'object',
      additionalProperties: false,
      required: [...SCAN_META_KEYS],
      properties: {
        target: { type: 'string', pattern: '^https?://' },
        hostname: { type: 'string', minLength: 1, maxLength: 253 },
        scannedAt: { type: 'string', format: 'date-time' },
        chainId: COUNT,
        status: { enum: ['completed', 'page-load-failed', 'wallet-connect-failed'] },
        scannerVersion: { type: 'string', minLength: 1, maxLength: 32 },
        spoofMetaMask: { type: 'boolean' },
        canaryAddress: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
        egress: { enum: ['unrestricted', 'public-only', 'unknown'] },
        connectionLog: { type: 'array', items: { type: 'string' } },
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
    detectors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'version', 'domain'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
          version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
          domain: { enum: ['privacy', 'security'] },
        },
      },
    },
    privacy: {
      type: 'object',
      additionalProperties: false,
      required: ['score', 'coverage', 'ledger', 'findings'],
      properties: {
        score: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 0, maximum: 100 }] },
        coverage: { enum: ['full', 'pre-connect-only', 'none'] },
        ledger: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'label', 'points', 'rule', 'findingIds'],
            properties: {
              id: { type: 'string', pattern: '^p\\d+$' },
              label: { type: 'string' },
              points: { type: 'number', minimum: 0 },
              rule: { type: 'string' },
              findingIds: { type: 'array', items: { type: 'string', pattern: '^F-[0-9a-f]{16}$' } },
            },
          },
        },
        findings: { type: 'array', items: findingSchema('privacy') },
      },
    },
    security: {
      type: 'object',
      additionalProperties: false,
      required: ['observations'],
      properties: { observations: { type: 'array', items: findingSchema('security') } },
    },
    contacts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['host', 'registrableDomain', 'class', 'phases', 'requestCount'],
        properties: {
          host: { type: 'string' },
          registrableDomain: { type: 'string' },
          class: { enum: [...RECIPIENT_CLASSES] },
          phases: { type: 'array', items: { enum: ['pre-connect', 'post-connect'] } },
          requestCount: COUNT,
          methods: { type: 'array', items: { type: 'string' } },
          resourceTypes: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    wallet: {
      type: 'object',
      additionalProperties: false,
      required: ['readsViaWallet', 'usesAnonRpc'],
      properties: {
        readsViaWallet: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['method', 'count'],
            properties: { method: { type: 'string' }, count: COUNT },
          },
        },
        usesAnonRpc: { type: 'boolean' },
      },
    },
    telemetry: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: [...TELEMETRY_KEYS],
          properties: Object.fromEntries(
            TELEMETRY_KEYS.map((k) => [
              k,
              k === 'wsConnections' || k === 'wsFrames'
                ? { anyOf: [{ type: 'null' }, COUNT] }
                : COUNT,
            ]),
          ),
        },
      ],
    },
    evidence: {
      type: 'object',
      additionalProperties: false,
      required: ['bundleVersion', 'canonicalization', 'sha256', 'itemCount'],
      properties: {
        bundleVersion: { const: EVIDENCE_BUNDLE_VERSION },
        canonicalization: { const: CANONICALIZATION },
        sha256: SHA256,
        itemCount: COUNT,
      },
    },
    migratedFrom: { type: 'string', pattern: '^1\\.\\d+\\.\\d+$' },
  },
} as const;
