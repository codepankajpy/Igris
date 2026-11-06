/* eslint-disable @typescript-eslint/no-explicit-any -- hostile-document mutations in tests */
/**
 * Runtime half of the type ↔ schema lockstep (the compile-time half is
 * lockstep.ts): every key list equals its schema's `properties` and
 * `required`, and real/hostile documents validate as they should.
 */
import { describe, expect, it } from 'vitest';
import {
  CANARY_MATCH_KEYS,
  DOCUMENT_HEADERS_KEYS,
  DOCUMENT_HEADER_NAMES,
  EVIDENCE_BUNDLE_SCHEMA,
  EVIDENCE_ITEM_SCHEMA,
  THIRD_PARTY_CONTACT_KEYS,
} from './evidence.js';
import {
  FINDING_KEYS,
  REPORT_V2_KEYS,
  REPORT_V2_REQUIRED,
  REPORT_V2_SCHEMA,
  SCAN_META_KEYS,
  TELEMETRY_KEYS,
} from './report-v2.js';
import {
  SchemaValidationError,
  validateEvidenceBundle,
  validateEvidenceItem,
  validateReportV2,
} from './validate.js';
import { sampleResult } from '../test-helpers.js';

const sorted = (xs: readonly string[]) => [...xs].sort();
const props = (s: { properties: object }) => sorted(Object.keys(s.properties));

describe('key lists == JSON Schema properties == required', () => {
  const [canary, contact, headers] = EVIDENCE_ITEM_SCHEMA.oneOf;
  const cases: Array<
    [string, readonly string[], { properties: object; required: readonly string[] }]
  > = [
    ['canary-match', CANARY_MATCH_KEYS, canary],
    ['third-party-contact', THIRD_PARTY_CONTACT_KEYS, contact],
    ['document-headers', DOCUMENT_HEADERS_KEYS, headers],
    ['document-headers.headers', DOCUMENT_HEADER_NAMES, headers.properties.headers],
    [
      'finding (privacy)',
      FINDING_KEYS,
      REPORT_V2_SCHEMA.properties.privacy.properties.findings.items,
    ],
    [
      'finding (security)',
      FINDING_KEYS,
      REPORT_V2_SCHEMA.properties.security.properties.observations.items,
    ],
    ['scan meta', SCAN_META_KEYS, REPORT_V2_SCHEMA.properties.scan],
    ['telemetry', TELEMETRY_KEYS, REPORT_V2_SCHEMA.properties.telemetry.anyOf[1]],
  ];
  for (const [name, keys, schema] of cases) {
    it(name, () => {
      expect(props(schema)).toEqual(sorted(keys));
      expect(sorted(schema.required)).toEqual(sorted(keys));
    });
  }
  it('report', () => {
    expect(props(REPORT_V2_SCHEMA)).toEqual(sorted(REPORT_V2_KEYS));
    expect(sorted(REPORT_V2_SCHEMA.required)).toEqual(sorted(REPORT_V2_REQUIRED));
  });
  it('every object schema forbids unknown properties', () => {
    const walk = (node: unknown, path: string): string[] => {
      if (!node || typeof node !== 'object') return [];
      const n = node as Record<string, unknown>;
      const bad =
        n.type === 'object' && n.properties && n.additionalProperties !== false ? [path] : [];
      return [...bad, ...Object.entries(n).flatMap(([k, v]) => walk(v, `${path}/${k}`))];
    };
    expect([
      ...walk(REPORT_V2_SCHEMA, '#'),
      ...walk(EVIDENCE_ITEM_SCHEMA, '#'),
      ...walk(EVIDENCE_BUNDLE_SCHEMA, '#'),
    ]).toEqual([]);
  });
});

describe('schema validation of real and hostile documents', () => {
  it('a real engine result validates', () => {
    const { report, bundle } = sampleResult();
    expect(() => validateReportV2(report)).not.toThrow();
    expect(() => validateEvidenceBundle(bundle)).not.toThrow();
  });

  const reportMutations: Array<[string, (r: Record<string, any>) => void]> = [
    ['unknown top-level field', (r) => (r.extra = 1)],
    ['unknown finding field', (r) => (r.privacy.findings[0].extra = 1)],
    ['missing finding field', (r) => delete r.privacy.findings[0].remediation],
    ['finding without evidence', (r) => (r.privacy.findings[0].evidence = [])],
    ['bad severity', (r) => (r.privacy.findings[0].severity = 'catastrophic')],
    ['bad confidence', (r) => (r.privacy.findings[0].confidence = 'certain')],
    [
      'privacy finding in the security section',
      (r) => r.security.observations.push(r.privacy.findings[0]),
    ],
    [
      'security observation that counts toward the score',
      (r) => (r.security.observations[0].countsTowardPrivacyScore = true),
    ],
    ['score out of range', (r) => (r.privacy.score = 101)],
    ['bad evidence hash', (r) => (r.evidence.sha256 = 'abc')],
    ['wrong report version', (r) => (r.reportVersion = '1.1.0')],
    ['bad finding id', (r) => (r.privacy.findings[0].id = 'f1')],
  ];
  for (const [name, mutate] of reportMutations) {
    it(`report rejects: ${name}`, () => {
      const r = structuredClone(sampleResult().report) as unknown as Record<string, any>;
      mutate(r);
      expect(() => validateReportV2(r)).toThrow(SchemaValidationError);
    });
  }

  it('evidence items reject unknown types, extra fields and bad enums', () => {
    const base = Object.values(sampleResult().bundle.items).find((i) => i.type === 'canary-match')!;
    expect(() => validateEvidenceItem({ ...base, type: 'gossip' })).toThrow();
    expect(() => validateEvidenceItem({ ...base, extra: 1 })).toThrow();
    expect(() => validateEvidenceItem({ ...base, category: 'vibes' })).toThrow();
    expect(() => validateEvidenceItem({ ...base, recipientClass: 'friend' })).toThrow();
  });

  it('bundles reject malformed item ids', () => {
    const { bundle } = sampleResult();
    const [first] = Object.values(bundle.items);
    expect(() => validateEvidenceBundle({ ...bundle, items: { ev_nothex: first } })).toThrow();
  });
});
