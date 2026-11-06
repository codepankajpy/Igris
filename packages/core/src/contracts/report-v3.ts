/**
 * Report 3.0.0 — no score. PROPOSED (docs/design/REPORT-3.0.0.md); it is
 * frozen and hash-pinned in contracts.test.ts only after the project owner
 * approves that document.
 *
 * What changes from 2.2.0 (contracts.test.ts asserts nothing else differs):
 *  - removed: `privacy.score`, `privacy.ledger`, and every finding's
 *    `countsTowardPrivacyScore` (findings are otherwise identical: same ids,
 *    fingerprints and evidence, so `findingSet` stays comparable with 2.x);
 *  - added: `recipients[]` — one per (registrable domain, class), with what
 *    it learned and a deterministic verdict (verdicts.ts);
 *  - added: `timeline` — milestones, per-recipient first contact / first
 *    address, requests per second (volatile, like `telemetry`; null when the
 *    capture recorded no times);
 *  - added: `walletRequests` — what the page asked the canary wallet to do,
 *    decoded (docs/design/WALLET-REQUESTS.md); null for migrated reports;
 *  - finding evidence refs may also point at `wallet-request` items;
 *  - `migratedFrom` also accepts 2.x versions (migrateReportV2toV3).
 *
 * Pairs with evidence bundle `igris.evidence.v4` (= v3 + `wallet-request`).
 *
 * Browser-safe.
 */
import type { Phase, RecipientClass, ScanCoverage, ThirdPartyContact } from '../report.js';
import { RECIPIENT_CLASSES } from '../report.js';
import { MILESTONE_EVENTS, type MilestoneEvent } from './capture.js';
import type { WalletRequestSummary } from './wallet-request.js';
import {
  EVIDENCE_BUNDLE_VERSION,
  EVIDENCE_TYPES,
  WALLET_REQUEST_DECODED_PROPERTIES,
} from './evidence.js';
import type { EvidenceRef } from './evidence.js';
import {
  REPORT_SCHEMA_2_2_0,
  type Confidence,
  type DetectorRun,
  type EvidenceSummary,
  type FindingDomain,
  type FindingKind,
  type FindingSetDigest,
  type ReportV2,
  type ScanMetaV2,
  type Severity,
  type TelemetryV2,
} from './report-v2.js';

/** The version new reports are written with. */
export const REPORT_V3_VERSION = '3.0.0' as const;

/** A finding in report 3.0.0: the 2.x finding without `countsTowardPrivacyScore`. */
export interface FindingV3 {
  id: string;
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
  evidence: EvidenceRef[];
}

export interface PrivacyFindingV3 extends FindingV3 {
  domain: 'privacy';
}

export interface SecurityObservationV3 extends FindingV3 {
  domain: 'security';
}

/** Every recipient class except first-party (the dApp itself is never a recipient). */
export type RecipientV3Class = Exclude<RecipientClass, 'first-party'>;
export const RECIPIENT_V3_CLASSES: readonly RecipientV3Class[] = RECIPIENT_CLASSES.filter(
  (c): c is RecipientV3Class => c !== 'first-party',
);

/**
 * Verdicts, in display/sort order (worst first):
 *  - unidentified: nobody can say what it does with what it receives;
 *  - tracking: not needed for the app to work; profiles visitors;
 *  - avoidable: the app works without this exposure;
 *  - expected: needed for the app to work as built.
 */
export const VERDICTS = ['unidentified', 'tracking', 'avoidable', 'expected'] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * What a recipient learned of the wallet address:
 *  - exact: an exact or encoded (non-hashed, non-truncated) form;
 *  - hashed: only hashed forms (still linkable);
 *  - possible: only a truncated display form (ambiguous on its own);
 *  - none: no form of the address was observed reaching it.
 */
export const ADDRESS_EXPOSURES = ['exact', 'hashed', 'possible', 'none'] as const;
export type AddressExposure = (typeof ADDRESS_EXPOSURES)[number];

export interface RecipientLearned {
  address: AddressExposure;
  /** Phases in which the reported address form was observed (chronological). */
  addressPhases: Phase[];
  /** Phases with HTTP(S) contact (chronological); [] = WebSocket only. */
  ip: Phase[];
}

export interface Recipient {
  registrableDomain: string;
  class: RecipientV3Class;
  /** Sorted, distinct. */
  hosts: string[];
  learned: RecipientLearned;
  verdict: Verdict;
  /** The verdict rule that applied, e.g. "verdict.rpc-with-address@1". */
  rule: string;
  /** One plain sentence, from the rule. */
  reason: string;
  /** canary-leak / ip-exposure findings about this recipient (sorted). */
  findingIds: string[];
}

export interface TimelineMilestone {
  event: MilestoneEvent;
  /** Integer ms since navigation start. */
  t: number;
}

export interface TimelineRecipient {
  registrableDomain: string;
  class: RecipientV3Class;
  /** First HTTP(S) request / WebSocket frame to it; null when not timed. */
  firstContactMs: number | null;
  /** First request / frame carrying an exact or hashed address form; null when none (or not timed). */
  firstAddressMs: number | null;
}

export interface RequestsPerSecond {
  /** Bucket start, integer ms since navigation start (multiple of 1000). */
  t: number;
  firstParty: number;
  thirdParty: number;
}

export interface Timeline {
  origin: 'navigation-start';
  milestones: TimelineMilestone[];
  /** Same keys, same order as report.recipients. */
  recipients: TimelineRecipient[];
  /** Dense 1 s buckets from 0, at most TIMELINE_MAX_SECONDS. */
  requestsPerSecond: RequestsPerSecond[];
}

export interface ReportV3 {
  reportVersion: typeof REPORT_V3_VERSION;
  scan: ScanMetaV2;
  detectors: DetectorRun[];
  privacy: {
    coverage: ScanCoverage;
    findings: PrivacyFindingV3[];
  };
  security: {
    observations: SecurityObservationV3[];
  };
  contacts: ThirdPartyContact[];
  wallet: {
    readsViaWallet: Array<{ method: string; count: number }>;
    usesAnonRpc: boolean;
  };
  telemetry: TelemetryV2 | null;
  evidence: EvidenceSummary;
  findingSet: FindingSetDigest;
  recipients: Recipient[];
  timeline: Timeline | null;
  /** JSON-RPC calls the page made, per endpoint; null when not recorded (migrated reports). */
  rpc: RpcEndpoint[] | null;
  /**
   * What the page asked the wallet to do (decoded), one entry per request in
   * request order; null when not recorded (migrated reports).
   * docs/design/WALLET-REQUESTS.md.
   */
  walletRequests: WalletRequestSummary[] | null;
  /** Present when this report was produced by migrating an older one ("1.x.y" or "2.x.y"). */
  migratedFrom?: string;
}

/** Any report version this code reads. */
export type ReportAny = ReportV2 | ReportV3;

export function isReportV3(report: ReportAny): report is ReportV3 {
  return report.reportVersion === REPORT_V3_VERSION;
}

// ---------------------------------------------------------------------------
// Key lists (lockstep.ts checks them against the types at compile time;
// contracts.test.ts checks them against the schema at runtime).
// ---------------------------------------------------------------------------

export const FINDING_V3_KEYS = [
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
] as const;
export const RECIPIENT_KEYS = [
  'registrableDomain',
  'class',
  'hosts',
  'learned',
  'verdict',
  'rule',
  'reason',
  'findingIds',
] as const;
export const RECIPIENT_LEARNED_KEYS = ['address', 'addressPhases', 'ip'] as const;
export const TIMELINE_KEYS = ['origin', 'milestones', 'recipients', 'requestsPerSecond'] as const;
export const TIMELINE_RECIPIENT_KEYS = [
  'registrableDomain',
  'class',
  'firstContactMs',
  'firstAddressMs',
] as const;
export const REPORT_V3_KEYS = [
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
  'recipients',
  'timeline',
  'rpc',
  'walletRequests',
  'migratedFrom',
] as const;
export const REPORT_V3_REQUIRED = REPORT_V3_KEYS.filter((k) => k !== 'migratedFrom');
export const WALLET_REQUEST_SUMMARY_KEYS = [
  'evidenceId',
  't',
  'kind',
  'method',
  'phase',
  'outcome',
  'frame',
  'chainId',
  'verifyingContract',
  'spender',
  'token',
  'amount',
  'deadline',
  'siweDomain',
  'unlimited',
  'longDeadline',
  'chainIdMismatch',
  'domainMismatch',
  'preConnect',
  'findingIds',
] as const;
/** The scanner records at most this many wallet requests per scan. */
export const MAX_WALLET_REQUESTS = 500;

/** requestsPerSecond covers at most this many seconds (10 minutes). */
export const TIMELINE_MAX_SECONDS = 600;
export const TIMELINE_MAX_MILESTONES = 20;
export const MAX_RECIPIENTS = 2000;

// ---------------------------------------------------------------------------
// JSON Schema 3.0.0, derived from 2.2.0 by exactly the documented changes.
// ---------------------------------------------------------------------------

const MS = { type: 'integer', minimum: 0 } as const;
const COUNT = { type: 'integer', minimum: 0 } as const;
const PHASES = {
  type: 'array',
  maxItems: 2,
  uniqueItems: true,
  items: { enum: ['pre-connect', 'post-connect'] },
} as const;
const DOMAIN = { type: 'string', minLength: 1, maxLength: 253 } as const;
const RECIPIENT_CLASS = { enum: [...RECIPIENT_V3_CLASSES] } as const;

/**
 * The 2.2.0 finding schema without countsTowardPrivacyScore, whose evidence
 * refs may also point at the v4 item type (`wallet-request`).
 */
function findingV3Schema<
  S extends {
    required: readonly string[];
    properties: {
      countsTowardPrivacyScore: unknown;
      evidence: { items: { properties: { type: unknown } } };
    };
  },
>(s: S) {
  const { countsTowardPrivacyScore: _removed, ...properties } = s.properties;
  const ev = properties.evidence;
  return {
    ...s,
    required: [...FINDING_V3_KEYS],
    properties: {
      ...properties,
      evidence: {
        ...ev,
        items: {
          ...ev.items,
          properties: { ...ev.items.properties, type: { enum: [...EVIDENCE_TYPES] } },
        },
      },
    },
  };
}

const P22 = REPORT_SCHEMA_2_2_0.properties;

// No size caps on recipients / hosts / findingIds: they mirror contacts and
// findings, which are unbounded; a cap would make a busy page crash the scan.
export const RECIPIENTS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: [...RECIPIENT_KEYS],
    properties: {
      registrableDomain: DOMAIN,
      class: RECIPIENT_CLASS,
      hosts: { type: 'array', minItems: 1, uniqueItems: true, items: DOMAIN },
      learned: {
        type: 'object',
        additionalProperties: false,
        required: [...RECIPIENT_LEARNED_KEYS],
        properties: {
          address: { enum: [...ADDRESS_EXPOSURES] },
          addressPhases: PHASES,
          ip: PHASES,
        },
      },
      verdict: { enum: [...VERDICTS] },
      rule: { type: 'string', pattern: '^verdict\\.[a-z0-9-]{1,64}@\\d{1,4}$' },
      reason: { type: 'string', minLength: 1, maxLength: 500 },
      findingIds: {
        type: 'array',
        uniqueItems: true,
        items: { type: 'string', pattern: '^F-[0-9a-f]{16}$' },
      },
    },
  },
} as const;

/** One JSON-RPC endpoint the page called (first party included). Telemetry, not evidence. */
export interface RpcEndpoint {
  host: string;
  registrableDomain: string;
  class: RecipientClass;
  phases: Phase[];
  /** HTTP requests / WebSocket messages carrying JSON-RPC. */
  requests: number;
  /** Methods called with their call counts, most called first (≤ 100). */
  calls: Array<{ method: string; count: number }>;
  /** Whether a full or hashed form of the wallet address appeared in these calls. */
  addressSeen: boolean;
}
export const RPC_ENDPOINT_KEYS = [
  'host',
  'registrableDomain',
  'class',
  'phases',
  'requests',
  'calls',
  'addressSeen',
] as const;
export const RPC_MAX_METHODS = 100;

export const RPC_SCHEMA = {
  anyOf: [
    { type: 'null' },
    {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...RPC_ENDPOINT_KEYS],
        properties: {
          host: { type: 'string', minLength: 1, maxLength: 253 },
          registrableDomain: { type: 'string', minLength: 1, maxLength: 253 },
          class: { enum: [...RECIPIENT_CLASSES] },
          phases: {
            type: 'array',
            minItems: 1,
            maxItems: 2,
            uniqueItems: true,
            items: { enum: ['pre-connect', 'post-connect'] },
          },
          requests: { type: 'integer', minimum: 1 },
          calls: {
            type: 'array',
            minItems: 1,
            maxItems: RPC_MAX_METHODS,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['method', 'count'],
              properties: {
                method: { type: 'string', pattern: '^[A-Za-z0-9_]{1,64}$' },
                count: { type: 'integer', minimum: 1 },
              },
            },
          },
          addressSeen: { type: 'boolean' },
        },
      },
    },
  ],
} as const;

export const TIMELINE_SCHEMA = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      additionalProperties: false,
      required: [...TIMELINE_KEYS],
      properties: {
        origin: { const: 'navigation-start' },
        milestones: {
          type: 'array',
          maxItems: TIMELINE_MAX_MILESTONES,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['event', 't'],
            properties: { event: { enum: [...MILESTONE_EVENTS] }, t: MS },
          },
        },
        recipients: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [...TIMELINE_RECIPIENT_KEYS],
            properties: {
              registrableDomain: DOMAIN,
              class: RECIPIENT_CLASS,
              firstContactMs: { anyOf: [{ type: 'null' }, MS] },
              firstAddressMs: { anyOf: [{ type: 'null' }, MS] },
            },
          },
        },
        requestsPerSecond: {
          type: 'array',
          maxItems: TIMELINE_MAX_SECONDS,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['t', 'firstParty', 'thirdParty'],
            properties: { t: MS, firstParty: COUNT, thirdParty: COUNT },
          },
        },
      },
    },
  ],
} as const;

/** `walletRequests`: null (not recorded) or one summary per request, in request order. */
export const WALLET_REQUESTS_SCHEMA = {
  anyOf: [
    { type: 'null' },
    {
      type: 'array',
      maxItems: MAX_WALLET_REQUESTS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...WALLET_REQUEST_SUMMARY_KEYS],
        properties: {
          evidenceId: { type: 'string', pattern: '^ev_[0-9a-f]{24}$' },
          t: { anyOf: [{ type: 'null' }, MS] },
          ...WALLET_REQUEST_DECODED_PROPERTIES,
          findingIds: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string', pattern: '^F-[0-9a-f]{16}$' },
          },
        },
      },
    },
  ],
} as const;

/** PROPOSED report schema 3.0.0 (not yet hash-pinned: owner approval pending). */
export const REPORT_SCHEMA_3_0_0 = {
  ...REPORT_SCHEMA_2_2_0,
  $id: 'https://igris.dev/schemas/report-3.0.0.json',
  title: 'IGRIS scan report v3',
  required: REPORT_V3_REQUIRED,
  properties: {
    ...P22,
    reportVersion: { const: REPORT_V3_VERSION },
    privacy: {
      ...P22.privacy,
      required: ['coverage', 'findings'],
      properties: {
        coverage: P22.privacy.properties.coverage,
        findings: {
          ...P22.privacy.properties.findings,
          items: findingV3Schema(P22.privacy.properties.findings.items),
        },
      },
    },
    security: {
      ...P22.security,
      properties: {
        observations: {
          ...P22.security.properties.observations,
          items: findingV3Schema(P22.security.properties.observations.items),
        },
      },
    },
    evidence: {
      ...P22.evidence,
      properties: {
        ...P22.evidence.properties,
        bundleVersion: { const: EVIDENCE_BUNDLE_VERSION },
      },
    },
    recipients: RECIPIENTS_SCHEMA,
    timeline: TIMELINE_SCHEMA,
    rpc: RPC_SCHEMA,
    walletRequests: WALLET_REQUESTS_SCHEMA,
    migratedFrom: { type: 'string', pattern: '^[12]\\.\\d+\\.\\d+$' },
  },
} as const;

/** The current report schema (alias). */
export const REPORT_V3_SCHEMA = REPORT_SCHEMA_3_0_0;
