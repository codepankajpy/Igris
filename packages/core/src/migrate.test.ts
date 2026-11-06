/**
 * P05-5: v1 → v2 migration regression over every frozen v1 report
 * (test-fixtures/v1, see its README for provenance).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { canonicalize } from './contracts/canonical.js';
import type { CanaryMatchEvidence, ThirdPartyContactEvidence } from './contracts/evidence.js';
import { validateEvidenceBundle, validateReportV2 } from './contracts/validate.js';
import { verifyReportIntegrity } from './contracts/verify.js';
import { MigrationError, isReportV1, migrateReportV1toV2 } from './migrate.js';
import type { Report as ReportV1 } from './report.js';
import { scoreReport } from './scoring.js';

const DIR = fileURLToPath(new URL('../test-fixtures/v1/', import.meta.url));
const FIXTURES = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({ name: f, v1: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as ReportV1 }));

describe('fixtures are present', () => {
  it('covers 1.0.0 and 1.1.0, completed, partial and failed scans, real and fixture targets', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(9);
    const versions = new Set(FIXTURES.map((f) => f.v1.reportVersion));
    expect(versions).toEqual(new Set(['1.0.0', '1.1.0']));
    const statuses = new Set(FIXTURES.map((f) => f.v1.status));
    expect(statuses).toEqual(new Set(['completed', 'wallet-connect-failed', 'page-load-failed']));
  });
});

for (const { name, v1 } of FIXTURES) {
  describe(`migrate ${name}`, () => {
    const { report, bundle } = migrateReportV1toV2(v1);

    it('validates against the v2 report and evidence schemas, and integrity holds', () => {
      expect(() => validateReportV2(report)).not.toThrow();
      expect(() => validateEvidenceBundle(bundle)).not.toThrow();
      expect(verifyReportIntegrity(report, bundle)).toMatchObject({ ok: true, problems: [] });
      expect(report.migratedFrom).toBe(v1.reportVersion);
      expect(report.scan.egress).toBe('unknown');
    });

    it('preserves every v1 finding exactly once, fields verbatim', () => {
      const canary = report.privacy.findings.filter((f) => f.detector === 'canary-leak');
      expect(canary).toHaveLength(v1.findings.length);
      const items = canary.map((f) => bundle.items[f.evidence[0]!.id] as CanaryMatchEvidence);
      for (const f1 of v1.findings) {
        const match = items.filter(
          (e) =>
            e.phase === f1.phase &&
            e.location === f1.location &&
            e.method === f1.method &&
            e.url === f1.url &&
            e.host === f1.host &&
            e.registrableDomain === f1.registrableDomain &&
            e.recipientClass === f1.class &&
            e.encoding === f1.encoding &&
            e.category === f1.category &&
            e.snippet === f1.snippet,
        );
        expect(match, `v1 finding ${f1.id}`).toHaveLength(1);
        const v2f = canary[items.indexOf(match[0]!)]!;
        expect(v2f.countsTowardPrivacyScore).toBe(f1.countsTowardScore);
      }
    });

    it('preserves every third party (as ip-exposure evidence) and the contact telemetry', () => {
      const hosts = Object.values(bundle.items)
        .filter((i): i is ThirdPartyContactEvidence => i.type === 'third-party-contact')
        .map((i) => i.host)
        .sort();
      const real = v1.thirdParties.filter((t) => t.host !== ''); // see the empty-host defect test
      expect(hosts).toEqual(
        real
          .filter((t) => t.class !== 'first-party')
          .map((t) => t.host)
          .sort(),
      );
      expect(report.contacts).toEqual(real);
    });

    if (v1.status === 'page-load-failed') {
      it('a v1 page-load-failed report has no score in v2 (1.0.0 wrongly scored it)', () => {
        expect(report.privacy.score).toBeNull();
        expect(report.privacy.coverage).toBe('none');
        if (v1.score !== null) expect(report.scan.notes.join(' ')).toMatch(/dropped/);
      });
    } else if (v1.thirdParties.some((t) => t.host === '')) {
      it('known v1 defect: empty-hostname contacts removed; score change is stated, with its reason', () => {
        const fixed = { ...v1, thirdParties: v1.thirdParties.filter((t) => t.host !== '') };
        const expected = scoreReport(fixed.findings, fixed.thirdParties).score;
        expect(report.privacy.score).toBe(expected);
        const notes = report.scan.notes.join(' ');
        expect(notes).toMatch(/empty hostname/);
        if (expected !== v1.score)
          expect(notes).toContain(`privacy score ${String(v1.score)} → ${expected}`);
      });
    } else {
      it(`privacy score is identical to v1 (${String(v1.score)})`, () => {
        expect(report.privacy.score).toBe(v1.score);
        // And identical to recomputing v1's own scoring on the v1 data.
        expect(report.privacy.score).toBe(scoreReport(v1.findings, v1.thirdParties).score);
        expect(report.privacy.ledger.map((l) => [l.rule, l.points])).toEqual(
          v1.ledger.map((l) => [l.rule, l.points]),
        );
      });
    }

    it('does not invent data: security headers are not migrated (stated in notes)', () => {
      expect(report.security.observations).toEqual([]);
      if (v1.securityHeaders)
        expect(report.scan.notes.join(' ')).toMatch(/security headers not migrated/);
    });

    it('is deterministic: migrating twice gives byte-identical output', () => {
      const again = migrateReportV1toV2(v1);
      expect(canonicalize(again.report)).toBe(canonicalize(report));
      expect(canonicalize(again.bundle)).toBe(canonicalize(bundle));
    });

    it('the bundle contains no canary', () => {
      expect(canonicalize(bundle).toLowerCase()).not.toContain(
        v1.canaryAddress.slice(2).toLowerCase(),
      );
    });
  });
}

describe('migration refuses rather than guesses', () => {
  const leaky = FIXTURES.find((f) => f.name === 'leaky-1.1.0.json')!.v1;

  it('a tampered score (v1 score that v2 cannot reproduce) is refused', () => {
    expect(() => migrateReportV1toV2({ ...leaky, score: 55 })).toThrow(MigrationError);
  });
  it('a non-v1 document is refused', () => {
    expect(() => migrateReportV1toV2({ reportVersion: '2.0.0' })).toThrow(MigrationError);
    expect(() => migrateReportV1toV2({ ...leaky, reportVersion: '1.9.0' })).toThrow(MigrationError);
    expect(() => migrateReportV1toV2({ ...leaky, findings: 'x' })).toThrow(MigrationError);
  });
  it('detects v1 by version', () => {
    expect(isReportV1(leaky)).toBe(true);
    expect(isReportV1({ reportVersion: '2.0.0' })).toBe(false);
  });
  it('1.0.0 telemetry: frame count moved to wsFrames, connections unknown', () => {
    const r = FIXTURES.find((f) => f.v1.reportVersion === '1.0.0' && f.v1.summary)!.v1;
    const { report } = migrateReportV1toV2(r);
    expect(report.telemetry).not.toBeNull();
    expect(report.telemetry!.wsConnections).toBeNull();
    expect(report.telemetry!.wsFrames).toBe(r.summary!.wsConnections);
  });
  it('no v1 telemetry → telemetry null with a note (no invented zeros)', () => {
    const r = FIXTURES.find((f) => !f.v1.summary);
    if (!r) return;
    const { report } = migrateReportV1toV2(r.v1);
    expect(report.telemetry).toBeNull();
    expect(report.scan.notes.join(' ')).toMatch(/no telemetry/);
  });
});
