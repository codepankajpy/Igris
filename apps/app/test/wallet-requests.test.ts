import { describe, expect, it } from 'vitest';
import {
  PERMIT2_ADDRESS,
  WALLET_REQUEST_KINDS,
  type FindingV3,
  type WalletRequestSummary,
} from '@igris/core/contracts';
import {
  EMPTY_TEXT,
  KIND_ALLOWS,
  KIND_LABEL,
  OUTCOME_LABEL,
  amountText,
  asksToSign,
  chainMismatchTitle,
  chainName,
  chainText,
  contractText,
  deadlineText,
  findingsOf,
  findingsText,
  flags,
  hasRisk,
  markerLabel,
  markerLanes,
  recipientRole,
  signInText,
} from '../src/report/wallet-requests.js';

const SPENDER = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';

const summary = (over: Partial<WalletRequestSummary> = {}): WalletRequestSummary => ({
  evidenceId: `ev_${'a'.repeat(24)}`,
  t: 1200,
  kind: 'permit2',
  method: 'eth_signTypedData_v4',
  phase: 'post-connect',
  outcome: 'signed',
  frame: 'main',
  chainId: 1,
  verifyingContract: PERMIT2_ADDRESS,
  spender: SPENDER,
  token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  amount: '1000',
  deadline: '1790000000',
  siweDomain: null,
  unlimited: false,
  longDeadline: false,
  chainIdMismatch: false,
  domainMismatch: false,
  preConnect: false,
  findingIds: [],
  ...over,
});

const finding = (id: string, kind: FindingV3['kind'], title = id): FindingV3 =>
  ({ id, kind, title, severity: 'high' }) as FindingV3;

describe('wallet requests: every kind and outcome is named', () => {
  it('each decoded kind has a plain label and says what it would allow', () => {
    for (const k of WALLET_REQUEST_KINDS) {
      expect(KIND_LABEL[k], k).toMatch(/\S/);
      expect(KIND_ALLOWS[k], k).toMatch(/\.$/);
    }
    expect(Object.keys(KIND_LABEL).sort()).toEqual([...WALLET_REQUEST_KINDS].sort());
  });
  it('outcomes are what the throwaway wallet did', () => {
    expect(OUTCOME_LABEL.signed).toBe('Signed by the throwaway wallet');
    expect(OUTCOME_LABEL.rejected).toBe('Rejected by the throwaway wallet');
  });
  it('wallet housekeeping is not a signature request (the empty state still applies)', () => {
    for (const k of ['connect', 'switch-chain', 'add-chain', 'watch-asset'] as const)
      expect(asksToSign(k)).toBe(false);
    for (const k of ['siwe', 'eth-sign', 'permit2', 'approve', 'transaction'] as const)
      expect(asksToSign(k)).toBe(true);
    expect(EMPTY_TEXT).toBe('The site did not ask the wallet to sign anything during the visit.');
  });
});

describe('wallet requests: values are shown as decoded', () => {
  it('amount: "unlimited" whenever the backend flagged it, else the decimal string', () => {
    expect(
      amountText({ amount: '1461501637330902918203684832716283019655932542975', unlimited: true }),
    ).toBe('unlimited');
    expect(amountText({ amount: '1000', unlimited: false })).toBe(
      '1000 (in the token’s smallest units)',
    );
    expect(amountText({ amount: null, unlimited: false })).toBe('—');
  });
  it('deadline: a date, or "beyond any calendar date" for huge values', () => {
    const fmt = (n: number) => `date(${n})`;
    expect(deadlineText('1790000000', fmt)).toBe('date(1790000000)');
    expect(deadlineText(null, fmt)).toBe('—');
    const max = ((1n << 256n) - 1n).toString();
    expect(deadlineText(max, fmt)).toBe(`${max} (beyond any calendar date)`);
    expect(deadlineText('281474976710655', fmt)).toMatch(/beyond any calendar date/);
  });
  it('chains are named when well known, numbered otherwise', () => {
    expect(chainName(137)).toBe('Polygon (137)');
    expect(chainName(999_999)).toBe('chain 999999');
    expect(chainName(null)).toBe('none named');
  });
  it('chain named vs wallet chain follows the backend flag (chain-bound kinds)', () => {
    expect(chainText({ kind: 'permit2', chainId: 137, chainIdMismatch: true }, 1)).toBe(
      'Polygon (137) — not the chain the wallet was on (it started on Ethereum (1))',
    );
    expect(chainText({ kind: 'permit2', chainId: 1, chainIdMismatch: false }, 1)).toBe(
      'Ethereum (1) — the wallet’s chain',
    );
    expect(chainText({ kind: 'siwe', chainId: null, chainIdMismatch: false }, 1)).toBeNull();
  });
  it('switch-chain / add-chain show only the target, never a comparison (defect 1)', () => {
    // The wallet started on Ethereum; a switch to Polygon is not "not the wallet's chain".
    expect(chainText({ kind: 'switch-chain', chainId: 137, chainIdMismatch: false }, 1)).toBe(
      'Polygon (137) — the chain it asks the wallet to switch to',
    );
    expect(chainText({ kind: 'add-chain', chainId: 137, chainIdMismatch: false }, 1)).toBe(
      'Polygon (137) — the chain it asks the wallet to add',
    );
    // Even a (malformed) flag on a non-chain-bound kind is not turned into a comparison.
    expect(chainText({ kind: 'switch-chain', chainId: 1, chainIdMismatch: true }, 1)).toBe(
      'Ethereum (1) — the chain it asks the wallet to switch to',
    );
    for (const kind of ['connect', 'watch-asset', 'personal-message', 'eth-sign'] as const) {
      const t = chainText({ kind, chainId: 137, chainIdMismatch: false }, 1);
      expect(t, kind).toBe('Polygon (137)');
    }
  });
  it('switch then permit: the backend title names the chain; never "(it started on X)" when X is the chain named (defect 2)', () => {
    // The wallet started on Ethereum, switched to Polygon, then a permit named Ethereum.
    const title = 'Signature request names chain 1 while the wallet is on chain 137';
    const findings = [finding('w1', 'risk', title)];
    expect(chainMismatchTitle(findings)).toBe(title);
    expect(chainText({ kind: 'permit2', chainId: 1, chainIdMismatch: true }, 1, findings)).toBe(
      `Ethereum (1) — ${title}`,
    );
    // No chain-mismatch title (the finding is titled by a more severe row): no
    // self-contradicting "(it started on Ethereum (1))".
    const other = [finding('w2', 'risk', 'Asked for an unlimited token permit to 0x3fC9…7FAD')];
    expect(chainMismatchTitle(other)).toBeNull();
    const t = chainText({ kind: 'permit2', chainId: 1, chainIdMismatch: true }, 1, other);
    expect(t).toBe('Ethereum (1) — not the chain the wallet was on');
    expect(t).not.toMatch(/it started on/);
    // An observation is never used as the mismatch sentence.
    expect(chainMismatchTitle([finding('w3', 'observation', title)])).toBeNull();
    expect(
      chainText({ kind: 'transaction', chainId: 10, chainIdMismatch: true }, 1, [
        finding('w4', 'risk', 'Transaction request names chain 10 while the wallet is on chain 1'),
      ]),
    ).toBe('OP Mainnet (10) — Transaction request names chain 10 while the wallet is on chain 1');
  });
  it('sign-in domain vs page follows the backend flag', () => {
    expect(
      signInText({ siweDomain: 'evil.example', domainMismatch: true }, 'app.example.org'),
    ).toBe('evil.example — not the page that asked (app.example.org)');
    expect(
      signInText({ siweDomain: 'app.example.org', domainMismatch: false }, 'app.example.org'),
    ).toBe('app.example.org — matches the page (or its parent/subdomain): app.example.org');
    // The backend accepts a parent/subdomain of the page (WALLET-REQUESTS.md): worded so.
    expect(
      signInText({ siweDomain: 'example.org', domainMismatch: false }, 'app.example.org'),
    ).toBe('example.org — matches the page (or its parent/subdomain): app.example.org');
    expect(signInText({ siweDomain: null, domainMismatch: false }, 'x.org')).toBeNull();
  });
  it('Permit2 is named; setApprovalForAll has an operator, not a spender', () => {
    expect(contractText(PERMIT2_ADDRESS.toLowerCase())).toMatch(/\(Permit2\)$/);
    expect(contractText(SPENDER)).toBe(SPENDER);
    expect(contractText(null)).toBeNull();
    expect(recipientRole('set-approval-for-all')).toBe('Operator');
    expect(recipientRole('permit')).toBe('Spender');
  });
});

describe('wallet requests: flags and risks are the backend’s, never re-judged', () => {
  it('no flag set → no flag shown, even for an unlimited-looking amount', () => {
    expect(flags(summary({ amount: ((1n << 255n) + 1n).toString() }))).toEqual([]);
  });
  it('every flag the backend set is shown, in a fixed order', () => {
    const f = flags(
      summary({
        unlimited: true,
        longDeadline: true,
        chainIdMismatch: true,
        chainId: 137,
        domainMismatch: true,
        siweDomain: 'evil.example',
        preConnect: true,
      }),
    );
    expect(f.map((x) => x.key)).toEqual([
      'unlimited',
      'longDeadline',
      'chainIdMismatch',
      'domainMismatch',
      'preConnect',
    ]);
    expect(f[2]!.text).toBe('Names Polygon (137), not the chain the wallet was on');
    expect(f[3]!.text).toBe('Sign-in message is for evil.example, not the page that asked');
  });
  it('risk = the backend raised a risk finding (observations are not risks)', () => {
    const byId = new Map([
      ['f1', finding('f1', 'risk')],
      ['f2', finding('f2', 'observation')],
    ]);
    expect(hasRisk(summary({ findingIds: ['f2'] }), byId)).toBe(false);
    expect(hasRisk(summary({ findingIds: ['f2', 'f1'] }), byId)).toBe(true);
    expect(
      findingsOf(summary({ findingIds: ['f2', 'missing', 'f1'] }), byId).map((x) => x.id),
    ).toEqual(['f2', 'f1']);
  });
});

describe('wallet requests on the visit timeline', () => {
  it('each marker has a complete accessible label', () => {
    const secs = (ms: number) => `${ms / 1000} s`;
    expect(markerLabel(summary({ kind: 'siwe', method: 'personal_sign' }), 1, secs)).toBe(
      'Wallet request 2: Sign in with Ethereum (personal_sign) at 1.2 s, after connecting. Signed by the throwaway wallet.',
    );
    expect(markerLabel(summary({ t: null, phase: 'pre-connect' }), 0, secs)).toMatch(
      /not timed, before connecting\./,
    );
  });
  it('a marker with a risk finding says "risk finding: <title>" (observations are not risks)', () => {
    const secs = (ms: number) => `${ms / 1000} s`;
    const risk = finding('f1', 'risk', 'Asked for an unlimited token permit to 0x3fC9…7FAD');
    const obs = finding('f2', 'observation', 'Asked to sign a message');
    expect(markerLabel(summary(), 0, secs, [obs, risk])).toBe(
      'Wallet request 1: Sign a token permit (Permit2) (eth_signTypedData_v4) at 1.2 s, after connecting. Signed by the throwaway wallet; risk finding: Asked for an unlimited token permit to 0x3fC9…7FAD.',
    );
    expect(markerLabel(summary(), 0, secs, [obs])).not.toMatch(/risk finding/);
    expect(markerLabel(summary(), 0, secs)).not.toMatch(/risk finding/);
  });
  it('the hidden table’s Findings column names each finding by kind', () => {
    expect(
      findingsText([
        finding('f1', 'risk', 'Sign-in message is for a different site (evil.example)'),
        finding('f2', 'observation', 'Asked to sign a message'),
      ]),
    ).toBe(
      'risk finding: Sign-in message is for a different site (evil.example); observation: Asked to sign a message',
    );
    expect(findingsText([])).toBeNull();
  });
  it('markers too close to tell apart go on separate lanes (any order)', () => {
    expect(markerLanes([0.1, 0.11, 0.12, 0.5])).toEqual([0, 1, 2, 0]);
    expect(markerLanes([0.5, 0.1, 0.51])).toEqual([0, 0, 1]);
    expect(markerLanes([])).toEqual([]);
  });
});
