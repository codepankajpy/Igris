/* eslint-disable @typescript-eslint/no-explicit-any -- a fake page window */
/**
 * Wallet-request capture without a browser: the canary wallet's reporting
 * (wallet-init.ts, run against a fake window) and the recorder's handling
 * of page-controlled reports (capture.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RECORDED_WALLET_METHODS } from '@igris/core';
import {
  TrafficRecorder,
  WALLET_PARAMS_CAP,
  WALLET_REQUESTS_CAP,
  canaryOutcomes,
  newWalletNonce,
  type WalletRequestReport,
} from './capture.js';
import { buildWalletInitScript, igrisInitWallet } from './wallet-init.js';

const CANARY = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const NONCE = 'f'.repeat(32);

describe('TrafficRecorder.walletRequest', () => {
  const frame = {};
  const report = (over: Partial<WalletRequestReport>): WalletRequestReport => ({
    frameKey: frame,
    frame: 'main',
    origin: 'https://app.example.org',
    method: 'personal_sign',
    params: '["hi","0x0"]',
    outcome: 'pending',
    id: 1,
    nonce: NONCE,
    ...over,
  });
  const signer = () => {
    const calls: string[] = [];
    return { calls, sign: async () => (calls.push('signed'), '0xsig') };
  };

  it('records on "pending" (phase, time, order) and completes with the outcome', async () => {
    const rec = new TrafficRecorder(NONCE);
    rec.startClock(1_000);
    rec.setPhase('post-connect');
    rec.walletRequest(report({ id: 1 }), 1_250);
    rec.walletRequest(report({ id: 2, method: 'eth_sendTransaction', params: '[{}]' }), 1_300);
    expect(rec.capture.walletRequests).toEqual([
      {
        phase: 'post-connect',
        t: 250,
        method: 'personal_sign',
        params: '["hi","0x0"]',
        frame: 'main',
        origin: 'https://app.example.org',
        outcome: 'error', // until answered
      },
      expect.objectContaining({ method: 'eth_sendTransaction', t: 300 }),
    ]);
    rec.walletRequest(report({ id: 2, outcome: 'rejected', params: '' }));
    // `signed` is recorded by the Node-side signer, never taken from the page.
    await expect(
      rec.signWalletRequest(frame, 'personal_sign', 1, NONCE, signer().sign),
    ).resolves.toBe('0xsig');
    rec.walletRequest(report({ id: 1, outcome: 'signed', params: '' }));
    expect(rec.capture.walletRequests!.map((r) => r.outcome)).toEqual(['signed', 'rejected']);
    // A second outcome for the same call changes nothing.
    rec.walletRequest(report({ id: 1, outcome: 'error' }));
    expect(rec.capture.walletRequests![0]!.outcome).toBe('signed');
  });

  it('correlates calls per frame (two frames may reuse a call number)', () => {
    const rec = new TrafficRecorder(NONCE);
    const other = {};
    rec.walletRequest(report({ id: 1 }));
    rec.walletRequest(
      report({
        id: 1,
        frameKey: other,
        frame: 'iframe',
        origin: 'https://w.example',
        method: 'eth_sendTransaction',
      }),
    );
    rec.walletRequest(report({ id: 1, frameKey: other, outcome: 'rejected' }));
    expect(rec.capture.walletRequests!.map((r) => [r.frame, r.outcome])).toEqual([
      ['main', 'error'],
      ['iframe', 'rejected'],
    ]);
  });

  it('ignores page-forged junk: unknown methods / outcomes, bad ids, unknown calls', () => {
    const rec = new TrafficRecorder(NONCE);
    rec.walletRequest(report({ method: 'eth_call' }));
    rec.walletRequest(report({ method: 42 }));
    rec.walletRequest(report({ id: 'x' }));
    rec.walletRequest(report({ id: 1.5 }));
    rec.walletRequest(report({ id: 9, outcome: 'signed' })); // never pending
    expect(rec.capture.walletRequests).toEqual([]);
    rec.walletRequest(report({ id: 3 }));
    rec.walletRequest(report({ id: 3, outcome: 'stolen' }));
    expect(rec.capture.walletRequests![0]!.outcome).toBe('error');
    // Non-string params are recorded as an empty list; no time before the clock starts.
    rec.walletRequest(report({ id: 4, params: { a: 1 } }));
    expect(rec.capture.walletRequests![1]).toMatchObject({ params: '[]' });
    expect(rec.capture.walletRequests![1]!.t).toBeUndefined();
  });

  it('caps params at 64 KiB and the list at 500 requests', () => {
    const rec = new TrafficRecorder(NONCE);
    rec.walletRequest(report({ id: 0, params: 'x'.repeat(WALLET_PARAMS_CAP + 10) }));
    expect(rec.capture.walletRequests![0]!.params).toHaveLength(WALLET_PARAMS_CAP);
    for (let i = 1; i < WALLET_REQUESTS_CAP + 20; i++) rec.walletRequest(report({ id: i }));
    expect(rec.capture.walletRequests).toHaveLength(WALLET_REQUESTS_CAP);
    expect(WALLET_PARAMS_CAP).toBe(65_536);
    expect(WALLET_REQUESTS_CAP).toBe(500);
  });
});

describe('TrafficRecorder: page-forged reports and direct signing', () => {
  const frame = {};
  const report = (over: Partial<WalletRequestReport>): WalletRequestReport => ({
    frameKey: frame,
    frame: 'main',
    origin: 'https://app.example.org',
    method: 'eth_sendTransaction',
    params: '[{}]',
    outcome: 'pending',
    id: 1,
    nonce: NONCE,
    ...over,
  });

  it('a page-forged "signed" for a rejected eth_sendTransaction is not recorded', () => {
    const rec = new TrafficRecorder(NONCE);
    rec.walletRequest(report({}));
    rec.walletRequest(report({ outcome: 'signed' })); // even with the nonce
    rec.walletRequest(report({ outcome: 'answered' }));
    rec.walletRequest(report({ outcome: 'error' }));
    expect(rec.capture.walletRequests![0]!.outcome).toBe('error'); // never answered
    rec.walletRequest(report({ outcome: 'rejected' })); // what the canary does
    expect(rec.capture.walletRequests![0]!.outcome).toBe('rejected');
  });

  it('only outcomes the canary can produce per method are accepted', () => {
    expect(canaryOutcomes('eth_sendTransaction')).toEqual(['rejected']);
    expect(canaryOutcomes('eth_sign')).toEqual(['rejected']);
    expect(canaryOutcomes('eth_signTransaction')).toEqual(['rejected']);
    expect(canaryOutcomes('eth_sendRawTransaction')).toEqual(['rejected']);
    expect(canaryOutcomes('personal_sign')).toEqual(['signed', 'error']);
    expect(canaryOutcomes('eth_signTypedData_v3')).toEqual(['signed', 'error']);
    expect(canaryOutcomes('eth_requestAccounts')).toEqual(['answered', 'error']);
    expect(canaryOutcomes('wallet_watchAsset')).toEqual(['answered', 'error']);
    const rec = new TrafficRecorder(NONCE);
    rec.walletRequest(report({ id: 1, method: 'personal_sign' }));
    rec.walletRequest(report({ id: 1, outcome: 'answered' }));
    rec.walletRequest(report({ id: 1, outcome: 'rejected' }));
    rec.walletRequest(report({ id: 1, outcome: 'signed' })); // only the signer records signed
    rec.walletRequest(report({ id: 2, method: 'eth_requestAccounts' }));
    rec.walletRequest(report({ id: 2, outcome: 'rejected' }));
    rec.walletRequest(report({ id: 2, outcome: 'signed' }));
    expect(rec.capture.walletRequests!.map((r) => r.outcome)).toEqual(['error', 'error']);
    rec.walletRequest(report({ id: 2, outcome: 'answered' }));
    expect(rec.capture.walletRequests![1]!.outcome).toBe('answered');
  });

  it('reports without the scan nonce are ignored entirely', () => {
    const rec = new TrafficRecorder(NONCE);
    rec.walletRequest(report({ nonce: undefined }));
    rec.walletRequest(report({ nonce: 'e'.repeat(32) }));
    rec.walletRequest(report({ nonce: NONCE.slice(1) }));
    rec.walletRequest(report({ nonce: 42 }));
    expect(rec.capture.walletRequests).toEqual([]);
    rec.walletRequest(report({}));
    rec.walletRequest(report({ outcome: 'rejected', nonce: 'x' }));
    expect(rec.capture.walletRequests![0]!.outcome).toBe('error');
  });

  it('every recorder gets its own unguessable nonce', () => {
    const a = new TrafficRecorder();
    const b = new TrafficRecorder();
    expect(a.walletNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.walletNonce).not.toBe(b.walletNonce);
    expect(newWalletNonce()).not.toBe(newWalletNonce());
  });

  it('a direct __igrisSign call (no matching pending request) is refused; nothing is signed', async () => {
    const rec = new TrafficRecorder(NONCE);
    let signed = 0;
    const sign = async () => (signed++, '0xsig');
    const refused = /no matching wallet request/;
    // Nothing pending at all.
    await expect(rec.signWalletRequest(frame, 'personal_sign', 1, NONCE, sign)).rejects.toThrow(
      refused,
    );
    await expect(
      rec.signWalletRequest(frame, 'personal_sign', undefined, undefined, sign),
    ).rejects.toThrow(refused);
    rec.walletRequest(report({ id: 1, method: 'personal_sign' }));
    rec.walletRequest(report({ id: 2, method: 'eth_sendTransaction' }));
    // Wrong nonce, wrong method, wrong frame, a call that cannot be signed.
    await expect(rec.signWalletRequest(frame, 'personal_sign', 1, 'x', sign)).rejects.toThrow();
    await expect(
      rec.signWalletRequest(frame, 'eth_signTypedData_v4', 1, NONCE, sign),
    ).rejects.toThrow();
    await expect(rec.signWalletRequest({}, 'personal_sign', 1, NONCE, sign)).rejects.toThrow();
    await expect(
      rec.signWalletRequest(frame, 'eth_sendTransaction', 2, NONCE, sign),
    ).rejects.toThrow();
    expect(signed).toBe(0);
    // The matching request signs once; a second signature for it is refused.
    await expect(rec.signWalletRequest(frame, 'personal_sign', 1, NONCE, sign)).resolves.toBe(
      '0xsig',
    );
    await expect(rec.signWalletRequest(frame, 'personal_sign', 1, NONCE, sign)).rejects.toThrow(
      refused,
    );
    expect(signed).toBe(1);
    expect(rec.capture.walletRequests!.map((r) => r.outcome)).toEqual(['signed', 'error']);
  });

  it('a request completed by a (forged) report cannot be signed afterwards', async () => {
    const rec = new TrafficRecorder(NONCE);
    rec.walletRequest(report({ id: 1, method: 'personal_sign' }));
    rec.walletRequest(report({ id: 1, outcome: 'error' }));
    let signed = 0;
    await expect(
      rec.signWalletRequest(frame, 'personal_sign', 1, NONCE, async () => (signed++, '0x')),
    ).rejects.toThrow();
    expect(signed).toBe(0);
    expect(rec.capture.walletRequests![0]!.outcome).toBe('error');
  });

  it('a failing signer records error; requests past the cap can still be signed', async () => {
    const rec = new TrafficRecorder(NONCE);
    rec.walletRequest(report({ id: 0, method: 'eth_signTypedData_v4' }));
    await expect(
      rec.signWalletRequest(frame, 'eth_signTypedData_v4', 0, NONCE, async () => {
        throw new Error('bad typed data');
      }),
    ).rejects.toThrow('bad typed data');
    expect(rec.capture.walletRequests![0]!.outcome).toBe('error');
    for (let i = 1; i <= WALLET_REQUESTS_CAP; i++)
      rec.walletRequest(report({ id: i, method: 'personal_sign' }));
    expect(rec.capture.walletRequests).toHaveLength(WALLET_REQUESTS_CAP);
    await expect(
      rec.signWalletRequest(frame, 'personal_sign', WALLET_REQUESTS_CAP, NONCE, async () => '0x1'),
    ).resolves.toBe('0x1');
  });
});

describe('canary wallet reporting (wallet-init)', () => {
  const g = globalThis as any;
  afterEach(() => {
    delete g.window;
  });

  /** Install the wallet in a fake window; returns the provider and the reports it made. */
  function install(bindingFirst = true) {
    const calls: unknown[][] = [];
    const signCalls: unknown[][] = [];
    const w: any = {
      addEventListener() {},
      dispatchEvent() {},
      __igrisSign: async (...args: unknown[]) => (signCalls.push(args), `0xsig-${String(args[0])}`),
      __igrisWalletRead: async () => ({ result: '0x0' }),
      __igrisWalletEvent: async () => {},
    };
    const binding = async (...args: unknown[]) => {
      calls.push(args);
    };
    if (bindingFirst) w.__igrisWalletRequest = binding;
    g.window = w;
    igrisInitWallet({
      address: CANARY,
      chainId: 1,
      spoofMetaMask: false,
      recordedMethods: [...RECORDED_WALLET_METHODS],
      nonce: NONCE,
    });
    if (!bindingFirst) w.__igrisWalletRequest = binding;
    return { provider: w.ethereum, calls, signCalls, w };
  }

  it('reports each recorded call before and after, with what the wallet did', async () => {
    const { provider, calls } = install();
    expect(await provider.request({ method: 'eth_requestAccounts' })).toEqual([CANARY]);
    expect(await provider.request({ method: 'personal_sign', params: ['hi', CANARY] })).toBe(
      '0xsig-personal_sign',
    );
    await expect(
      provider.request({ method: 'eth_sendTransaction', params: [{ to: CANARY }] }),
    ).rejects.toMatchObject({ code: 4001 });
    await expect(
      provider.request({ method: 'eth_signTypedData_v3', params: [] }),
    ).rejects.toMatchObject({
      code: 4200,
    });
    expect(calls).toEqual([
      ['eth_requestAccounts', '[]', 'pending', 1, NONCE],
      ['eth_requestAccounts', '', 'answered', 1, NONCE],
      ['personal_sign', JSON.stringify(['hi', CANARY]), 'pending', 2, NONCE],
      ['personal_sign', '', 'signed', 2, NONCE],
      ['eth_sendTransaction', JSON.stringify([{ to: CANARY }]), 'pending', 3, NONCE],
      ['eth_sendTransaction', '', 'rejected', 3, NONCE],
      ['eth_signTypedData_v3', '[]', 'pending', 4, NONCE],
      ['eth_signTypedData_v3', '', 'error', 4, NONCE],
    ]);
  });

  it('sign calls carry the request id and the nonce; the nonce never reaches window', async () => {
    const { provider, signCalls, w } = install();
    const seen: unknown[][] = [];
    // A page replacing both bindings after install sees nothing.
    w.__igrisSign = (...a: unknown[]) => seen.push(a);
    w.__igrisWalletRequest = (...a: unknown[]) => seen.push(a);
    await provider.request({ method: 'personal_sign', params: ['hi', CANARY] });
    expect(signCalls).toEqual([['personal_sign', ['hi', CANARY], 1, NONCE]]);
    expect(seen).toEqual([]);
    for (const k of Object.keys(w)) expect(JSON.stringify(w[k]) ?? '').not.toContain(NONCE);
  });

  it('wired to a real recorder: direct __igrisSign and forged reports change nothing', async () => {
    const rec = new TrafficRecorder(NONCE);
    const frameKey = {};
    let signatures = 0;
    const w: any = {
      addEventListener() {},
      dispatchEvent() {},
      __igrisWalletRead: async () => ({ result: '0x0' }),
      __igrisWalletEvent: async () => {},
      // The scanner's bindings (scan.ts), minus Playwright.
      __igrisWalletRequest: async (...a: unknown[]) =>
        rec.walletRequest({
          frameKey,
          frame: 'main',
          origin: 'https://app.example.org',
          method: a[0],
          params: a[1],
          outcome: a[2],
          id: a[3],
          nonce: a[4],
        }),
      __igrisSign: async (kind: unknown, _params: unknown, id: unknown, nonce: unknown) =>
        rec.signWalletRequest(frameKey, kind, id, nonce, async () => `0xsig${++signatures}`),
    };
    g.window = w;
    igrisInitWallet({
      address: CANARY,
      chainId: 1,
      spoofMetaMask: false,
      recordedMethods: [...RECORDED_WALLET_METHODS],
      nonce: rec.walletNonce,
    });
    // The page calls the sign binding itself: refused, nothing signed or recorded.
    await expect(w.__igrisSign('personal_sign', ['hi', CANARY])).rejects.toThrow();
    await expect(w.__igrisSign('personal_sign', ['hi', CANARY], 1, 'guess')).rejects.toThrow();
    expect(signatures).toBe(0);
    expect(rec.capture.walletRequests).toEqual([]);
    // The page forges reports without the nonce: ignored.
    await w.__igrisWalletRequest('eth_sendTransaction', '[{}]', 'pending', 7);
    expect(rec.capture.walletRequests).toEqual([]);
    // Through the provider: recorded, then signed by the Node side.
    expect(await w.ethereum.request({ method: 'personal_sign', params: ['hi', CANARY] })).toBe(
      '0xsig1',
    );
    await expect(
      w.ethereum.request({ method: 'eth_sendTransaction', params: [{}] }),
    ).rejects.toMatchObject({ code: 4001 });
    // A forged "signed" for the rejected transaction (no nonce, then a late one) changes nothing.
    await w.__igrisWalletRequest('eth_sendTransaction', '', 'signed', 2);
    expect(rec.capture.walletRequests!.map((r) => [r.method, r.outcome])).toEqual([
      ['personal_sign', 'signed'],
      ['eth_sendTransaction', 'rejected'],
    ]);
    expect(signatures).toBe(1);
  });

  it('does not report reads, and leaves the wallet behaviour unchanged', async () => {
    const { provider, calls } = install();
    expect(await provider.request({ method: 'eth_accounts' })).toEqual([]);
    expect(await provider.request({ method: 'eth_chainId' })).toBe('0x1');
    expect(await provider.request({ method: 'eth_call', params: [] })).toBe('0x0');
    expect(calls).toEqual([]);
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] });
    expect(await provider.request({ method: 'eth_chainId' })).toBe('0x89');
    expect(calls.map((c) => c[2])).toEqual(['pending', 'answered']);
  });

  it('a page overwriting the binding cannot hide its requests', async () => {
    const { provider, calls, w } = install();
    w.__igrisWalletRequest = () => {};
    await provider.request({ method: 'eth_sign', params: [CANARY, '0x00'] }).catch(() => {});
    expect(calls.map((c) => c[0])).toEqual(['eth_sign', 'eth_sign']);
  });

  it('works when the binding appears after the wallet is installed; legacy send/enable are recorded once', async () => {
    const { provider, calls } = install(false);
    await provider.enable();
    await provider.send('personal_sign', ['hi', CANARY]);
    expect(calls.map((c) => [c[0], c[2]])).toEqual([
      ['eth_requestAccounts', 'pending'],
      ['eth_requestAccounts', 'answered'],
      ['personal_sign', 'pending'],
      ['personal_sign', 'signed'],
    ]);
  });

  it('unserialisable params are reported as a placeholder, never thrown', async () => {
    const { provider, calls } = install();
    await provider.request({ method: 'personal_sign', params: [10n, CANARY] });
    expect(calls[0]![1]).toBe('"<unserialisable params>"');
  });

  it('the serialised init script carries the recorded method list', () => {
    const src = buildWalletInitScript({
      address: CANARY,
      chainId: 1,
      spoofMetaMask: true,
      nonce: NONCE,
    });
    for (const m of RECORDED_WALLET_METHODS) expect(src).toContain(`"${m}"`);
    expect(src).toContain(`"nonce":"${NONCE}"`);
  });
});
