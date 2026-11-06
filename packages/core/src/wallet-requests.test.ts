/* eslint-disable @typescript-eslint/no-explicit-any -- hostile-document mutations in tests */
/**
 * The wallet-requests detector (security) and the engine's walletRequests:
 * findings per the design table, evidence for every request, summaries,
 * integrity, canary-freeness and the draft-3.0.0 upgrade.
 */
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, getAddress, keccak256, stringToHex } from 'viem';
import { buildCanaryForms } from './encodings.js';
import { findCanary } from './detect.js';
import { canonicalize } from './contracts/canonical.js';
import { bundleHash } from './contracts/evidence.js';
import type { Capture } from './contracts/capture.js';
import type { ReportV3 } from './contracts/report-v3.js';
import { validateEvidenceBundle, validateReport } from './contracts/validate.js';
import { verifyReportIntegrity } from './contracts/verify.js';
import {
  PERMIT2_ADDRESS,
  type CapturedWalletRequest,
  type RecordedWalletMethod,
  type WalletRequestEvidence,
} from './contracts/wallet-request.js';
import {
  WALLET_REQUESTS_DETECTOR_ID,
  walletRequestDrafts,
  walletRequestsDetector,
} from './detectors/wallet-requests.js';
import { DEFAULT_DETECTORS, type ScanResult } from './engine.js';
import { MigrationError, migrateToCurrent } from './migrate.js';
import { CANARY_A, CANARY_B, sampleCapture, sampleResult } from './test-helpers.js';
import {
  APPROVE_SELECTOR,
  MAX_UINT160,
  MAX_UINT256,
  SET_APPROVAL_FOR_ALL_SELECTOR,
  decodeWalletRequests,
} from './walletreq.js';

const SCAN = Date.parse('2026-11-06T00:00:00.000Z') / 1000;
const DAY = 86_400;
const SPENDER = getAddress('0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad');
const USDC = getAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
const NFT = getAddress('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d');

function cap(
  method: RecordedWalletMethod,
  params: unknown,
  over: Partial<CapturedWalletRequest> = {},
): CapturedWalletRequest {
  return {
    phase: 'post-connect',
    t: 1000,
    method,
    params: JSON.stringify(params),
    frame: 'main',
    origin: 'https://app.example.org',
    outcome: 'signed',
    ...over,
  };
}

const siwe = (domain: string, canary: string, chain = 1) =>
  `${domain} wants you to sign in with your Ethereum account:\n${canary}\n\nSign in.\n\nURI: https://${domain}\nVersion: 1\nChain ID: ${chain}\nNonce: 1\nIssued At: 2026-11-06T00:00:00Z`;

const typed = (primaryType: string, message: object, domain: object) => ({
  types: { EIP712Domain: [] },
  primaryType,
  domain,
  message,
});

const permit2 = (amount: string, expiration: number, chainId: number) =>
  JSON.stringify(
    typed(
      'PermitSingle',
      {
        details: { token: USDC, amount, expiration, nonce: 0 },
        spender: SPENDER,
        sigDeadline: SCAN + 60,
      },
      { name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS },
    ),
  );

const eip2612 = (owner: string, value: string, deadline: number) =>
  JSON.stringify(
    typed(
      'Permit',
      { owner, spender: SPENDER, value, nonce: 0, deadline },
      { chainId: 1, verifyingContract: USDC },
    ),
  );

const approveTx = (amount: bigint, from: string) => [
  {
    from,
    to: USDC,
    data:
      APPROVE_SELECTOR +
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [SPENDER, amount]).slice(2),
  },
];

/** The fixture's flow (connect, foreign SIWE, unlimited Permit2 on the wrong chain, approve MAX). */
function flow(canary: string): CapturedWalletRequest[] {
  return [
    cap('eth_requestAccounts', [], { outcome: 'answered', t: 900 }),
    cap('personal_sign', [stringToHex(siwe('evil.example', canary)), canary], { t: 1200 }),
    cap('eth_signTypedData_v4', [canary, permit2(MAX_UINT160.toString(), SCAN + 3600, 137)], {
      t: 1300,
    }),
    cap('eth_sendTransaction', approveTx(MAX_UINT256, canary), { outcome: 'rejected', t: 1400 }),
  ];
}

function withRequests(requests: CapturedWalletRequest[] | undefined, canary = CANARY_A): Capture {
  const c = sampleCapture(canary);
  if (requests !== undefined) c.walletRequests = requests;
  return c;
}

const run = (requests: CapturedWalletRequest[], canary = CANARY_A): ScanResult =>
  sampleResult({ canaryAddress: canary, capture: withRequests(requests, canary) });

const walletFindings = (r: ScanResult) =>
  r.report.security.observations.filter((f) => f.detector === WALLET_REQUESTS_DETECTOR_ID);

/** Drafts for a list of requests, decoded against the standard context. */
function drafts(requests: CapturedWalletRequest[]) {
  return walletRequestDrafts(
    decodeWalletRequests(requests, {
      canary: buildCanaryForms(CANARY_A),
      pageOrigin: 'https://app.example.org',
      chainId: 1,
      scanTime: SCAN,
    }),
  );
}
const connect = cap('eth_requestAccounts', [], { outcome: 'answered' });

describe('wallet-requests detector: the design table', () => {
  it('is registered in DEFAULT_DETECTORS as a security detector 1.0.0', () => {
    expect(DEFAULT_DETECTORS).toContain(walletRequestsDetector);
    expect(walletRequestsDetector).toMatchObject({
      id: 'wallet-requests',
      version: '1.0.0',
      domain: 'security',
    });
  });

  const table: Array<
    [string, CapturedWalletRequest[], { kind: string; severity: string; title: RegExp }]
  > = [
    [
      'eth_sign',
      [connect, cap('eth_sign', [CANARY_A, '0x' + '11'.repeat(32)], { outcome: 'rejected' })],
      { kind: 'risk', severity: 'high', title: /eth_sign raw data \(a blind signature\)/ },
    ],
    [
      'blind hash',
      [connect, cap('personal_sign', [keccak256(stringToHex('order 42')), CANARY_A])],
      { kind: 'risk', severity: 'medium', title: /unreadable hash with personal_sign/ },
    ],
    [
      'unlimited Permit2',
      [
        connect,
        cap('eth_signTypedData_v4', [CANARY_A, permit2(MAX_UINT160.toString(), SCAN + 60, 1)]),
      ],
      { kind: 'risk', severity: 'high', title: /unlimited token permit to 0x3fC9…7FAD/ },
    ],
    [
      'unlimited EIP-2612 permit',
      [
        connect,
        cap('eth_signTypedData_v4', [
          CANARY_A,
          eip2612(CANARY_A, MAX_UINT256.toString(), SCAN + 60),
        ]),
      ],
      { kind: 'risk', severity: 'high', title: /unlimited token permit/ },
    ],
    [
      'long-lived bounded permit',
      [connect, cap('eth_signTypedData_v4', [CANARY_A, permit2('10', SCAN + 90 * DAY, 1)])],
      { kind: 'risk', severity: 'medium', title: /^Token permit valid for more than 30 days$/ },
    ],
    [
      'unlimited approve',
      [
        connect,
        cap('eth_sendTransaction', approveTx(MAX_UINT256, CANARY_A), { outcome: 'rejected' }),
      ],
      {
        kind: 'risk',
        severity: 'high',
        title: /approve unlimited spending of 0xA0b8…eB48 by 0x3fC9…7FAD/,
      },
    ],
    [
      'setApprovalForAll',
      [
        connect,
        cap('eth_sendTransaction', [
          {
            to: NFT,
            data:
              SET_APPROVAL_FOR_ALL_SELECTOR +
              encodeAbiParameters([{ type: 'address' }, { type: 'bool' }], [SPENDER, true]).slice(
                2,
              ),
          },
        ]),
      ],
      { kind: 'risk', severity: 'high', title: /approve all NFTs of 0xBC4C…f13D/ },
    ],
    [
      'SIWE for another site',
      [connect, cap('personal_sign', [siwe('evil.example', CANARY_A), CANARY_A])],
      {
        kind: 'risk',
        severity: 'high',
        title: /^Sign-in message is for a different site \(evil\.example\)$/,
      },
    ],
    [
      'chain mismatch',
      [
        connect,
        cap('eth_signTypedData_v4', [CANARY_A, JSON.stringify(typed('Mail', {}, { chainId: 10 }))]),
      ],
      {
        kind: 'risk',
        severity: 'medium',
        title: /^Signature request names chain 10 while the wallet is on chain 1$/,
      },
    ],
    [
      'transaction chain mismatch',
      [
        connect,
        cap('eth_sendTransaction', [{ to: SPENDER, value: '0x1', chainId: 10 }], {
          outcome: 'rejected',
        }),
      ],
      { kind: 'risk', severity: 'medium', title: /^Transaction request names chain 10/ },
    ],
    [
      'typed data before connecting',
      [cap('eth_signTypedData_v4', [CANARY_A, JSON.stringify(typed('Mail', {}, { chainId: 1 }))])],
      { kind: 'risk', severity: 'medium', title: /^Asked for a signature before connecting$/ },
    ],
    [
      'approve before connecting',
      [cap('eth_sendTransaction', approveTx(5n, CANARY_A), { outcome: 'rejected' })],
      { kind: 'risk', severity: 'medium', title: /^Asked for an approval before connecting$/ },
    ],
    [
      'clean SIWE',
      [connect, cap('personal_sign', [siwe('app.example.org', CANARY_A), CANARY_A])],
      {
        kind: 'observation',
        severity: 'info',
        title: /^Asked to sign in with Ethereum \(app\.example\.org\)$/,
      },
    ],
    [
      'readable message',
      [connect, cap('personal_sign', ['Welcome to the app', CANARY_A])],
      { kind: 'observation', severity: 'info', title: /^Asked to sign a message$/ },
    ],
  ];
  for (const [name, requests, expected] of table) {
    it(name, () => {
      const out = drafts(requests);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        kind: expected.kind,
        severity: expected.severity,
        confidence: 'confirmed',
        countsTowardPrivacyScore: false,
      });
      expect(out[0]!.title).toMatch(expected.title);
    });
  }

  it('no finding for connect, chain switches, a bounded short permit or a plain transaction', () => {
    expect(
      drafts([
        connect,
        cap('wallet_switchEthereumChain', [{ chainId: '0x89' }], { outcome: 'answered' }),
        cap('wallet_addEthereumChain', [{ chainId: '0xa' }], { outcome: 'answered' }),
        cap('wallet_watchAsset', [{ options: { address: USDC } }], { outcome: 'error' }),
        cap('eth_signTypedData_v4', [CANARY_A, permit2('10', SCAN + 3600, 137)]),
        cap('eth_sendTransaction', [{ to: SPENDER, value: '0x1' }], { outcome: 'rejected' }),
        cap('eth_sendTransaction', approveTx(10n, CANARY_A), { outcome: 'rejected' }),
      ]),
    ).toEqual([]);
  });

  it('a request matching several rows is ONE finding: the worst row titles it, all explain it', () => {
    const out = drafts([
      cap('eth_signTypedData_v4', [
        CANARY_A,
        permit2(MAX_UINT160.toString(), SCAN + 90 * DAY, 137),
      ]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('high');
    expect(out[0]!.title).toMatch(/unlimited token permit/);
    expect(out[0]!.impact).toMatch(/different chain/);
    expect(out[0]!.impact).toMatch(/before the user had connected/);
    // Unlimited wins over long-deadline (that row is for bounded permits only).
    expect(out[0]!.impact).not.toMatch(/long time/);
    expect(out[0]!.fingerprintInput).toEqual({
      method: 'eth_signTypedData_v4',
      kind: 'permit2',
      verifyingContract: PERMIT2_ADDRESS,
      spender: SPENDER,
      token: USDC,
      flags: 'unlimited,longDeadline,chainIdMismatch,preConnect',
    });
  });

  it('a SIWE naming another chain is a risk, not the clean observation', () => {
    const out = drafts([
      connect,
      cap('personal_sign', [siwe('app.example.org', CANARY_A, 10), CANARY_A]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'risk', severity: 'medium' });
  });

  it('a SIWE before connecting stays the clean observation (no preConnect row for SIWE)', () => {
    const out = drafts([cap('personal_sign', [siwe('app.example.org', CANARY_A), CANARY_A])]);
    expect(out[0]).toMatchObject({ kind: 'observation', severity: 'info' });
  });

  it('requests with one identity share one finding (fingerprints stay unique)', () => {
    const mail = (chainId: number) => JSON.stringify(typed('Mail', {}, { chainId }));
    const out = drafts([
      connect,
      cap('eth_signTypedData_v4', [CANARY_A, mail(10)]),
      cap('eth_signTypedData_v4', [CANARY_A, mail(137)]),
      cap('eth_signTypedData_v4', [CANARY_A, mail(10)]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toHaveLength(3); // two distinct items; the engine dedupes ids
  });

  it('reports nothing when the page did not load', () => {
    const r = sampleResult({ status: 'page-load-failed', capture: withRequests(flow(CANARY_A)) });
    expect(walletFindings(r)).toEqual([]);
    expect(r.report.walletRequests).toEqual([]);
    expect(Object.values(r.bundle.items).some((i) => i.type === 'wallet-request')).toBe(false);
  });
});

describe('engine: walletRequests and evidence v4', () => {
  it('the fixture flow: every request is evidence, summarised in order with its findings', () => {
    const r = run(flow(CANARY_A));
    expect(() => validateReport(r.report)).not.toThrow();
    expect(() => validateEvidenceBundle(r.bundle)).not.toThrow();
    expect(verifyReportIntegrity(r.report, r.bundle)).toMatchObject({ ok: true, problems: [] });
    expect(r.bundle.bundleVersion).toBe('igris.evidence.v4');
    expect(r.report.detectors.map((d) => d.id)).toContain('wallet-requests');

    const w = r.report.walletRequests!;
    expect(w.map((s) => [s.kind, s.t])).toEqual([
      ['connect', 900],
      ['siwe', 1200],
      ['permit2', 1300],
      ['approve', 1400],
    ]);
    expect(w[0]!.findingIds).toEqual([]);
    expect(w[1]).toMatchObject({
      siweDomain: 'evil.example',
      domainMismatch: true,
      preConnect: false,
    });
    expect(w[2]).toMatchObject({
      unlimited: true,
      chainId: 137,
      chainIdMismatch: true,
      spender: SPENDER,
      token: USDC,
      verifyingContract: PERMIT2_ADDRESS,
    });
    expect(w[3]).toMatchObject({
      unlimited: true,
      outcome: 'rejected',
      amount: MAX_UINT256.toString(),
    });
    for (const s of w) {
      expect(r.bundle.items[s.evidenceId]?.type).toBe('wallet-request');
    }

    const found = walletFindings(r);
    expect(found.map((f) => f.severity).sort()).toEqual(['high', 'high', 'high']);
    for (const s of w.slice(1)) {
      expect(s.findingIds).toHaveLength(1);
      expect(found.map((f) => f.id)).toContain(s.findingIds[0]);
    }
  });

  it('wallet findings never reach recipients or verdicts', () => {
    const without = sampleResult();
    const withWallet = run(flow(CANARY_A));
    expect(withWallet.report.recipients).toEqual(without.report.recipients);
    expect(withWallet.report.privacy).toEqual(without.report.privacy);
    const walletIds = new Set(walletFindings(withWallet).map((f) => f.id));
    for (const rec of withWallet.report.recipients)
      for (const id of rec.findingIds) expect(walletIds.has(id)).toBe(false);
  });

  it('the canary (permit owner, SIWE address, tx from, origin) never reaches the evidence', () => {
    const requests = [
      ...flow(CANARY_A),
      cap('eth_signTypedData_v4', [CANARY_A, eip2612(CANARY_A, MAX_UINT256.toString(), SCAN + 60)]),
      cap(
        'personal_sign',
        [siwe(`${CANARY_A.slice(2).toLowerCase()}.evil.example`, CANARY_A), CANARY_A],
        {
          origin: `https://x.example/?a=${CANARY_A}`,
        },
      ),
    ];
    const r = run(requests);
    const forms = buildCanaryForms(CANARY_A);
    const items = Object.values(r.bundle.items).filter((i) => i.type === 'wallet-request');
    expect(items.length).toBe(requests.length);
    expect(findCanary(canonicalize(r.bundle), forms)).toEqual([]);
    expect(findCanary(canonicalize(r.report.walletRequests), forms)).toEqual([]);
    for (const f of walletFindings(r))
      expect(findCanary(`${f.title} ${f.impact} ${f.remediation}`, forms)).toEqual([]);
  });

  it('the same behaviour gives the same findings and items with another canary', () => {
    const a = run(flow(CANARY_A), CANARY_A);
    const b = run(flow(CANARY_B), CANARY_B);
    expect(walletFindings(a).map((f) => f.id)).toEqual(walletFindings(b).map((f) => f.id));
    expect(a.report.walletRequests!.map((s) => s.evidenceId)).toEqual(
      b.report.walletRequests!.map((s) => s.evidenceId),
    );
  });

  it('null when the capture recorded no wallet requests; [] when it recorded none made', () => {
    expect(sampleResult().report.walletRequests).toBeNull();
    expect(run([]).report.walletRequests).toEqual([]);
  });

  it('identical requests share one evidence item but keep one summary each', () => {
    const msg = cap('personal_sign', ['hello', CANARY_A]);
    const r = run([connect, msg, { ...msg, t: 2000 }]);
    const w = r.report.walletRequests!;
    expect(w).toHaveLength(3);
    expect(w[1]!.evidenceId).toBe(w[2]!.evidenceId);
    expect(w.map((s) => s.t)).toEqual([1000, 1000, 2000]);
    expect(verifyReportIntegrity(r.report, r.bundle).ok).toBe(true);
  });

  it('caps at 500 requests and says so', () => {
    const many = Array.from({ length: 503 }, (_, i) =>
      cap('personal_sign', [`msg ${i}`, CANARY_A]),
    );
    const r = run(many);
    expect(r.report.walletRequests).toHaveLength(500);
    expect(r.report.scan.notes.join(' ')).toMatch(/only the first 500 are reported \(3 more/);
    expect(() => validateReport(r.report)).not.toThrow();
  });

  it('a request timestamp that is not an integer ms is reported as null', () => {
    const r = run([
      cap('personal_sign', ['hi', CANARY_A], { t: 1.5 }),
      cap('eth_requestAccounts', [], { t: undefined as any }),
    ]);
    expect(r.report.walletRequests!.map((s) => s.t)).toEqual([null, null]);
  });
});

describe('integrity of walletRequests', () => {
  const base = () => run(flow(CANARY_A));
  const problems = (report: ReportV3, bundle = base().bundle) =>
    verifyReportIntegrity(report, bundle).problems.join(' | ');

  it('an edited decoded field fails', () => {
    const { report, bundle } = base();
    const w = structuredClone(report.walletRequests!);
    w[2]!.unlimited = false;
    expect(problems({ ...report, walletRequests: w }, bundle)).toMatch(
      /walletRequests\[2\]\.unlimited/,
    );
  });

  it('a dropped or added finding id fails', () => {
    const { report, bundle } = base();
    const dropped = structuredClone(report.walletRequests!);
    dropped[1]!.findingIds = [];
    expect(problems({ ...report, walletRequests: dropped }, bundle)).toMatch(/findingIds/);
    const added = structuredClone(report.walletRequests!);
    added[0]!.findingIds = [report.walletRequests![1]!.findingIds[0]!];
    expect(problems({ ...report, walletRequests: added }, bundle)).toMatch(/findingIds/);
  });

  it('a summary pointing at a missing or non-wallet item fails', () => {
    const { report, bundle } = base();
    const other = Object.entries(bundle.items).find(([, i]) => i.type === 'canary-match')![0];
    const w = structuredClone(report.walletRequests!);
    w[0]!.evidenceId = other;
    expect(problems({ ...report, walletRequests: w }, bundle)).toMatch(/not a wallet-request item/);
    w[0]!.evidenceId = 'ev_' + '0'.repeat(24);
    expect(problems({ ...report, walletRequests: w }, bundle)).toMatch(/not a wallet-request item/);
  });

  it('a wallet-request item nobody summarises, or walletRequests null with items, fails', () => {
    const { report, bundle } = base();
    expect(
      problems({ ...report, walletRequests: report.walletRequests!.slice(1) }, bundle),
    ).toMatch(/is in no walletRequests entry/);
    expect(problems({ ...report, walletRequests: null }, bundle)).toMatch(/walletRequests is null/);
  });
});

describe('migrateToCurrent and draft 3.0.0 reports (before walletRequests)', () => {
  /** A 3.0.0 report as written before this change: no walletRequests, a v3 bundle. */
  function draft(): { report: Record<string, unknown>; bundle: any } {
    const { report, bundle } = sampleResult();
    const v3 = { bundleVersion: 'igris.evidence.v3', items: bundle.items };
    const { walletRequests: _w, ...rest } = report;
    return {
      report: {
        ...rest,
        evidence: {
          ...report.evidence,
          bundleVersion: 'igris.evidence.v3',
          sha256: bundleHash(v3 as any),
        },
      },
      bundle: v3,
    };
  }

  it('a current 3.0.0 report is returned as is', () => {
    const r = run(flow(CANARY_A));
    const out = migrateToCurrent(r.report, r.bundle);
    expect(out.report).toEqual(r.report);
    expect(out.migratedFrom).toBeUndefined();
  });

  it('a draft is upgraded: walletRequests null, bundle re-labelled v4, a note says so', () => {
    const d = draft();
    expect(() => validateReport(d.report)).toThrow(); // not valid 3.0.0 any more
    const out = migrateToCurrent(d.report, d.bundle);
    expect(out.report.walletRequests).toBeNull();
    expect(out.bundle.bundleVersion).toBe('igris.evidence.v4');
    expect(out.bundle.items).toEqual(d.bundle.items);
    expect(out.report.evidence.sha256).toBe(bundleHash(out.bundle));
    expect(out.report.scan.notes.at(-1)).toMatch(/draft 3\.0\.0.*no wallet requests/);
    expect(out.report.findingSet).toEqual((d.report as any).findingSet);
    expect(verifyReportIntegrity(out.report, out.bundle).ok).toBe(true);
  });

  it('isDraftReportV3 / upgradeDraftReportV3 are exported for the registry and API', async () => {
    const core = await import('./index.js');
    const d = draft();
    // Report alone (before the bundle is fetched) and report + bundle.
    expect(core.isDraftReportV3(d.report)).toBe(true);
    expect(core.isDraftReportV3(d.report, d.bundle)).toBe(true);
    const current = run(flow(CANARY_A));
    expect(core.isDraftReportV3(current.report)).toBe(false);
    expect(core.isDraftReportV3(current.report, current.bundle)).toBe(false);
    expect(core.isDraftReportV3(d.report, current.bundle)).toBe(false); // v4 bundle
    expect(core.isDraftReportV3({ ...d.report, evidence: {} })).toBe(false);
    expect(core.isDraftReportV3(null)).toBe(false);
    expect(core.isDraftReportV3([])).toBe(false);
    const out = core.upgradeDraftReportV3(d.report, d.bundle);
    expect(out.report.walletRequests).toBeNull();
    expect(core.verifyReportIntegrity(out.report, out.bundle).ok).toBe(true);
  });

  it('a draft whose bundle does not match its hash is refused', () => {
    const d = draft();
    const first = Object.keys(d.bundle.items)[0]!;
    const tampered = structuredClone(d.bundle);
    tampered.items[first].snippet = 'edited';
    expect(() => migrateToCurrent(d.report, tampered)).toThrow(MigrationError);
    expect(() => migrateToCurrent({ ...d.report, extra: 1 }, d.bundle)).toThrow(MigrationError);
  });
});

describe('detector drafts only reference wallet-request evidence', () => {
  it('every evidence item of a wallet finding is a wallet-request', () => {
    for (const d of drafts(flow(CANARY_A)))
      for (const e of d.evidence) expect((e as WalletRequestEvidence).type).toBe('wallet-request');
  });
});
