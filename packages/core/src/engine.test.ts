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
import { assess } from './assessment.js';
import {
  DEFAULT_DETECTORS,
  RedactionError,
  buildScanResult,
  pureJsonRpcMethods,
} from './engine.js';
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

describe('first party follows the page that loaded (redirects)', () => {
  // app.example.net redirects to app.example.org; the dApp's own API on
  // example.org receives the address. Found live: app.spark.fi → app.spark.finance.
  const capture = () => {
    const c = sampleCapture();
    c.requests.push(
      req({
        phase: 'post-connect',
        url: `https://api.example.org/v1/address/status?address=${CANARY_A}`,
        resourceType: 'fetch',
      }),
    );
    return c;
  };

  it('a leak to the landed site is a first-party observation, not a third-party issue', () => {
    const r = sampleResult({ target: 'https://app.example.net/', capture: capture() });
    const own = r.report.privacy.findings.filter(
      (f) => f.detector === 'canary-leak' && f.title.includes('api.example.org'),
    );
    expect(own.length).toBeGreaterThan(0);
    for (const f of own)
      expect(f).toMatchObject({ kind: 'observation', countsTowardPrivacyScore: false });
    expect(r.report.contacts.some((c) => c.registrableDomain === 'example.org')).toBe(false);
    expect(r.report.scan.notes).toContain(
      'the target redirected to app.example.org; example.org is treated as first party',
    );
  });

  it('without a redirect nothing changes (no note, same findings)', () => {
    const a = sampleResult();
    expect(a.report.scan.notes).toEqual([]);
    const b = sampleResult({ firstParty: [] });
    expect(b.report.findingSet).toEqual(a.report.findingSet);
  });

  it('third parties are still third parties after a redirect', () => {
    const r = sampleResult({ target: 'https://app.example.net/', capture: capture() });
    const leakDomains = r.report.privacy.findings
      .filter((f) => f.detector === 'canary-leak' && f.countsTowardPrivacyScore)
      .flatMap((f) => evidenceOf<CanaryMatchEvidence>(r, f).map((e) => e.registrableDomain));
    expect(new Set(leakDomains)).toEqual(new Set(['infura.io', 'segment.io', 'sentry.io']));
  });
});

describe('RPC endpoints are recognised by behaviour (JSON-RPC), not only by the DB', () => {
  const rpcCapture = () => {
    const c = sampleCapture();
    c.requests.push(
      req({
        phase: 'post-connect',
        url: 'https://node.mainnet.chain-x.example/',
        method: 'POST',
        resourceType: 'fetch',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [
            { data: `0x70a08231000000000000000000000000${CANARY_A.slice(2).toLowerCase()}` },
            'latest',
          ],
        }),
      }),
      // A non-RPC JSON POST to another unknown host stays unknown.
      req({
        phase: 'post-connect',
        url: 'https://api.tracker-y.example/collect',
        method: 'POST',
        resourceType: 'fetch',
        body: JSON.stringify({ user: CANARY_A, method: 'eth_call' }),
      }),
    );
    return c;
  };

  it('an unknown host answering eth_* JSON-RPC is an rpc-provider; the report says why', () => {
    const r = sampleResult({ capture: rpcCapture() });
    const contact = r.report.contacts.find((c) => c.host === 'node.mainnet.chain-x.example');
    expect(contact?.class).toBe('rpc-provider');
    const leak = r.report.privacy.findings.find((f) => f.title.includes('chain-x.example'));
    expect(leak?.severity).toBe('medium');
    expect(r.report.scan.notes.join(' ')).toContain('chain-x.example (eth_call)');
  });

  it('JSON without a jsonrpc envelope does not make a host an RPC provider', () => {
    const r = sampleResult({ capture: rpcCapture() });
    const contact = r.report.contacts.find((c) => c.host === 'api.tracker-y.example');
    expect(contact?.class).toBe('unknown-third-party');
  });

  it('the third-party DB always wins over behaviour', () => {
    const r = sampleResult();
    expect(r.report.contacts.find((c) => c.host === 'mainnet.infura.io')?.class).toBe(
      'rpc-provider',
    );
    expect(r.report.contacts.find((c) => c.host === 'api.segment.io')?.class).toBe('analytics');
    expect(r.report.scan.notes).toEqual([]);
  });
});

describe('behaviour rule cannot soften a tracker leak (review findings)', () => {
  const post = (url: string, body: unknown) =>
    req({
      phase: 'post-connect',
      url,
      method: 'POST',
      resourceType: 'fetch',
      body: JSON.stringify(body),
    });
  const rpc = (method = 'eth_chainId') => ({ jsonrpc: '2.0', id: 1, method, params: [] });
  const leakOf = (r: ReturnType<typeof sampleResult>, domain: string) =>
    r.report.privacy.findings.filter(
      (f) => f.detector === 'canary-leak' && f.countsTowardPrivacyScore && f.title.includes(domain),
    );
  const withRequests = (...extra: ReturnType<typeof req>[]) => {
    const c = sampleCapture();
    c.requests.push(...extra);
    return c;
  };

  it('a tracker that also answers one RPC call stays unidentified (high)', () => {
    const r = sampleResult({
      capture: withRequests(
        post('https://collect.tracker.example/e', { event: 'wallet_connected', address: CANARY_A }),
        post('https://collect.tracker.example/ping', rpc()),
      ),
    });
    const [f] = leakOf(r, 'tracker.example');
    expect(f).toMatchObject({ severity: 'high' });
    expect(f!.title).toContain('unknown-third-party');
  });

  it('a mixed batch (RPC + analytics event) is not RPC', () => {
    const r = sampleResult({
      capture: withRequests(
        post('https://collect.tracker.example/batch', [
          rpc(),
          { type: 'identify', userId: CANARY_A },
        ]),
      ),
    });
    expect(leakOf(r, 'tracker.example')[0]).toMatchObject({ severity: 'high' });
  });

  it('a domain with an RPC host and a REST host is classified once (not charged twice)', () => {
    const r = sampleResult({
      capture: withRequests(
        post('https://rpc.vendor.example/', rpc('eth_getBalance')),
        req({
          phase: 'post-connect',
          url: `https://api.vendor.example/v1/user?addr=${CANARY_A}`,
          resourceType: 'fetch',
        }),
      ),
    });
    const lines = r.report.privacy.ledger.filter(
      (l) => l.rule.startsWith('leak.') && l.label.includes('vendor.example'),
    );
    expect(lines.map((l) => l.rule)).toEqual(['leak.unknown-third-party']);
  });

  it('JSON-RPC over WebSocket qualifies like HTTP', () => {
    const c = sampleCapture();
    c.wsFrames.push({
      phase: 'post-connect',
      url: 'wss://ws.chain.example/',
      direction: 'sent',
      payload: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [CANARY_A, 'latest'],
      }),
    });
    const r = sampleResult({ capture: c });
    expect(leakOf(r, 'chain.example')[0]).toMatchObject({ severity: 'medium' });
  });

  it('body-less preflights do not disqualify an RPC domain', () => {
    const r = sampleResult({
      capture: withRequests(
        req({
          phase: 'post-connect',
          url: 'https://node.chain-z.example/',
          method: 'OPTIONS',
          resourceType: 'preflight',
        }),
        post('https://node.chain-z.example/', {
          ...rpc('eth_call'),
          params: [
            { data: `0x70a08231000000000000000000000000${CANARY_A.slice(2).toLowerCase()}` },
          ],
        }),
      ),
    });
    expect(r.report.contacts.find((c) => c.host === 'node.chain-z.example')?.class).toBe(
      'rpc-provider',
    );
  });
});

describe('pureJsonRpcMethods', () => {
  it('accepts single calls and pure batches only', () => {
    expect(pureJsonRpcMethods('{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[]}')).toEqual([
      'eth_call',
    ]);
    expect(
      pureJsonRpcMethods(
        '[{"jsonrpc":"2.0","method":"eth_chainId"},{"jsonrpc":"2.0","method":"net_version"}]',
      ),
    ).toEqual(['eth_chainId', 'net_version']);
    expect(pureJsonRpcMethods('[]')).toBeNull();
    expect(pureJsonRpcMethods('{"method":"eth_call"}')).toBeNull();
    expect(pureJsonRpcMethods('{"jsonrpc":"2.0","method":"track"}')).toBeNull();
    expect(pureJsonRpcMethods('not json')).toBeNull();
  });
});

describe('wallet-sdk recipients (report 2.2.0)', () => {
  const capture = () => {
    const c = sampleCapture();
    c.requests.push(
      req({
        phase: 'post-connect',
        url: 'https://app.walletsdk.example/api/v0/sdk/connect',
        method: 'POST',
        resourceType: 'fetch',
        body: JSON.stringify({ address: CANARY_A, walletName: 'igris' }),
      }),
    );
    return c;
  };
  const db = [
    ...sampleInput().thirdPartyDb,
    {
      name: 'Example wallet SDK',
      class: 'wallet-sdk' as const,
      domains: ['walletsdk.example'],
      source: 'https://walletsdk.example/docs',
    },
  ];

  it('a leak to a wallet SDK is medium, charged 20, with SDK-specific remediation', () => {
    const r = sampleResult({ capture: capture(), thirdPartyDb: db });
    const f = r.report.privacy.findings.find((x) => x.title.includes('walletsdk.example'))!;
    expect(f).toMatchObject({ severity: 'medium', kind: 'issue', countsTowardPrivacyScore: true });
    expect(f.remediation).toMatch(/SDK vendor/);
    const line = r.report.privacy.ledger.find((l) => l.findingIds.includes(f.id))!;
    expect(line).toMatchObject({ rule: 'leak.wallet-sdk', points: 20 });
    expect(r.report.contacts.find((c) => c.host === 'app.walletsdk.example')?.class).toBe(
      'wallet-sdk',
    );
    expect(r.report.reportVersion).toBe('2.2.0');
    expect(r.bundle.bundleVersion).toBe('igris.evidence.v3');
  });

  it('a wallet SDK alone is not the "tracking or unidentified" (critical) case', () => {
    const only = sampleCapture();
    only.requests = only.requests.filter((q) => !/segment|sentry|infura/.test(q.url));
    only.requests.push(...capture().requests.slice(-1));
    const r = sampleResult({ capture: only, thirdPartyDb: db });
    expect(assess(r.report, r.bundle).level).toBe('high');
  });
});
