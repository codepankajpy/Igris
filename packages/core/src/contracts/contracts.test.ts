/* eslint-disable @typescript-eslint/no-explicit-any -- hostile-document mutations in tests */
/**
 * Runtime half of the type ↔ schema lockstep (the compile-time half is
 * lockstep.ts): every key list equals its schema's `properties` and
 * `required`, and real/hostile documents validate as they should.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTACT_CLASSIFICATION_KEYS,
  EVIDENCE_BUNDLE_SCHEMA_V1,
  EVIDENCE_ITEM_SCHEMA_V1,
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
  REPORT_SCHEMA_2_0_0,
  REPORT_SCHEMA_2_1_0,
  SCAN_META_KEYS,
  SCAN_META_KEYS_2_0_0,
  TELEMETRY_KEYS,
} from './report-v2.js';
import {
  SchemaValidationError,
  validateEvidenceBundle,
  validateEvidenceItem,
  validateReportV2,
} from './validate.js';
import { sampleResult } from '../test-helpers.js';
import { canonicalize } from './canonical.js';
import { contentHash } from './hash.js';
import { verifyReportIntegrity } from './verify.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sorted = (xs: readonly string[]) => [...xs].sort();
const props = (s: { properties: object }) => sorted(Object.keys(s.properties));

describe('key lists == JSON Schema properties == required', () => {
  const [canary, contact, headers, classification] = EVIDENCE_ITEM_SCHEMA.oneOf;
  const cases: Array<
    [string, readonly string[], { properties: object; required: readonly string[] }]
  > = [
    ['canary-match', CANARY_MATCH_KEYS, canary],
    ['third-party-contact', THIRD_PARTY_CONTACT_KEYS, contact],
    ['document-headers', DOCUMENT_HEADERS_KEYS, headers],
    ['document-headers.headers', DOCUMENT_HEADER_NAMES, headers.properties.headers],
    ['contact-classification', CONTACT_CLASSIFICATION_KEYS, classification],
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
    ['scan meta (2.0.0, frozen)', SCAN_META_KEYS_2_0_0, REPORT_SCHEMA_2_0_0.properties.scan],
    ['telemetry', TELEMETRY_KEYS, REPORT_V2_SCHEMA.properties.telemetry.anyOf[1]],
  ];
  for (const [name, keys, schema] of cases) {
    it(name, () => {
      expect(props(schema)).toEqual(sorted(keys));
      expect(sorted(schema.required)).toEqual(sorted(keys));
    });
  }
  it('scan meta (2.1.0): all keys present, connection/failure optional', () => {
    expect(props(REPORT_SCHEMA_2_1_0.properties.scan)).toEqual(sorted(SCAN_META_KEYS));
    expect(sorted(REPORT_SCHEMA_2_1_0.properties.scan.required)).toEqual(
      sorted(SCAN_META_KEYS_2_0_0),
    );
  });
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
      ...walk(REPORT_SCHEMA_2_0_0, '#'),
      ...walk(EVIDENCE_ITEM_SCHEMA_V1, '#'),
      ...walk(EVIDENCE_BUNDLE_SCHEMA_V1, '#'),
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
    ['missing findingSet', (r) => delete r.findingSet],
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

describe('P0.5 contracts are frozen; P1 successors are additive and, once approved, frozen too', () => {
  // Canonical hashes of the schemas exactly as committed at b3c1485 (P0.5).
  it('frozen schemas are byte-for-byte unchanged', () => {
    expect(contentHash(REPORT_SCHEMA_2_0_0)).toBe(
      'a6d1eea9638b877e03d4b54b6a934cfb0fa50cd00966f30c0651dd44716ff2b4',
    );
    expect(contentHash(EVIDENCE_ITEM_SCHEMA_V1)).toBe(
      'e19efe37d16aa94d40f441c957fa193b41424f746e856ae59da48345bb3a9382',
    );
    expect(contentHash(EVIDENCE_BUNDLE_SCHEMA_V1)).toBe(
      '30123ef564721e395430fac52b5d778a02c2c8c21cac0fa65cca8c2c6a6aabc6',
    );
  });

  // Report 2.1.0 and igris.evidence.v2 were approved by the project owner on
  // 2026-11-06 (ROADMAP MVP-7) exactly as committed at dd47f45. From here on
  // they are frozen like 2.0.0 / v1: any change is a new version.
  it('approved successor schemas (2.1.0, evidence v2) are byte-for-byte unchanged', () => {
    expect(contentHash(REPORT_SCHEMA_2_1_0)).toBe(
      '9ee25dd09c0769879d2b50d8add238f6cc5b4c48382f84982ab85f5aee5406f1',
    );
    expect(contentHash(EVIDENCE_ITEM_SCHEMA)).toBe(
      '622effab4db47e09d579864881425a5b8c2bb6967d631b021da3a4d6f892ecd8',
    );
    expect(contentHash(EVIDENCE_BUNDLE_SCHEMA)).toBe(
      '49b6536cee6fda539ea86091d3cb27620202bca0eeee9cbd962b79086b6329f8',
    );
  });

  it('2.1.0 differs from 2.0.0 ONLY by the documented additions', () => {
    const strip = (schema: unknown) => {
      const c = structuredClone(schema) as any;
      delete c.$id;
      delete c.title;
      delete c.properties.reportVersion;
      delete c.properties.scan.properties.connection;
      delete c.properties.scan.properties.failure;
      delete c.properties.evidence.properties.bundleVersion;
      for (const sec of [
        c.properties.privacy.properties.findings,
        c.properties.security.properties.observations,
      ]) {
        delete sec.items.properties.evidence.items.properties.type;
      }
      return canonicalize(c);
    };
    expect(strip(REPORT_SCHEMA_2_1_0)).toBe(strip(REPORT_SCHEMA_2_0_0));
    // scan.connection / scan.failure are NOT required.
    expect(REPORT_SCHEMA_2_1_0.properties.scan.required).not.toContain('connection');
    expect(REPORT_SCHEMA_2_1_0.properties.scan.required).not.toContain('failure');
  });

  it('evidence v2 = v1 item schemas (identical) + contact-classification', () => {
    expect(canonicalize(EVIDENCE_ITEM_SCHEMA.oneOf.slice(0, 3))).toBe(
      canonicalize(EVIDENCE_ITEM_SCHEMA_V1.oneOf),
    );
    expect(EVIDENCE_ITEM_SCHEMA.oneOf).toHaveLength(4);
  });

  it('a real P0.5 artifact (report 2.0.0 + evidence v1) still validates and verifies', () => {
    const dir = fileURLToPath(new URL('../../test-fixtures/v2.0.0/leaky/', import.meta.url));
    const report = JSON.parse(readFileSync(dir + 'report.json', 'utf8'));
    const bundle = JSON.parse(readFileSync(dir + 'evidence.json', 'utf8'));
    expect(report.reportVersion).toBe('2.0.0');
    expect(bundle.bundleVersion).toBe('igris.evidence.v1');
    expect(() => validateReportV2(report)).not.toThrow();
    expect(() => validateEvidenceBundle(bundle)).not.toThrow();
    expect(verifyReportIntegrity(report, bundle)).toMatchObject({ ok: true, problems: [] });
  });

  it('2.0.0 reports cannot carry 2.1.0 fields; v1 bundles cannot carry classifications', () => {
    const dir = fileURLToPath(new URL('../../test-fixtures/v2.0.0/leaky/', import.meta.url));
    const report = JSON.parse(readFileSync(dir + 'report.json', 'utf8'));
    expect(() =>
      validateReportV2({
        ...report,
        scan: { ...report.scan, failure: { category: 'bot-blocked', detail: 'x' } },
      }),
    ).toThrow();
    expect(() =>
      validateEvidenceBundle({
        bundleVersion: 'igris.evidence.v1',
        items: { ['ev_' + 'a'.repeat(24)]: CLASSIFICATION },
      }),
    ).toThrow();
  });

  it('a report/bundle version mismatch is an integrity problem', () => {
    const { report, bundle } = sampleResult();
    expect(report.reportVersion).toBe('2.1.0');
    expect(bundle.bundleVersion).toBe('igris.evidence.v2');
    const asV1 = { ...bundle, bundleVersion: 'igris.evidence.v1' as const };
    expect(verifyReportIntegrity(report, asV1).problems.join(' ')).toMatch(/cannot reference/);
  });
});

const CLASSIFICATION = {
  type: 'contact-classification',
  host: 'd1abcdefghij.cloudfront.net',
  registrableDomain: 'cloudfront.net',
  relationship: 'tenant-infrastructure',
  confidence: 'medium',
  rule: 'tenant-infrastructure@1',
  basis: [{ kind: 'tenant-hostname', detail: 'Amazon CloudFront distribution hostname' }],
};

describe('contact-classification evidence (v2)', () => {
  it('a complete classification validates', () => {
    expect(() => validateEvidenceItem(CLASSIFICATION)).not.toThrow();
  });
  const bad: Array<[string, Record<string, unknown>]> = [
    ['empty basis (no evidence)', { basis: [] }],
    ['unknown relationship', { relationship: 'trusted' }],
    ['unknown confidence', { confidence: 'certain' }],
    ['rule without version', { rule: 'tenant-infrastructure' }],
    ['unknown basis kind', { basis: [{ kind: 'vibes', detail: 'x' }] }],
    ['extra field', { score: 0 }],
  ];
  for (const [name, patch] of bad) {
    it(`rejects ${name}`, () =>
      expect(() => validateEvidenceItem({ ...CLASSIFICATION, ...patch })).toThrow());
  }
  it('connection diagnostics validate in 2.1.0 and are optional', () => {
    const { report } = sampleResult();
    expect(() =>
      validateReportV2({
        ...report,
        scan: {
          ...report.scan,
          connection: {
            kit: { id: 'connectkit', confidence: 'high', signals: ['#__CONNECTKIT__'] },
            strategy: 'kit-recipe',
            recipe: 'connectkit@1',
            outcome: 'failed',
            failure: { category: 'wallet-option-missing', step: 'select-wallet', detail: 'x' },
            steps: [{ step: 'open-modal', result: 'ok', detail: '', ms: 120 }],
            navigation: { urlChanges: [], aborted: false },
            requestAccountsCalls: 0,
          },
        },
      }),
    ).not.toThrow();
  });
});
