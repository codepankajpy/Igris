/**
 * P05-2/3/4: detectors, the detector contract, evidence bundle determinism,
 * redaction, and the privacy/security separation.
 */
import { describe, expect, it } from 'vitest';
import { canonicalize } from './contracts/canonical.js';
import { DetectorContractError, type Detector, type DraftFinding } from './contracts/detector.js';
import { bundleHash, evidenceId, type CanaryMatchEvidence } from './contracts/evidence.js';
import type { PrivacyFinding, SecurityObservation } from './contracts/report-v2.js';
import { verifyReportIntegrity } from './contracts/verify.js';
import { DEFAULT_DETECTORS, RedactionError, buildScanResult } from './engine.js';
import { securityHeadersDetector, securityHeaderDrafts } from './detectors/security-headers.js';
import { ScoringError, scorePrivacy } from './scoring-v2.js';
import {
  CANARY_A,
  CANARY_B,
  req,
  sampleCapture,
  sampleInput,
  sampleResult,
} from './test-helpers.js';

const evidenceOf = <T>(r: ReturnType<typeof sampleResult>, f: { evidence: { id: string }[] }) =>
  f.evidence.map((e) => r.bundle.items[e.id] as unknown as T);

describe('canary-leak detector', () => {
  const r = sampleResult();
  const canary = r.report.privacy.findings.filter((f) => f.detector === 'canary-leak');

  it('exact leak to analytics: issue / high / confirmed / counted, with redacted evidence', () => {
    const f = canary.find((x) => x.title.includes('api') || x.title.includes('segment.io'))!;
    expect(f).toMatchObject({
      kind: 'issue',
      severity: 'high',
      confidence: 'confirmed',
      countsTowardPrivacyScore: true,
    });
    const [e] = evidenceOf<CanaryMatchEvidence>(r, f);
    expect(e).toMatchObject({
      type: 'canary-match',
      recipientClass: 'analytics',
      location: 'request-body',
      category: 'exact',
    });
    expect(e!.snippet).toContain('<CANARY>');
  });

  it('a retried request is one finding, not two', () => {
    expect(
      canary.filter((f) => f.title === 'Wallet address sent to segment.io (analytics)'),
    ).toHaveLength(1);
  });

  it('hashed leak: one severity lower, ledger charged × hashedMultiplier', () => {
    const f = canary.find((x) => x.title.startsWith('Hashed'))!;
    expect(f).toMatchObject({ severity: 'medium', kind: 'issue' });
    const line = r.report.privacy.ledger.find((l) => l.findingIds.includes(f.id))!;
    expect(line.rule).toBe('leak.error-monitoring × hashedMultiplier');
    expect(line.points).toBe(12.5);
  });

  it('rpc leak is medium with an Anon-RPC remediation', () => {
    const f = canary.find((x) => x.title.includes('rpc-provider'))!;
    expect(f.severity).toBe('medium');
    expect(f.remediation).toMatch(/Anon-RPC/);
  });

  it('storage persistence is an uncounted observation', () => {
    const f = canary.find((x) => x.title.includes('local-storage'))!;
    expect(f).toMatchObject({
      kind: 'observation',
      severity: 'info',
      countsTowardPrivacyScore: false,
    });
  });
});

describe('ip-exposure detector', () => {
  const r = sampleResult();
  const ip = r.report.privacy.findings.filter((f) => f.detector === 'ip-exposure');
  it('one finding per third-party registrable domain, evidence per host', () => {
    expect(ip.map((f) => f.title).sort()).toEqual([
      'Visitor IP exposed to googleapis.com before wallet connect',
      'Visitor IP exposed to infura.io',
      'Visitor IP exposed to segment.io',
      'Visitor IP exposed to sentry.io',
    ]);
    for (const f of ip) expect(f.evidence.length).toBeGreaterThan(0);
  });
  it('ledger reproduces v1 contact penalties (2/domain pre, 3/domain post)', () => {
    const pre = r.report.privacy.ledger.find((l) => l.rule === 'contact.perDomainPreConnect')!;
    const post = r.report.privacy.ledger.find((l) => l.rule === 'contact.perDomainPostConnect')!;
    expect(pre.points).toBe(2);
    expect(post.points).toBe(9);
  });
  it('the evidence carries no volatile request counts', () => {
    const items = Object.values(r.bundle.items).filter((i) => i.type === 'third-party-contact');
    for (const i of items) expect(Object.keys(i)).not.toContain('requestCount');
    expect(r.report.contacts.find((c) => c.host === 'api.segment.io')!.requestCount).toBe(2);
  });
});

describe('security-headers detector (security domain, never scored)', () => {
  const doc = (headers: Record<string, string | null>, url = 'https://app.example.org/') => ({
    type: 'document-headers' as const,
    documentUrl: url,
    status: 200,
    headers: {
      'content-security-policy': null,
      'content-security-policy-report-only': null,
      'strict-transport-security': null,
      'x-frame-options': null,
      ...headers,
    },
  });
  // The always-present 'summary' observation is filtered out of check lists.
  const checks = (ds: DraftFinding[]) =>
    ds
      .map((d) => d.fingerprintInput.check)
      .filter((c) => c !== 'summary')
      .sort();

  it('nothing protective → CSP, framing and HSTS risks', () => {
    expect(checks(securityHeaderDrafts(doc({})))).toEqual([
      'csp-missing',
      'framing-allowed',
      'hsts-missing',
    ]);
  });
  it('all protective headers → only the summary observation (info), evidenced', () => {
    const ds = securityHeaderDrafts(
      doc({
        'content-security-policy': "default-src 'self'; frame-ancestors 'self'",
        'strict-transport-security': 'max-age=1',
      }),
    );
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({
      kind: 'observation',
      severity: 'info',
      fingerprintInput: { check: 'summary' },
    });
    expect(ds[0]!.title).toBe(
      'Main-document security headers: CSP enforced, framing restricted, HSTS',
    );
    expect(ds[0]!.evidence[0]!.type).toBe('document-headers');
  });
  it('X-Frame-Options DENY also prevents framing; ALLOW-FROM does not', () => {
    expect(checks(securityHeaderDrafts(doc({ 'x-frame-options': 'DENY' })))).not.toContain(
      'framing-allowed',
    );
    expect(
      checks(securityHeaderDrafts(doc({ 'x-frame-options': 'ALLOW-FROM https://x' }))),
    ).toContain('framing-allowed');
  });
  it('report-only CSP is a lower-severity risk, not a pass', () => {
    const d = securityHeaderDrafts(
      doc({ 'content-security-policy-report-only': "default-src 'self'" }),
    );
    expect(d.find((x) => x.fingerprintInput.check === 'csp-report-only')!.severity).toBe('low');
  });
  it('plain http: high issue on a public host, nothing on a local dev host', () => {
    expect(checks(securityHeaderDrafts(doc({}, 'http://app.example.org/')))).toContain(
      'plain-http',
    );
    expect(checks(securityHeaderDrafts(doc({}, 'http://localhost:3000/')))).not.toContain(
      'plain-http',
    );
    expect(checks(securityHeaderDrafts(doc({}, 'http://dapp.test:8080/')))).not.toContain(
      'hsts-missing',
    );
  });
  it('emits nothing when the page did not load or no main document was seen', () => {
    expect(sampleResult({ status: 'page-load-failed' }).report.security.observations).toEqual([]);
    const cap = sampleCapture();
    delete cap.mainDocument;
    expect(sampleResult({ capture: cap }).report.security.observations).toEqual([]);
  });

  it('security observations never change the privacy score (P05-2)', () => {
    const withSec = sampleResult();
    const withoutSec = sampleResult({
      detectors: DEFAULT_DETECTORS.filter((d) => d.id !== 'security-headers'),
    });
    expect(withSec.report.security.observations.length).toBeGreaterThan(0);
    expect(withSec.report.privacy.score).toBe(withoutSec.report.privacy.score);
    expect(withSec.report.privacy.ledger).toEqual(withoutSec.report.privacy.ledger);
  });

  it('scorePrivacy refuses security observations at runtime', () => {
    const { report, bundle } = sampleResult();
    const obs = report.security.observations as unknown as PrivacyFinding[];
    expect(() => scorePrivacy(obs, bundle, 'full')).toThrow(ScoringError);
  });
});

describe('detector contract enforcement (P05-3)', () => {
  const draft = (over: Partial<DraftFinding> = {}): DraftFinding => ({
    fingerprintInput: { k: 'x' },
    kind: 'observation',
    severity: 'info',
    confidence: 'confirmed',
    title: 't',
    impact: 'i',
    remediation: 'r',
    evidence: [
      {
        type: 'document-headers',
        documentUrl: 'https://a.org/',
        status: 200,
        headers: {
          'content-security-policy': null,
          'content-security-policy-report-only': null,
          'strict-transport-security': null,
          'x-frame-options': null,
        },
      },
    ],
    countsTowardPrivacyScore: false,
    ...over,
  });
  const detector = (drafts: DraftFinding[], over: Partial<Detector> = {}): Detector => ({
    id: 'test-detector',
    version: '1.0.0',
    domain: 'privacy',
    run: () => drafts,
    ...over,
  });
  const run = (d: Detector) => buildScanResult(sampleInput({ detectors: [d] }));

  it('a finding without evidence fails the run', () => {
    expect(() => run(detector([draft({ evidence: [] })]))).toThrow(/has no evidence/);
  });
  it('schema-invalid evidence fails the run', () => {
    const bad = { ...draft().evidence[0]!, status: 99 } as never;
    expect(() => run(detector([draft({ evidence: [bad] })]))).toThrow(/invalid evidence/);
  });
  it('a security finding that counts toward the score fails the run', () => {
    expect(() =>
      run(detector([draft({ countsTowardPrivacyScore: true })], { domain: 'security' })),
    ).toThrow(DetectorContractError);
  });
  it('a counted privacy finding without a scoring rule fails the run', () => {
    expect(() => run(detector([draft({ countsTowardPrivacyScore: true })]))).toThrow(
      /scoring rule/,
    );
  });
  it('duplicate finding identities fail the run', () => {
    expect(() => run(detector([draft(), draft()]))).toThrow(/duplicate finding identity/);
  });
  it('registering one detector id twice fails', () => {
    expect(() => buildScanResult(sampleInput({ detectors: [detector([]), detector([])] }))).toThrow(
      /twice/,
    );
  });
  it('evidence containing the canary fails the run (redaction invariant)', () => {
    const leaky = draft({
      evidence: [
        {
          type: 'canary-match',
          phase: 'post-connect',
          location: 'url',
          method: 'GET',
          url: `https://t.example/?a=${CANARY_A}`,
          host: 't.example',
          registrableDomain: 't.example',
          recipientClass: 'unknown-third-party',
          encoding: 'checksummed',
          category: 'exact',
          snippet: 'x',
        },
      ],
    });
    expect(() => run(detector([leaky]))).toThrow(RedactionError);
  });
  it('a well-behaved custom detector is accepted and its evidence is content-addressed', () => {
    const { report, bundle } = run(detector([draft()]));
    const f = report.privacy.findings[0]!;
    expect(f.evidence[0]!.id).toBe(evidenceId(draft().evidence[0]!));
    expect(bundle.items[f.evidence[0]!.id]).toEqual(draft().evidence[0]);
  });
});

describe('evidence bundle and determinism (P05-4)', () => {
  it('the same capture yields byte-identical report and bundle', () => {
    const a = sampleResult();
    const b = sampleResult();
    expect(canonicalize(a.bundle)).toBe(canonicalize(b.bundle));
    expect(canonicalize(a.report)).toBe(canonicalize(b.report));
  });

  it('header key order in the capture does not change any hash', () => {
    const cap = sampleCapture();
    cap.requests[2] = req({ ...cap.requests[2]!, headers: { b: '2', a: '1' } });
    const cap2 = sampleCapture();
    cap2.requests[2] = req({ ...cap2.requests[2]!, headers: { a: '1', b: '2' } });
    expect(sampleResult({ capture: cap }).report.evidence.sha256).toBe(
      sampleResult({ capture: cap2 }).report.evidence.sha256,
    );
  });

  it('different canaries, same behaviour → same finding ids AND same evidence hash', () => {
    const a = sampleResult({ canaryAddress: CANARY_A });
    const b = sampleResult({ canaryAddress: CANARY_B });
    const ids = (r: typeof a) => r.report.privacy.findings.map((f) => f.id).sort();
    expect(ids(a)).toEqual(ids(b));
    expect(a.report.evidence.sha256).toBe(b.report.evidence.sha256);
    expect(a.report.scan.canaryAddress).not.toBe(b.report.scan.canaryAddress);
  });

  it('a page nonce inside a snippet changes evidence.sha256 but NOT findingSet.sha256', () => {
    const withNonce = (nonce: string) => {
      const cap = sampleCapture();
      cap.storage = [
        {
          phase: 'post-connect',
          kind: 'local-storage',
          key: 'wagmi.store',
          value: `["${nonce}",{"accounts":["${CANARY_A}"]}]`,
        },
      ];
      return sampleResult({ capture: cap });
    };
    const a = withNonce('93bd40c535f');
    const b = withNonce('d845a1354bd');
    expect(a.report.evidence.sha256).not.toBe(b.report.evidence.sha256);
    expect(a.report.findingSet).toEqual(b.report.findingSet);
  });

  it('the bundle never contains the canary, and the report records the bundle hash', () => {
    const { report, bundle } = sampleResult();
    const text = canonicalize(bundle).toLowerCase();
    expect(text).not.toContain(CANARY_A.slice(2).toLowerCase());
    expect(report.evidence.sha256).toBe(bundleHash(bundle));
    expect(report.evidence.itemCount).toBe(Object.keys(bundle.items).length);
  });

  it('integrity verification passes, and detects tampering', () => {
    const { report, bundle } = sampleResult();
    expect(verifyReportIntegrity(report, bundle)).toMatchObject({ ok: true, problems: [] });
    const tampered = structuredClone(bundle);
    const first = Object.keys(tampered.items)[0]!;
    (tampered.items[first] as { host?: string }).host = 'elsewhere.example';
    const res = verifyReportIntegrity(report, tampered);
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/does not match its content id|bundle hash/);
    const forged = structuredClone(report);
    forged.findingSet = { ...forged.findingSet, count: forged.findingSet.count + 1 };
    expect(verifyReportIntegrity(forged, bundle).problems.join(' ')).toMatch(/findingSet digest/);
  });

  it('page-load-failed: null score, empty ledger, findings still evidenced', () => {
    const { report } = sampleResult({ status: 'page-load-failed' });
    expect(report.privacy.score).toBeNull();
    expect(report.privacy.ledger).toEqual([]);
    expect(report.privacy.coverage).toBe('none');
  });

  it('security observations are typed SecurityObservation with countsTowardPrivacyScore false', () => {
    const obs: SecurityObservation[] = sampleResult().report.security.observations;
    for (const o of obs) expect(o.countsTowardPrivacyScore).toBe(false);
    expect(securityHeadersDetector.domain).toBe('security');
  });
});
