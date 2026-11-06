/**
 * Evidence bundle v1 (`igris.evidence.v1`).
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
import { RECIPIENT_CLASSES } from '../report.js';
import type { MatchCategory } from '../encodings.js';
import { contentHash } from './hash.js';

export const EVIDENCE_BUNDLE_VERSION = 'igris.evidence.v1' as const;

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

export type EvidenceItem =
  CanaryMatchEvidence | ThirdPartyContactEvidence | DocumentHeadersEvidence;
export type EvidenceType = EvidenceItem['type'];
export const EVIDENCE_TYPES: readonly EvidenceType[] = [
  'canary-match',
  'third-party-contact',
  'document-headers',
];

/** A finding's pointer into the bundle. */
export interface EvidenceRef {
  id: string;
  type: EvidenceType;
}

export interface EvidenceBundleV1 {
  bundleVersion: typeof EVIDENCE_BUNDLE_VERSION;
  /** Keyed by content id. */
  items: Record<string, EvidenceItem>;
}

/** Header values are truncated to this many characters in evidence. */
export const MAX_HEADER_VALUE = 512;

/** Content id of an evidence item: "ev_" + first 24 hex of its content hash (96 bits). */
export function evidenceId(item: EvidenceItem): string {
  return `ev_${contentHash(item).slice(0, 24)}`;
}

/** Hash of a whole bundle (64 hex). */
export function bundleHash(bundle: EvidenceBundleV1): string {
  return contentHash(bundle);
}

// ---------------------------------------------------------------------------
// JSON Schemas (draft 2020-12). additionalProperties:false everywhere, so the
// schemas and the TypeScript types cannot drift silently (contracts.test.ts
// checks key sets in both directions).
// ---------------------------------------------------------------------------

const PHASE = { enum: ['pre-connect', 'post-connect'] } as const;
const RECIPIENT = { enum: [...RECIPIENT_CLASSES] } as const;
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

export const EVIDENCE_ITEM_SCHEMA = {
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

export const EVIDENCE_BUNDLE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://igris.dev/schemas/evidence-bundle-1.json',
  title: 'IGRIS evidence bundle (igris.evidence.v1)',
  type: 'object',
  additionalProperties: false,
  required: ['bundleVersion', 'items'],
  properties: {
    bundleVersion: { const: EVIDENCE_BUNDLE_VERSION },
    items: {
      type: 'object',
      propertyNames: { pattern: '^ev_[0-9a-f]{24}$' },
      additionalProperties: { $ref: 'https://igris.dev/schemas/evidence-item-1.json' },
    },
  },
} as const;
