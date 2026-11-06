/**
 * Evidence bundles. `igris.evidence.v1` (P0.5) is FROZEN — its schema objects
 * below are pinned by hash in contracts.test.ts. `igris.evidence.v2` (P1) is
 * v1 plus exactly one additive item type, `contact-classification`; approved
 * by the project owner 2026-11-06 and frozen (hash-pinned) as well. Both
 * validate; new bundles are written as v2.
 *
 * The redacted, self-contained artifact holding every piece of evidence a
 * report's findings reference. Properties:
 *
 *  - Content-addressed: an item's id is derived from the sha256 of its
 *    canonical JSON, so identical evidence has one id and an id can only ever
 *    mean one thing.
 *  - Canary-free: the canary address never appears (snippets and URLs carry
 *    `<CANARY>`); the engine refuses to build a bundle that contains it.
 *  - Stable: only facts that justify findings. Volatile telemetry (request
 *    counts, timings) and scan identity (timestamps, canary, scanner key)
 *    live in the report, not here — so the same observations hash the same.
 *  - Hashed as a whole: `bundleHash = sha256(canonical(bundle))`; the report
 *    records it, and a published bundle can be checked byte-for-byte.
 *
 * Browser-safe.
 */
import type { LeakLocation, Phase, RecipientClass } from '../report.js';
import { RECIPIENT_CLASSES, RECIPIENT_CLASSES_V1 } from '../report.js';
import type { MatchCategory } from '../encodings.js';
import { contentHash } from './hash.js';

export const EVIDENCE_BUNDLE_VERSION_V1 = 'igris.evidence.v1' as const;
export const EVIDENCE_BUNDLE_VERSION_V2 = 'igris.evidence.v2' as const;
/** The version new bundles are written with (v3: + wallet-sdk recipient class). */
export const EVIDENCE_BUNDLE_VERSION = 'igris.evidence.v3' as const;
export type EvidenceBundleVersion =
  | typeof EVIDENCE_BUNDLE_VERSION_V1
  | typeof EVIDENCE_BUNDLE_VERSION_V2
  | typeof EVIDENCE_BUNDLE_VERSION;

/** The canary (any form) observed inside captured traffic. */
export interface CanaryMatchEvidence {
  type: 'canary-match';
  phase: Phase;
  location: LeakLocation;
  /** HTTP method, "WS" for WebSocket frames, "-" for cookies/storage. */
  method: string;
  /** Destination URL with the canary redacted. */
  url: string;
  host: string;
  registrableDomain: string;
  recipientClass: RecipientClass;
  /** Which encoding matched, e.g. "base64(lowercase)". */
  encoding: string;
  category: MatchCategory;
  /** Redacted context: the canary replaced by <CANARY>. */
  snippet: string;
}

/** A third-party host the page contacted (no request counts: those are volatile). */
export interface ThirdPartyContactEvidence {
  type: 'third-party-contact';
  host: string;
  registrableDomain: string;
  recipientClass: RecipientClass;
  /** Sorted, unique. */
  phases: Phase[];
  /** Sorted, unique HTTP methods. */
  methods: string[];
  /** Sorted, unique Playwright resource types. */
  resourceTypes: string[];
}

/** Selected response headers of the main document. null = header absent. */
export interface DocumentHeadersEvidence {
  type: 'document-headers';
  documentUrl: string;
  status: number;
  headers: {
    'content-security-policy': string | null;
    'content-security-policy-report-only': string | null;
    'strict-transport-security': string | null;
    'x-frame-options': string | null;
  };
}

/**
 * How IGRIS relates a contacted host to the scanned dapp (evidence v2).
 * Descriptive and precise; the frozen RecipientClass stays the SCORING class.
 */
export const RELATIONSHIPS = [
  'first-party',
  'same-organisation',
  'tenant-infrastructure',
  'shared-cdn',
  'wallet-sdk',
  'rpc',
  'walletconnect-relay',
  'ipfs-gateway',
  'analytics',
  'advertising',
  'error-monitoring',
  'support-chat',
  'security-service',
  'anon-rpc',
  'unknown',
] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

/** Relationships that may be unscored infrastructure (only with sufficient evidence). */
export const INFRASTRUCTURE_RELATIONSHIPS: readonly Relationship[] = [
  'first-party',
  'same-organisation',
  'tenant-infrastructure',
];

export const CLASSIFICATION_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type ClassificationConfidence = (typeof CLASSIFICATION_CONFIDENCES)[number];

/** What a classification rests on; every basis entry names a check and its result. */
export const BASIS_KINDS = [
  'registrable-domain-match',
  'organisation-mapping',
  'third-party-db',
  'tenant-hostname',
  'resource-profile',
  'no-cookies',
  'no-canary',
  'no-match',
] as const;
export type BasisKind = (typeof BASIS_KINDS)[number];

/**
 * The classification of one contacted host, with the rule that produced it
 * and the evidence it rests on (evidence v2). Every classification is
 * traceable: rule id@version + basis entries.
 */
export interface ContactClassificationEvidence {
  type: 'contact-classification';
  host: string;
  registrableDomain: string;
  relationship: Relationship;
  confidence: ClassificationConfidence;
  /** e.g. "third-party-db@1", "tenant-infrastructure@1". */
  rule: string;
  basis: Array<{ kind: BasisKind; detail: string }>;
}

export type EvidenceItem =
  | CanaryMatchEvidence
  | ThirdPartyContactEvidence
  | DocumentHeadersEvidence
  | ContactClassificationEvidence;
export type EvidenceType = EvidenceItem['type'];
/** Item types of the frozen v1 bundle. */
export const EVIDENCE_TYPES_V1 = [
  'canary-match',
  'third-party-contact',
  'document-headers',
] as const;
/** Item types of the current (v2) bundle. */
export const EVIDENCE_TYPES: readonly EvidenceType[] = [
  ...EVIDENCE_TYPES_V1,
  'contact-classification',
];

/** A finding's pointer into the bundle. */
export interface EvidenceRef {
  id: string;
  type: EvidenceType;
}

export interface EvidenceBundle {
  bundleVersion: EvidenceBundleVersion;
  /** Keyed by content id. */
  items: Record<string, EvidenceItem>;
}
/** @deprecated name kept for P0.5 callers; covers v1 and v2 bundles. */
export type EvidenceBundleV1 = EvidenceBundle;

/** Header values are truncated to this many characters in evidence. */
export const MAX_HEADER_VALUE = 512;

/** Content id of an evidence item: "ev_" + first 24 hex of its content hash (96 bits). */
export function evidenceId(item: EvidenceItem): string {
  return `ev_${contentHash(item).slice(0, 24)}`;
}

/** Hash of a whole bundle (64 hex). */
export function bundleHash(bundle: EvidenceBundle): string {
  return contentHash(bundle);
}

// ---------------------------------------------------------------------------
// JSON Schemas (draft 2020-12). additionalProperties:false everywhere, so the
// schemas and the TypeScript types cannot drift silently (contracts.test.ts
// checks key sets in both directions).
// ---------------------------------------------------------------------------

const PHASE = { enum: ['pre-connect', 'post-connect'] } as const;
/** FROZEN class enum of the v1 / v2 item schemas. */
const RECIPIENT = { enum: [...RECIPIENT_CLASSES_V1] } as const;
const SORTED_STRINGS = {
  type: 'array',
  items: { type: 'string', maxLength: 64 },
  uniqueItems: true,
} as const;

export const CANARY_MATCH_KEYS = [
  'type',
  'phase',
  'location',
  'method',
  'url',
  'host',
  'registrableDomain',
  'recipientClass',
  'encoding',
  'category',
  'snippet',
] as const;
export const THIRD_PARTY_CONTACT_KEYS = [
  'type',
  'host',
  'registrableDomain',
  'recipientClass',
  'phases',
  'methods',
  'resourceTypes',
] as const;
export const DOCUMENT_HEADERS_KEYS = ['type', 'documentUrl', 'status', 'headers'] as const;
export const DOCUMENT_HEADER_NAMES = [
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'x-frame-options',
] as const;

const nullableHeader = {
  anyOf: [{ type: 'null' }, { type: 'string', maxLength: MAX_HEADER_VALUE }],
} as const;

export const CONTACT_CLASSIFICATION_KEYS = [
  'type',
  'host',
  'registrableDomain',
  'relationship',
  'confidence',
  'rule',
  'basis',
] as const;

/** FROZEN (P0.5). Pinned by hash in contracts.test.ts — do not edit. */
export const EVIDENCE_ITEM_SCHEMA_V1 = {
  $id: 'https://igris.dev/schemas/evidence-item-1.json',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: [...CANARY_MATCH_KEYS],
      properties: {
        type: { const: 'canary-match' },
        phase: PHASE,
        location: {
          enum: [
            'url',
            'request-header',
            'request-body',
            'response-set-cookie',
            'websocket-frame',
            'cookie',
            'local-storage',
            'session-storage',
          ],
        },
        method: { type: 'string', minLength: 1, maxLength: 16 },
        url: { type: 'string', maxLength: 4096 },
        host: { type: 'string', minLength: 1, maxLength: 253 },
        registrableDomain: { type: 'string', minLength: 1, maxLength: 253 },
        recipientClass: RECIPIENT,
        encoding: { type: 'string', minLength: 1, maxLength: 64 },
        category: { enum: ['exact', 'hashed', 'partial'] },
        snippet: { type: 'string', maxLength: 1024 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: [...THIRD_PARTY_CONTACT_KEYS],
      properties: {
        type: { const: 'third-party-contact' },
        host: { type: 'string', minLength: 1, maxLength: 253 },
        registrableDomain: { type: 'string', minLength: 1, maxLength: 253 },
        recipientClass: RECIPIENT,
        phases: { type: 'array', items: PHASE, minItems: 1, maxItems: 2, uniqueItems: true },
        methods: SORTED_STRINGS,
        resourceTypes: SORTED_STRINGS,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: [...DOCUMENT_HEADERS_KEYS],
      properties: {
        type: { const: 'document-headers' },
        documentUrl: { type: 'string', minLength: 1, maxLength: 4096 },
        status: { type: 'integer', minimum: 100, maximum: 599 },
        headers: {
          type: 'object',
          additionalProperties: false,
          required: [...DOCUMENT_HEADER_NAMES],
          properties: Object.fromEntries(DOCUMENT_HEADER_NAMES.map((n) => [n, nullableHeader])),
        },
      },
    },
  ],
} as const;

/** FROZEN (P0.5). Pinned by hash in contracts.test.ts — do not edit. */
export const EVIDENCE_BUNDLE_SCHEMA_V1 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://igris.dev/schemas/evidence-bundle-1.json',
  title: 'IGRIS evidence bundle (igris.evidence.v1)',
  type: 'object',
  additionalProperties: false,
  required: ['bundleVersion', 'items'],
  properties: {
    bundleVersion: { const: EVIDENCE_BUNDLE_VERSION_V1 },
    items: {
      type: 'object',
      propertyNames: { pattern: '^ev_[0-9a-f]{24}$' },
      additionalProperties: { $ref: 'https://igris.dev/schemas/evidence-item-1.json' },
    },
  },
} as const;

const CONTACT_CLASSIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [...CONTACT_CLASSIFICATION_KEYS],
  properties: {
    type: { const: 'contact-classification' },
    host: { type: 'string', minLength: 1, maxLength: 253 },
    registrableDomain: { type: 'string', minLength: 1, maxLength: 253 },
    relationship: { enum: [...RELATIONSHIPS] },
    confidence: { enum: [...CLASSIFICATION_CONFIDENCES] },
    rule: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}@\\d+$' },
    basis: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'detail'],
        properties: {
          kind: { enum: [...BASIS_KINDS] },
          detail: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
  },
} as const;

/** FROZEN (approved 2026-11-06): v2 item schema = v1 item types + contact-classification. */
export const EVIDENCE_ITEM_SCHEMA_V2 = {
  $id: 'https://igris.dev/schemas/evidence-item-2.json',
  oneOf: [...EVIDENCE_ITEM_SCHEMA_V1.oneOf, CONTACT_CLASSIFICATION_SCHEMA],
} as const;

/** FROZEN (approved 2026-11-06): igris.evidence.v2 bundle schema. */
export const EVIDENCE_BUNDLE_SCHEMA_V2 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://igris.dev/schemas/evidence-bundle-2.json',
  title: 'IGRIS evidence bundle (igris.evidence.v2)',
  type: 'object',
  additionalProperties: false,
  required: ['bundleVersion', 'items'],
  properties: {
    bundleVersion: { const: EVIDENCE_BUNDLE_VERSION_V2 },
    items: {
      type: 'object',
      propertyNames: { pattern: '^ev_[0-9a-f]{24}$' },
      additionalProperties: { $ref: 'https://igris.dev/schemas/evidence-item-2.json' },
    },
  },
} as const;

/** The v2 item schemas with the current recipient-class enum (wallet-sdk). */
const withCurrentClasses = <T extends { properties: object }>(item: T): T =>
  'recipientClass' in item.properties
    ? {
        ...item,
        properties: { ...item.properties, recipientClass: { enum: [...RECIPIENT_CLASSES] } },
      }
    : item;

/**
 * Current (v3) item schema: identical to v2 except that `recipientClass`
 * (canary-match, third-party-contact) also allows `wallet-sdk`.
 */
export const EVIDENCE_ITEM_SCHEMA = {
  $id: 'https://igris.dev/schemas/evidence-item-3.json',
  oneOf: EVIDENCE_ITEM_SCHEMA_V2.oneOf.map(withCurrentClasses),
};

/** Current (v3) bundle schema. */
export const EVIDENCE_BUNDLE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://igris.dev/schemas/evidence-bundle-3.json',
  title: 'IGRIS evidence bundle (igris.evidence.v3)',
  type: 'object',
  additionalProperties: false,
  required: ['bundleVersion', 'items'],
  properties: {
    bundleVersion: { const: EVIDENCE_BUNDLE_VERSION },
    items: {
      type: 'object',
      propertyNames: { pattern: '^ev_[0-9a-f]{24}$' },
      additionalProperties: { $ref: 'https://igris.dev/schemas/evidence-item-3.json' },
    },
  },
} as const;
