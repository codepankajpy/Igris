/* eslint-disable @typescript-eslint/no-explicit-any -- hostile-document mutations in tests */
/**
 * Runtime half of the type ↔ schema lockstep (the compile-time half is
 * lockstep.ts): every key list equals its schema's `properties` and
 * `required`, and real/hostile documents validate as they should.
 */
import { describe, expect, it } from 'vitest';
import {
  bundleHash,
  CONTACT_CLASSIFICATION_KEYS,
  EVIDENCE_BUNDLE_SCHEMA_V1,
  EVIDENCE_ITEM_SCHEMA_V1,
  CANARY_MATCH_KEYS,
  DOCUMENT_HEADERS_KEYS,
  DOCUMENT_HEADER_NAMES,
  EVIDENCE_BUNDLE_SCHEMA,
  EVIDENCE_BUNDLE_SCHEMA_V2,
  EVIDENCE_BUNDLE_SCHEMA_V3,
  EVIDENCE_ITEM_SCHEMA,
  EVIDENCE_ITEM_SCHEMA_V2,
  EVIDENCE_ITEM_SCHEMA_V3,
  EVIDENCE_TYPES_V2,
  THIRD_PARTY_CONTACT_KEYS,
  WALLET_REQUEST_EVIDENCE_KEYS,
} from './evidence.js';
import {
  FINDING_KEYS,
  REPORT_V2_KEYS,
  REPORT_V2_REQUIRED,
  REPORT_V2_SCHEMA,
  REPORT_SCHEMA_2_0_0,
  REPORT_SCHEMA_2_1_0,
  REPORT_SCHEMA_2_2_0,
  SCAN_META_KEYS,
  SCAN_META_KEYS_2_0_0,
  TELEMETRY_KEYS,
} from './report-v2.js';
import {
  FINDING_V3_KEYS,
  RECIPIENT_KEYS,
  RECIPIENT_LEARNED_KEYS,
  REPORT_SCHEMA_3_0_0,
  REPORT_V3_KEYS,
  REPORT_V3_REQUIRED,
  TIMELINE_KEYS,
  TIMELINE_RECIPIENT_KEYS,
  WALLET_REQUEST_SUMMARY_KEYS,
} from './report-v3.js';
import {
  SchemaValidationError,
  validateEvidenceBundle,
  validateEvidenceItem,
  validateReport,
  validateReportV2,
} from './validate.js';
import { req, sampleCapture, sampleResult, sampleResultV2 } from '../test-helpers.js';
import { canonicalize } from './canonical.js';
import { contentHash } from './hash.js';
import { verifyReportIntegrity } from './verify.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sorted = (xs: readonly string[]) => [...xs].sort();
const props = (s: { properties: object }) => sorted(Object.keys(s.properties));

describe('key lists == JSON Schema properties == required', () => {
  type Obj = { properties: object; required: readonly string[] };
  const [canary, contact, headers, classification, walletRequest] =
    EVIDENCE_ITEM_SCHEMA.oneOf as unknown as [
      Obj,
      Obj,
      Obj & { properties: { headers: Obj } },
      Obj,
      Obj,
    ];
  const cases: Array<[string, readonly string[], Obj]> = [
    ['canary-match', CANARY_MATCH_KEYS, canary],
    ['third-party-contact', THIRD_PARTY_CONTACT_KEYS, contact],
    ['document-headers', DOCUMENT_HEADERS_KEYS, headers],
    ['document-headers.headers', DOCUMENT_HEADER_NAMES, headers.properties.headers],
    ['contact-classification', CONTACT_CLASSIFICATION_KEYS, classification],
    ['wallet-request', WALLET_REQUEST_EVIDENCE_KEYS, walletRequest],
    [
      'walletRequests[] (3.0.0)',
      WALLET_REQUEST_SUMMARY_KEYS,
      REPORT_SCHEMA_3_0_0.properties.walletRequests.anyOf[1].items,
    ],
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
    [
      'finding 3.0.0 (privacy)',
      FINDING_V3_KEYS,
      REPORT_SCHEMA_3_0_0.properties.privacy.properties.findings.items,
    ],
    [
      'finding 3.0.0 (security)',
      FINDING_V3_KEYS,
      REPORT_SCHEMA_3_0_0.properties.security.properties.observations.items,
    ],
    ['recipient', RECIPIENT_KEYS, REPORT_SCHEMA_3_0_0.properties.recipients.items],
    [
      'recipient.learned',
      RECIPIENT_LEARNED_KEYS,
      REPORT_SCHEMA_3_0_0.properties.recipients.items.properties.learned,
    ],
    ['timeline', TIMELINE_KEYS, REPORT_SCHEMA_3_0_0.properties.timeline.anyOf[1]],
    [
      'timeline.recipients',
      TIMELINE_RECIPIENT_KEYS,
      REPORT_SCHEMA_3_0_0.properties.timeline.anyOf[1].properties.recipients.items,
    ],
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
  it('report 3.0.0', () => {
    expect(props(REPORT_SCHEMA_3_0_0)).toEqual(sorted(REPORT_V3_KEYS));
    expect(sorted(REPORT_SCHEMA_3_0_0.required)).toEqual(sorted(REPORT_V3_REQUIRED));
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
      ...walk(REPORT_SCHEMA_3_0_0, '#'),
      ...walk(REPORT_V2_SCHEMA, '#'),
      ...walk(EVIDENCE_ITEM_SCHEMA, '#'),
      ...walk(EVIDENCE_BUNDLE_SCHEMA, '#'),
      ...walk(REPORT_SCHEMA_2_0_0, '#'),
      ...walk(EVIDENCE_ITEM_SCHEMA_V1, '#'),
      ...walk(EVIDENCE_BUNDLE_SCHEMA_V1, '#'),
      ...walk(EVIDENCE_ITEM_SCHEMA_V3, '#'),
      ...walk(EVIDENCE_BUNDLE_SCHEMA_V3, '#'),
    ]).toEqual([]);
  });
});

describe('schema validation of real and hostile documents', () => {
  it('a real engine result (3.0.0) and its 2.2.0 counterpart validate', () => {
    const { report, bundle } = sampleResult();
    expect(report.reportVersion).toBe('3.0.0');
    expect(() => validateReport(report)).not.toThrow();
    expect(() => validateEvidenceBundle(bundle)).not.toThrow();
    expect(() => validateReport(sampleResultV2().report)).not.toThrow();
    // The deprecated name keeps working, for every version.
    expect(validateReportV2).toBe(validateReport);
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
      'a 2.x score flag on a security observation',
      (r) => (r.security.observations[0].countsTowardPrivacyScore = false),
    ],
    [
      'a 2.x score flag on a privacy finding',
      (r) => (r.privacy.findings[0].countsTowardPrivacyScore = true),
    ],
    ['a privacy score', (r) => (r.privacy.score = 80)],
    ['a null privacy score', (r) => (r.privacy.score = null)],
    ['a ledger', (r) => (r.privacy.ledger = [])],
    ['a top-level score', (r) => (r.score = 80)],
    ['missing recipients', (r) => delete r.recipients],
    ['missing timeline', (r) => delete r.timeline],
    ['missing walletRequests', (r) => delete r.walletRequests],
    ['walletRequests not an array', (r) => (r.walletRequests = {})],
    [
      'wallet request with an unknown kind',
      (r) => (r.walletRequests = [{ ...SUMMARY, kind: 'x' }]),
    ],
    [
      'wallet request with a lowercase-only bad address',
      (r) => (r.walletRequests = [{ ...SUMMARY, spender: '0x1234' }]),
    ],
    [
      'wallet request with a hex amount',
      (r) => (r.walletRequests = [{ ...SUMMARY, amount: '0xff' }]),
    ],
    ['wallet request with a negative time', (r) => (r.walletRequests = [{ ...SUMMARY, t: -1 }])],
    [
      'wallet request with an extra field',
      (r) => (r.walletRequests = [{ ...SUMMARY, params: '[]' }]),
    ],
    [
      'wallet request without findingIds',
      (r) => (r.walletRequests = [{ ...SUMMARY, findingIds: undefined }]),
    ],
    ['501 wallet requests', (r) => (r.walletRequests = Array.from({ length: 501 }, () => SUMMARY))],
    ['unknown verdict', (r) => (r.recipients[0].verdict = 'fine')],
    ['first party as a recipient', (r) => (r.recipients[0].class = 'first-party')],
    ['recipient without hosts', (r) => (r.recipients[0].hosts = [])],
    ['unknown address exposure', (r) => (r.recipients[0].learned.address = 'some')],
    ['rule without version', (r) => (r.recipients[0].rule = 'verdict.analytics')],
    ['unknown recipient field', (r) => (r.recipients[0].score = 3)],
    [
      'timeline with a negative time',
      (r) => (r.timeline = { ...TIMELINE, milestones: [{ event: 'page-loaded', t: -1 }] }),
    ],
    [
      'timeline with a fractional time',
      (r) => (r.timeline = { ...TIMELINE, milestones: [{ event: 'page-loaded', t: 1.5 }] }),
    ],
    [
      'timeline with an unknown milestone',
      (r) => (r.timeline = { ...TIMELINE, milestones: [{ event: 'lunch', t: 1 }] }),
    ],
    [
      'timeline with 601 one-second buckets',
      (r) =>
        (r.timeline = {
          ...TIMELINE,
          requestsPerSecond: Array.from({ length: 601 }, (_, i) => ({
            t: i * 1000,
            firstParty: 0,
            thirdParty: 0,
          })),
        }),
    ],
    [
      'timeline with 21 milestones',
      (r) =>
        (r.timeline = {
          ...TIMELINE,
          milestones: Array.from({ length: 21 }, () => ({ event: 'page-loaded', t: 0 })),
        }),
    ],
    ['timeline with another origin', (r) => (r.timeline = { ...TIMELINE, origin: 'epoch' })],
    ['migratedFrom 3.x', (r) => (r.migratedFrom = '3.0.0')],
    ['bad evidence hash', (r) => (r.evidence.sha256 = 'abc')],
    ['missing findingSet', (r) => delete r.findingSet],
    ['wrong report version', (r) => (r.reportVersion = '1.1.0')],
    ['bad finding id', (r) => (r.privacy.findings[0].id = 'f1')],
  ];
  for (const [name, mutate] of reportMutations) {
    it(`report rejects: ${name}`, () => {
      const r = structuredClone(sampleResult().report) as unknown as Record<string, any>;
      mutate(r);
      expect(() => validateReport(r)).toThrow(SchemaValidationError);
    });
  }

  it('2.2.0 still rejects a security observation that counts and an out-of-range score', () => {
    const base = sampleResultV2().report;
    const counted = structuredClone(base) as unknown as Record<string, any>;
    counted.security.observations[0].countsTowardPrivacyScore = true;
    expect(() => validateReport(counted)).toThrow(SchemaValidationError);
    const range = structuredClone(base) as unknown as Record<string, any>;
    range.privacy.score = 101;
    expect(() => validateReport(range)).toThrow(SchemaValidationError);
  });

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
    expect(contentHash(EVIDENCE_ITEM_SCHEMA_V2)).toBe(
      '622effab4db47e09d579864881425a5b8c2bb6967d631b021da3a4d6f892ecd8',
    );
    expect(contentHash(EVIDENCE_BUNDLE_SCHEMA_V2)).toBe(
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
    expect(canonicalize(EVIDENCE_ITEM_SCHEMA_V2.oneOf.slice(0, 3))).toBe(
      canonicalize(EVIDENCE_ITEM_SCHEMA_V1.oneOf),
    );
    expect(EVIDENCE_ITEM_SCHEMA_V2.oneOf).toHaveLength(4);
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

  it('a report/bundle version mismatch is an integrity problem (2.2.0 ↔ v3, 3.0.0 ↔ v4)', () => {
    for (const [{ report, bundle }, version] of [
      [sampleResult(), 'igris.evidence.v4'],
      [sampleResultV2(), 'igris.evidence.v3'],
    ] as const) {
      expect(bundle.bundleVersion).toBe(version);
      expect(verifyReportIntegrity(report, bundle)).toMatchObject({ ok: true });
      for (const other of [
        'igris.evidence.v1',
        'igris.evidence.v2',
        'igris.evidence.v3',
        'igris.evidence.v4',
      ] as const) {
        if (other === version) continue;
        const wrong = { ...bundle, bundleVersion: other };
        expect(verifyReportIntegrity(report, wrong).problems.join(' ')).toMatch(/cannot reference/);
      }
    }
  });
});

describe('Report 2.2.0 / igris.evidence.v3: the wallet-sdk class (approved 2026-11-06)', () => {
  it('approved successor schemas (2.2.0, evidence v3) are byte-for-byte unchanged', () => {
    expect(contentHash(REPORT_SCHEMA_2_2_0)).toBe(
      '49a585460635b60d0ff2862057fe532fbbabb08c91022fea03f795d7ba5cced2',
    );
    expect(contentHash(EVIDENCE_ITEM_SCHEMA_V3)).toBe(
      '578bfe794bb8cdfd0f4ecb3f3603a6b6fb3e8b46bc25fdc5070950b725f6b687',
    );
    expect(contentHash(EVIDENCE_BUNDLE_SCHEMA_V3)).toBe(
      'e80f9563020a29a763646c11ab627a280b43ba68627d50b31708ecbbba62a91c',
    );
  });

  it('2.2.0 differs from 2.1.0 ONLY by version, contacts class enum and bundle version', () => {
    const strip = (schema: unknown) => {
      const c = structuredClone(schema) as any;
      delete c.$id;
      delete c.title;
      delete c.properties.reportVersion;
      delete c.properties.contacts.items.properties.class;
      delete c.properties.evidence.properties.bundleVersion;
      return canonicalize(c);
    };
    expect(strip(REPORT_SCHEMA_2_2_0)).toBe(strip(REPORT_SCHEMA_2_1_0));
    expect(REPORT_SCHEMA_2_2_0.properties.contacts.items.properties.class.enum).toEqual([
      ...REPORT_SCHEMA_2_1_0.properties.contacts.items.properties.class.enum,
      'wallet-sdk',
    ]);
  });

  it('evidence v3 differs from v2 ONLY by the recipientClass enums', () => {
    const strip = (schema: { oneOf: readonly unknown[] }) =>
      canonicalize(
        schema.oneOf.map((o) => {
          const c = structuredClone(o) as any;
          delete c.properties.recipientClass;
          return c;
        }),
      );
    expect(strip(EVIDENCE_ITEM_SCHEMA_V3)).toBe(strip(EVIDENCE_ITEM_SCHEMA_V2));
    const enums = (schema: { oneOf: readonly unknown[] }) =>
      schema.oneOf.map((o) => (o as any).properties.recipientClass?.enum).filter(Boolean);
    for (const e of enums(EVIDENCE_ITEM_SCHEMA_V3)) expect(e).toContain('wallet-sdk');
    for (const e of enums(EVIDENCE_ITEM_SCHEMA_V2)) expect(e).not.toContain('wallet-sdk');
  });

  it('a 2.1.0 report with its v2 bundle still validates and verifies', () => {
    const { report, bundle } = sampleResultV2();
    const v2 = { ...bundle, bundleVersion: 'igris.evidence.v2' as const };
    const r210 = {
      ...report,
      reportVersion: '2.1.0' as const,
      evidence: {
        ...report.evidence,
        bundleVersion: 'igris.evidence.v2' as const,
        sha256: bundleHash(v2),
      },
    };
    expect(() => validateEvidenceBundle(v2)).not.toThrow();
    expect(() => validateReportV2(r210)).not.toThrow();
    expect(verifyReportIntegrity(r210, v2)).toMatchObject({ ok: true, problems: [] });
  });

  it('wallet-sdk is valid in 2.2.0 / v3 and rejected by 2.1.0 / v2', () => {
    const { report, bundle } = sampleResultV2();
    const contact = { ...report.contacts[0]!, class: 'wallet-sdk' as const };
    expect(() => validateReportV2({ ...report, contacts: [contact] })).not.toThrow();
    expect(() =>
      validateReportV2({
        ...report,
        reportVersion: '2.1.0',
        evidence: { ...report.evidence, bundleVersion: 'igris.evidence.v2' },
        contacts: [contact],
      }),
    ).toThrow();
    const [id, item] = Object.entries(bundle.items).find(([, i]) => i.type === 'canary-match')!;
    const sdkItem = { ...item, recipientClass: 'wallet-sdk' };
    expect(() =>
      validateEvidenceBundle({ bundleVersion: 'igris.evidence.v3', items: { [id]: sdkItem } }),
    ).not.toThrow();
    expect(() =>
      validateEvidenceBundle({ bundleVersion: 'igris.evidence.v2', items: { [id]: sdkItem } }),
    ).toThrow();
  });
});

describe('igris.evidence.v4 (PROPOSED — pending owner approval; docs/design/WALLET-REQUESTS.md)', () => {
  // TODO(evidence-v4 approval): once the project owner approves
  // docs/design/WALLET-REQUESTS.md, pin contentHash(EVIDENCE_ITEM_SCHEMA) and
  // contentHash(EVIDENCE_BUNDLE_SCHEMA) here, like the v1–v3 pins above, and
  // mark them FROZEN in evidence.ts and docs/CONTRACTS.md.

  it('v4 = the v3 item schemas, unchanged, + exactly one item type (wallet-request)', () => {
    expect(EVIDENCE_ITEM_SCHEMA.oneOf).toHaveLength(EVIDENCE_ITEM_SCHEMA_V3.oneOf.length + 1);
    expect(canonicalize(EVIDENCE_ITEM_SCHEMA.oneOf.slice(0, -1))).toBe(
      canonicalize(EVIDENCE_ITEM_SCHEMA_V3.oneOf),
    );
    expect((EVIDENCE_ITEM_SCHEMA.oneOf.at(-1) as any).properties.type).toEqual({
      const: 'wallet-request',
    });
    // The bundle schemas differ only by name, version label and item schema ref.
    const strip = (schema: unknown) => {
      const c = structuredClone(schema) as any;
      delete c.$id;
      delete c.title;
      delete c.properties.bundleVersion;
      delete c.properties.items.additionalProperties.$ref;
      return canonicalize(c);
    };
    expect(strip(EVIDENCE_BUNDLE_SCHEMA)).toBe(strip(EVIDENCE_BUNDLE_SCHEMA_V3));
    expect(EVIDENCE_BUNDLE_SCHEMA.properties.bundleVersion).toEqual({ const: 'igris.evidence.v4' });
    expect(EVIDENCE_BUNDLE_SCHEMA.properties.items.additionalProperties.$ref).toBe(
      EVIDENCE_ITEM_SCHEMA.$id,
    );
  });

  it('a complete wallet-request item validates in v4 and is rejected by v3', () => {
    expect(() => validateEvidenceItem(WALLET_ITEM)).not.toThrow();
    const id = 'ev_' + 'b'.repeat(24);
    expect(() =>
      validateEvidenceBundle({ bundleVersion: 'igris.evidence.v4', items: { [id]: WALLET_ITEM } }),
    ).not.toThrow();
    expect(() =>
      validateEvidenceBundle({ bundleVersion: 'igris.evidence.v3', items: { [id]: WALLET_ITEM } }),
    ).toThrow();
    // v3 bundles still validate as v3.
    const { bundle } = sampleResultV2();
    expect(() => validateEvidenceBundle(bundle)).not.toThrow();
  });

  const bad: Array<[string, Record<string, unknown>]> = [
    ['an unknown kind', { kind: 'drain' }],
    ['an unrecorded method', { method: 'eth_call' }],
    ['an unknown outcome', { outcome: 'pending' }],
    ['an unknown frame', { frame: 'worker' }],
    ['a short address', { spender: '0x1234' }],
    ['an address without 0x', { token: 'a'.repeat(40) }],
    ['a hex amount', { amount: '0xff' }],
    ['a 79-digit amount', { amount: '1'.repeat(79) }],
    ['a negative chain id', { chainId: -1 }],
    ['a fractional chain id', { chainId: 1.5 }],
    ['a string flag', { unlimited: 'yes' }],
    ['an empty origin', { origin: '' }],
    ['an empty SIWE domain', { siweDomain: '' }],
    ['an uppercase digest', { paramsDigest: 'A'.repeat(64) }],
    ['raw params', { params: '[]' }],
    ['a time (the bundle never holds times)', { t: 10 }],
  ];
  for (const [name, patch] of bad) {
    it(`wallet-request item rejects ${name}`, () =>
      expect(() => validateEvidenceItem({ ...WALLET_ITEM, ...patch })).toThrow());
  }
  it('every field is required', () => {
    for (const k of WALLET_REQUEST_EVIDENCE_KEYS) {
      const { [k]: _drop, ...rest } = WALLET_ITEM as Record<string, unknown>;
      expect(() => validateEvidenceItem(rest), k).toThrow();
    }
  });
});

describe('Report 3.0.0 (PROPOSED — pending owner approval; docs/design/REPORT-3.0.0.md)', () => {
  // TODO(report-3.0.0 approval): once the project owner approves
  // docs/design/REPORT-3.0.0.md, pin contentHash(REPORT_SCHEMA_3_0_0) here,
  // like the 2.x pins above, and mark it FROZEN in report-v3.ts and
  // docs/CONTRACTS.md. Until then 3.0.0 may still change.

  it('the frozen 2.x / evidence schemas are untouched by deriving 3.0.0 from them', () => {
    // report-v3.ts builds on REPORT_SCHEMA_2_2_0; deriving must never mutate it.
    void REPORT_SCHEMA_3_0_0;
    expect(contentHash(REPORT_SCHEMA_2_0_0)).toBe(
      'a6d1eea9638b877e03d4b54b6a934cfb0fa50cd00966f30c0651dd44716ff2b4',
    );
    expect(contentHash(REPORT_SCHEMA_2_1_0)).toBe(
      '9ee25dd09c0769879d2b50d8add238f6cc5b4c48382f84982ab85f5aee5406f1',
    );
    expect(contentHash(REPORT_SCHEMA_2_2_0)).toBe(
      '49a585460635b60d0ff2862057fe532fbbabb08c91022fea03f795d7ba5cced2',
    );
    expect(contentHash(EVIDENCE_ITEM_SCHEMA_V3)).toBe(
      '578bfe794bb8cdfd0f4ecb3f3603a6b6fb3e8b46bc25fdc5070950b725f6b687',
    );
    expect(contentHash(EVIDENCE_BUNDLE_SCHEMA_V3)).toBe(
      'e80f9563020a29a763646c11ab627a280b43ba68627d50b31708ecbbba62a91c',
    );
  });

  it('3.0.0 differs from 2.2.0 ONLY by the documented removals and additions', () => {
    const findings = (c: any) => [
      c.properties.privacy.properties.findings.items,
      c.properties.security.properties.observations.items,
    ];
    const strip3 = (schema: unknown) => {
      const c = structuredClone(schema) as any;
      delete c.$id;
      delete c.title;
      delete c.required;
      delete c.properties.reportVersion;
      delete c.properties.recipients; // added
      delete c.properties.timeline; // added
      delete c.properties.rpc; // added
      delete c.properties.walletRequests; // added (WALLET-REQUESTS.md)
      delete c.properties.migratedFrom; // widened to 1.x and 2.x
      delete c.properties.evidence.properties.bundleVersion; // igris.evidence.v4
      delete c.properties.privacy.required;
      for (const f of findings(c)) {
        delete f.required;
        delete f.properties.evidence.items.properties.type; // + wallet-request
      }
      return canonicalize(c);
    };
    const strip22 = (schema: unknown) => {
      const c = structuredClone(schema) as any;
      delete c.$id;
      delete c.title;
      delete c.required;
      delete c.properties.reportVersion;
      delete c.properties.migratedFrom;
      delete c.properties.privacy.required;
      delete c.properties.privacy.properties.score; // removed
      delete c.properties.privacy.properties.ledger; // removed
      delete c.properties.evidence.properties.bundleVersion;
      for (const f of findings(c)) {
        delete f.required;
        delete f.properties.countsTowardPrivacyScore; // removed
        delete f.properties.evidence.items.properties.type;
      }
      return canonicalize(c);
    };
    expect(strip3(REPORT_SCHEMA_3_0_0)).toBe(strip22(REPORT_SCHEMA_2_2_0));

    // The stripped parts, exactly:
    expect(REPORT_SCHEMA_3_0_0.properties.reportVersion).toEqual({ const: '3.0.0' });
    expect(REPORT_SCHEMA_3_0_0.required).toEqual([
      ...REPORT_SCHEMA_2_2_0.required,
      'recipients',
      'timeline',
      'rpc',
      'walletRequests',
    ]);
    expect(REPORT_SCHEMA_3_0_0.properties.walletRequests.anyOf[0]).toEqual({ type: 'null' });
    expect(REPORT_SCHEMA_3_0_0.properties.privacy.required).toEqual(['coverage', 'findings']);
    for (const f of findings(REPORT_SCHEMA_3_0_0)) {
      expect(f.required).toEqual(FINDING_KEYS.filter((k) => k !== 'countsTowardPrivacyScore'));
    }
    expect(REPORT_SCHEMA_3_0_0.properties.migratedFrom).toEqual({
      type: 'string',
      pattern: '^[12]\\.\\d+\\.\\d+$',
    });
    expect(REPORT_SCHEMA_3_0_0.properties.evidence.properties.bundleVersion).toEqual({
      const: 'igris.evidence.v4',
    });
    expect(REPORT_SCHEMA_2_2_0.properties.evidence.properties.bundleVersion).toEqual({
      const: 'igris.evidence.v3',
    });
    for (const f of findings(REPORT_SCHEMA_3_0_0)) {
      expect(f.properties.evidence.items.properties.type).toEqual({
        enum: [...EVIDENCE_TYPES_V2, 'wallet-request'],
      });
    }
    for (const f of findings(REPORT_SCHEMA_2_2_0)) {
      expect(f.properties.evidence.items.properties.type).toEqual({ enum: [...EVIDENCE_TYPES_V2] });
    }
  });

  it('requires walletRequests; it may be null (not recorded) or a list', () => {
    const { report } = sampleResult();
    expect(report.walletRequests).toBeNull(); // the sample capture records no wallet requests
    expect(() => validateReport({ ...report, walletRequests: [] })).not.toThrow();
    expect(() => validateReport({ ...report, walletRequests: [SUMMARY] })).not.toThrow();
    const { walletRequests: _w, ...without } = report;
    expect(() => validateReport(without)).toThrow(/walletRequests/);
  });

  it('requires recipients and timeline; timeline may be null', () => {
    const { report } = sampleResult();
    expect(report.timeline).toBeNull();
    expect(() => validateReport(report)).not.toThrow();
    expect(() => validateReport({ ...report, timeline: TIMELINE })).not.toThrow();
    expect(() => validateReport({ ...report, recipients: [] })).not.toThrow();
    const { recipients: _r, ...noRecipients } = report;
    const { timeline: _t, ...noTimeline } = report;
    expect(() => validateReport(noRecipients)).toThrow(/recipients/);
    expect(() => validateReport(noTimeline)).toThrow(/timeline/);
  });

  it('a 3.0.0 report with a score is rejected, wherever the score is put', () => {
    const { report } = sampleResult();
    expect(() => validateReport({ ...report, privacy: { ...report.privacy, score: 90 } })).toThrow(
      SchemaValidationError,
    );
    expect(() =>
      validateReport({ ...report, privacy: { ...report.privacy, score: 90, ledger: [] } }),
    ).toThrow(SchemaValidationError);
    expect(() => validateReport({ ...report, score: 90 })).toThrow(SchemaValidationError);
  });

  it('a 2.2.0 document cannot claim 3.0.0, and a 3.0.0 document cannot claim 2.2.0', () => {
    const v2 = sampleResultV2().report;
    const v3 = sampleResult().report;
    expect(() => validateReport({ ...v2, reportVersion: '3.0.0' })).toThrow(SchemaValidationError);
    expect(() => validateReport({ ...v3, reportVersion: '2.2.0' })).toThrow(SchemaValidationError);
  });
});

const WALLET_ITEM = {
  type: 'wallet-request',
  phase: 'post-connect',
  method: 'eth_signTypedData_v4',
  kind: 'permit2',
  frame: 'main',
  origin: 'https://app.example.org',
  outcome: 'signed',
  chainId: 137,
  verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  spender: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
  token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  amount: '1461501637330902918203684832716283019655932542975',
  deadline: '1767225600',
  siweDomain: null,
  unlimited: true,
  longDeadline: false,
  chainIdMismatch: true,
  domainMismatch: false,
  preConnect: false,
  paramsDigest: 'c'.repeat(64),
};

const SUMMARY = {
  evidenceId: 'ev_' + 'b'.repeat(24),
  t: 1234,
  ...Object.fromEntries(
    Object.entries(WALLET_ITEM).filter(([k]) => !['type', 'origin', 'paramsDigest'].includes(k)),
  ),
  findingIds: ['F-0123456789abcdef'],
};

const TIMELINE = {
  origin: 'navigation-start',
  milestones: [
    { event: 'page-loaded', t: 1200 },
    { event: 'connect-started', t: 1500 },
  ],
  recipients: [],
  requestsPerSecond: [
    { t: 0, firstParty: 3, thirdParty: 1 },
    { t: 1000, firstParty: 0, thirdParty: 4 },
  ],
};

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

describe('3.0.0 integrity recomputes recipients (review findings)', () => {
  it('an edited verdict, a dropped or a duplicated recipient fails integrity', () => {
    const { report, bundle } = sampleResult();
    expect(verifyReportIntegrity(report, bundle).ok).toBe(true);
    const r0 = report.recipients[0]!;
    const edited = {
      ...report,
      recipients: [
        { ...r0, verdict: 'expected' as const, rule: 'verdict.cdn@1' },
        ...report.recipients.slice(1),
      ],
    };
    expect(verifyReportIntegrity(edited, bundle).problems.join(' ')).toMatch(/recomputed/);
    expect(
      verifyReportIntegrity({ ...report, recipients: report.recipients.slice(1) }, bundle).ok,
    ).toBe(false);
    expect(
      verifyReportIntegrity({ ...report, recipients: [...report.recipients, r0] }, bundle).ok,
    ).toBe(false);
  });

  it('a page with very many hosts still produces a valid report (no size caps)', () => {
    const c = sampleCapture();
    for (let i = 0; i < 1100; i++)
      c.requests.push(req({ url: `https://h${i}.tracker-example.com/p`, resourceType: 'image' }));
    expect(() => sampleResult({ capture: c })).not.toThrow();
  });
});
