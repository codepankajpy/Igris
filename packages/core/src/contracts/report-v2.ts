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
import {
  EVIDENCE_BUNDLE_VERSION,
  EVIDENCE_BUNDLE_VERSION_V1,
  EVIDENCE_TYPES,
  EVIDENCE_TYPES_V1,
  type EvidenceBundleVersion,
} from './evidence.js';
import { CANONICALIZATION } from './hash.js';

/** FROZEN P0.5 report version. */
export const REPORT_V2_0_VERSION = '2.0.0' as const;
/**
 * The version new reports are written with. 2.1.0 = 2.0.0 + optional
 * scan.connection / scan.failure + evidence bundle v2 (additive; P1).
 */
export const REPORT_V2_VERSION = '2.1.0' as const;
export type ReportVersion = typeof REPORT_V2_0_VERSION | typeof REPORT_V2_VERSION;

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
  /** 2.1.0+: structured connect-phase diagnostics. */
  connection?: ConnectionDiagnostics;
  /** 2.1.0+: structured reason when the scan measured nothing. */
  failure?: ScanFailure;
}

/** Wallet-kit implementations IGRIS can identify. */
export const KIT_IDS = ['rainbowkit', 'connectkit', 'appkit', 'privy', 'dynamic'] as const;
export type KitId = (typeof KIT_IDS)[number];

/** Why a scan (or its connect phase) did not succeed. */
export const FAILURE_CATEGORIES = [
  'site-unavailable',
  'bot-blocked',
  'browser-incompatible',
  'no-connect-control',
  'modal-not-opened',
  'wallet-option-missing',
  'request-not-issued',
  'unexpected-navigation',
  'recipe-error',
  'scanner-error',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** How the connect phase went (report 2.1.0+). Diagnostics, not evidence. */
export interface ConnectionDiagnostics {
  kit: {
    id: KitId | 'none';
    confidence: 'high' | 'medium' | 'low' | 'none';
    /** Observable markers that led to the identification. */
    signals: string[];
  };
  /** kit-recipe: a kit was identified; generic: none was; recipe-file: user-supplied. */
  strategy: 'kit-recipe' | 'generic' | 'recipe-file' | 'none';
  /** e.g. "connectkit@1", "generic@1", null when nothing ran. */
  recipe: string | null;
  outcome: 'connected' | 'failed' | 'not-attempted';
  failure: { category: FailureCategory; step: string; detail: string } | null;
  steps: Array<{ step: string; result: 'ok' | 'failed' | 'skipped'; detail: string; ms: number }>;
  navigation: { urlChanges: string[]; aborted: boolean };
  /** eth_requestAccounts calls the wallet received. */
  requestAccountsCalls: number;
}

/** Page-level failure (report 2.1.0+): why there is no score. */
export interface ScanFailure {
  category: FailureCategory;
  detail: string;
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
  bundleVersion: EvidenceBundleVersion;
  canonicalization: typeof CANONICALIZATION;
  /** sha256 (64 hex) of the canonical bundle. */
  sha256: string;
  itemCount: number;
}

/**
 * Digest of WHAT was found, independent of exact evidence bytes:
 * sha256 over the canonical, sorted list of all finding fingerprints
 * (privacy + security). Two scans that observe the same behaviour have the
 * same findingSet hash even when evidence snippets differ (pages embed
 * nonces, e.g. wallet-library connection ids). Use it to compare scans
 * (re-scan confirmation, independent reproduction); use evidence.sha256 to
 * prove the exact observations.
 */
export interface FindingSetDigest {
  sha256: string;
  count: number;
}

export interface ReportV2 {
  reportVersion: ReportVersion;
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
  findingSet: FindingSetDigest;
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
/** Scan-meta keys of the FROZEN 2.0.0 schema (all required). */
export const SCAN_META_KEYS_2_0_0 = [
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
/** Scan-meta keys of the current type/schema (connection, failure optional). */
export const SCAN_META_KEYS = [...SCAN_META_KEYS_2_0_0, 'connection', 'failure'] as const;
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
  'findingSet',
  'migratedFrom',
] as const;
export const REPORT_V2_REQUIRED = REPORT_V2_KEYS.filter((k) => k !== 'migratedFrom');

const SHA256 = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;
const COUNT = { type: 'integer', minimum: 0 } as const;
const TEXT = (max: number) => ({ type: 'string', minLength: 1, maxLength: max }) as const;

const findingSchema = (domain: FindingDomain, evidenceTypes: readonly string[]) =>
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
            type: { enum: [...evidenceTypes] },
          },
        },
      },
      countsTowardPrivacyScore: domain === 'security' ? { const: false } : { type: 'boolean' },
    },
  }) as const;

/** FROZEN (P0.5). Pinned by hash in contracts.test.ts — do not edit. */
export const REPORT_SCHEMA_2_0_0 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://igris.dev/schemas/report-2.0.0.json',
  title: 'IGRIS scan report v2',
  type: 'object',
  additionalProperties: false,
  required: REPORT_V2_REQUIRED,
  properties: {
    reportVersion: { const: REPORT_V2_0_VERSION },
    scan: {
      type: 'object',
      additionalProperties: false,
      required: [...SCAN_META_KEYS_2_0_0],
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
        findings: { type: 'array', items: findingSchema('privacy', EVIDENCE_TYPES_V1) },
      },
    },
    security: {
      type: 'object',
      additionalProperties: false,
      required: ['observations'],
      properties: {
        observations: { type: 'array', items: findingSchema('security', EVIDENCE_TYPES_V1) },
      },
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
        bundleVersion: { const: EVIDENCE_BUNDLE_VERSION_V1 },
        canonicalization: { const: CANONICALIZATION },
        sha256: SHA256,
        itemCount: COUNT,
      },
    },
    findingSet: {
      type: 'object',
      additionalProperties: false,
      required: ['sha256', 'count'],
      properties: { sha256: SHA256, count: COUNT },
    },
    migratedFrom: { type: 'string', pattern: '^1\\.\\d+\\.\\d+$' },
  },
} as const;

// ---------------------------------------------------------------------------
// Report 2.1.0 — built from the frozen 2.0.0 schema by ADDITIVE changes only:
//  - reportVersion "2.1.0";
//  - scan.connection and scan.failure: new OPTIONAL properties;
//  - evidence.bundleVersion "igris.evidence.v2" and evidence refs may point
//    at contact-classification items.
// contracts.test.ts asserts that nothing else differs.
// ---------------------------------------------------------------------------

const STRING_LIST = { type: 'array', items: { type: 'string', maxLength: 500 } } as const;

export const CONNECTION_DIAGNOSTICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kit',
    'strategy',
    'recipe',
    'outcome',
    'failure',
    'steps',
    'navigation',
    'requestAccountsCalls',
  ],
  properties: {
    kit: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'confidence', 'signals'],
      properties: {
        id: { enum: [...KIT_IDS, 'none'] },
        confidence: { enum: ['high', 'medium', 'low', 'none'] },
        signals: STRING_LIST,
      },
    },
    strategy: { enum: ['kit-recipe', 'generic', 'recipe-file', 'none'] },
    recipe: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[a-z0-9-]+@\\d+$' }] },
    outcome: { enum: ['connected', 'failed', 'not-attempted'] },
    failure: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['category', 'step', 'detail'],
          properties: {
            category: { enum: [...FAILURE_CATEGORIES] },
            step: { type: 'string', maxLength: 100 },
            detail: { type: 'string', maxLength: 500 },
          },
        },
      ],
    },
    steps: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step', 'result', 'detail', 'ms'],
        properties: {
          step: { type: 'string', maxLength: 100 },
          result: { enum: ['ok', 'failed', 'skipped'] },
          detail: { type: 'string', maxLength: 500 },
          ms: { type: 'integer', minimum: 0 },
        },
      },
    },
    navigation: {
      type: 'object',
      additionalProperties: false,
      required: ['urlChanges', 'aborted'],
      properties: { urlChanges: { ...STRING_LIST, maxItems: 20 }, aborted: { type: 'boolean' } },
    },
    requestAccountsCalls: { type: 'integer', minimum: 0 },
  },
} as const;

export const SCAN_FAILURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'detail'],
  properties: {
    category: { enum: [...FAILURE_CATEGORIES] },
    detail: { type: 'string', maxLength: 500 },
  },
} as const;

/** Current (2.1.0) report schema. */
export const REPORT_SCHEMA_2_1_0 = {
  ...REPORT_SCHEMA_2_0_0,
  $id: 'https://igris.dev/schemas/report-2.1.0.json',
  title: 'IGRIS scan report v2.1',
  properties: {
    ...REPORT_SCHEMA_2_0_0.properties,
    reportVersion: { const: REPORT_V2_VERSION },
    scan: {
      ...REPORT_SCHEMA_2_0_0.properties.scan,
      properties: {
        ...REPORT_SCHEMA_2_0_0.properties.scan.properties,
        connection: CONNECTION_DIAGNOSTICS_SCHEMA,
        failure: SCAN_FAILURE_SCHEMA,
      },
    },
    privacy: {
      ...REPORT_SCHEMA_2_0_0.properties.privacy,
      properties: {
        ...REPORT_SCHEMA_2_0_0.properties.privacy.properties,
        findings: { type: 'array', items: findingSchema('privacy', EVIDENCE_TYPES) },
      },
    },
    security: {
      ...REPORT_SCHEMA_2_0_0.properties.security,
      properties: {
        observations: { type: 'array', items: findingSchema('security', EVIDENCE_TYPES) },
      },
    },
    evidence: {
      ...REPORT_SCHEMA_2_0_0.properties.evidence,
      properties: {
        ...REPORT_SCHEMA_2_0_0.properties.evidence.properties,
        bundleVersion: { const: EVIDENCE_BUNDLE_VERSION },
      },
    },
  },
} as const;

/** The current report schema (alias). */
export const REPORT_V2_SCHEMA = REPORT_SCHEMA_2_1_0;
