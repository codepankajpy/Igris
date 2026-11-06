import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, getAddress, keccak256, stringToHex, toHex } from 'viem';
import { buildCanaryForms } from './encodings.js';
import { findCanary } from './detect.js';
import { canonicalize } from './contracts/canonical.js';
import { validateEvidenceItem } from './contracts/validate.js';
import type {
  CapturedWalletRequest,
  RecordedWalletMethod,
  WalletRequestEvidence,
} from './contracts/wallet-request.js';
import { PERMIT2_ADDRESS } from './contracts/wallet-request.js';
import {
  APPROVE_SELECTOR,
  MAX_UINT160,
  MAX_UINT256,
  SET_APPROVAL_FOR_ALL_SELECTOR,
  decodeWalletRequest,
  decodeWalletRequests,
  parseChainId,
  parseSiwe,
  parseUint,
  personalMessageText,
  redactCanary,
  relatedHost,
  walletParamsDigest,
  type WalletDecodeContext,
} from './walletreq.js';
import { CANARY_A, CANARY_B } from './test-helpers.js';

const forms = buildCanaryForms(CANARY_A);
const SCAN = Date.parse('2026-11-06T00:00:00.000Z') / 1000;
const DAY = 24 * 60 * 60;
const SPENDER = getAddress('0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad');
const USDC = getAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
const NFT = getAddress('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d');

const ctx = (over: Partial<WalletDecodeContext> = {}): WalletDecodeContext => ({
  canary: forms,
  pageOrigin: 'https://app.example.org',
  chainId: 1,
  scanTime: SCAN,
  accountsRequested: true,
  ...over,
});

function cap(
  method: RecordedWalletMethod,
  params: unknown,
  over: Partial<CapturedWalletRequest> = {},
): CapturedWalletRequest {
  return {
    phase: 'post-connect',
    t: 100,
    method,
    params: typeof params === 'string' ? params : JSON.stringify(params),
    frame: 'main',
    origin: 'https://app.example.org',
    outcome: 'signed',
    ...over,
  };
}

const decode = (c: CapturedWalletRequest, over: Partial<WalletDecodeContext> = {}) => {
  const e = decodeWalletRequest(c, ctx(over));
  // Every decoded item is schema-valid and canary-free.
  expect(() => validateEvidenceItem(e)).not.toThrow();
  expect(findCanary(canonicalize(e), forms)).toEqual([]);
  return e;
};

const siwe = (domain: string, uri: string, chain = 1, address: string = CANARY_A) =>
  [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    'Sign in to the app.',
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${chain}`,
    'Nonce: 32891756',
    'Issued At: 2026-11-06T00:00:00Z',
  ].join('\n');

const typed = (primaryType: string, message: object, domain: object, extraTypes = {}) => ({
  types: { EIP712Domain: [{ name: 'name', type: 'string' }], ...extraTypes },
  primaryType,
  domain,
  message,
});

const permitSingle = (amount: unknown, expiration: unknown, chainId: unknown = 1) =>
  typed(
    'PermitSingle',
    {
      details: { token: USDC, amount, expiration, nonce: 0 },
      spender: SPENDER,
      sigDeadline: SCAN + 1800,
    },
    { name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS },
  );

const calldata = (selector: string, types: Array<{ type: string }>, values: unknown[]) =>
  selector + encodeAbiParameters(types, values).slice(2);

describe('parsers', () => {
  it('parseUint: decimal, hex and JSON numbers; rejects junk and > uint256', () => {
    expect(parseUint('42')).toEqual({ decimal: '42', value: 42n });
    expect(parseUint('0x2a')).toEqual({ decimal: '42', value: 42n });
    expect(parseUint(42)).toEqual({ decimal: '42', value: 42n });
    expect(parseUint(MAX_UINT256.toString())?.decimal).toBe(MAX_UINT256.toString());
    expect(parseUint((MAX_UINT256 + 1n).toString())).toBeNull();
    expect(parseUint('0x' + 'f'.repeat(65))).toBeNull();
    for (const bad of [-1, 1.5, NaN, Infinity, '', '-1', '1e3', '0x', 'abc', null, true, {}])
      expect(parseUint(bad)).toBeNull();
    // A JSON number beyond 2^53 is already rounded: no exact amount, magnitude kept.
    const big = parseUint(2 ** 256);
    expect(big?.decimal).toBeNull();
    expect(big!.value >= MAX_UINT160).toBe(true);
  });

  it('parseChainId: number, decimal and hex; null beyond a safe integer', () => {
    expect(parseChainId(137)).toBe(137);
    expect(parseChainId('137')).toBe(137);
    expect(parseChainId('0x89')).toBe(137);
    expect(parseChainId('0x' + 'f'.repeat(20))).toBeNull();
    expect(parseChainId(undefined)).toBeNull();
  });

  it('relatedHost: same host, sub/parent within one registrable domain only', () => {
    expect(relatedHost('app.example.org', 'app.example.org')).toBe(true);
    expect(relatedHost('example.org', 'app.example.org')).toBe(true);
    expect(relatedHost('login.app.example.org', 'app.example.org')).toBe(true);
    expect(relatedHost('a.example.org', 'b.example.org')).toBe(false); // siblings
    expect(relatedHost('co.uk', 'app.example.co.uk')).toBe(false); // a public suffix
    expect(relatedHost('example.org.evil.com', 'example.org')).toBe(false);
    expect(relatedHost('notexample.org', 'example.org')).toBe(false);
  });

  it('personalMessageText: hex vs UTF-8, hashes and unreadable bytes', () => {
    expect(personalMessageText('hello')).toBe('hello');
    expect(personalMessageText(stringToHex('héllo\nworld'))).toBe('héllo\nworld');
    expect(personalMessageText('0x')).toBe('');
    expect(personalMessageText('0x' + 'ab'.repeat(32))).toBeNull(); // bare 32-byte hash
    expect(personalMessageText('ab'.repeat(32))).toBeNull(); // the same without 0x
    expect(personalMessageText('0xfffe')).toBeNull(); // invalid UTF-8
    expect(personalMessageText(stringToHex('a\u0000b'))).toBeNull(); // control bytes
    expect(personalMessageText(42)).toBeNull();
    // Odd-length "hex" is text, as wallets show it.
    expect(personalMessageText('0xabc')).toBe('0xabc');
  });

  it('parseSiwe: header (with or without scheme), URI and Chain ID', () => {
    expect(parseSiwe(siwe('app.example.org', 'https://app.example.org', 10))).toEqual({
      domain: 'app.example.org',
      uri: 'https://app.example.org',
      chainId: 10,
    });
    expect(
      parseSiwe(siwe('https://app.example.org:8443', 'https://app.example.org:8443'))?.domain,
    ).toBe('app.example.org:8443');
    expect(parseSiwe('Sign this message: app.example.org')).toBeNull();
    expect(
      parseSiwe(`${'a'.repeat(256)} wants you to sign in with your Ethereum account:`),
    ).toBeNull();
  });

  it('redactCanary replaces every detectable form', () => {
    const text = `a=${CANARY_A} b=${CANARY_A.toLowerCase()} c=${CANARY_A.slice(0, 8)}…${CANARY_A.slice(-4)}`;
    const out = redactCanary(text, forms);
    expect(findCanary(out, forms)).toEqual([]);
    expect(out.match(/<CANARY>/g)).toHaveLength(3);
  });
});

describe('decodeWalletRequest: connect and chain requests', () => {
  it('eth_requestAccounts / wallet_requestPermissions → connect (never preConnect)', () => {
    for (const method of ['eth_requestAccounts', 'wallet_requestPermissions'] as const) {
      const e = decode(cap(method, [], { outcome: 'answered' }), { accountsRequested: false });
      expect(e).toMatchObject({ kind: 'connect', method, preConnect: false, chainId: null });
    }
  });

  it('switch / add chain name the target chain; never a mismatch', () => {
    const sw = decode(cap('wallet_switchEthereumChain', [{ chainId: '0x89' }]));
    expect(sw).toMatchObject({ kind: 'switch-chain', chainId: 137, chainIdMismatch: false });
    const add = decode(cap('wallet_addEthereumChain', [{ chainId: '0xa', chainName: 'OP' }]));
    expect(add).toMatchObject({ kind: 'add-chain', chainId: 10, chainIdMismatch: false });
  });

  it('wallet_watchAsset names the token (array or bare object params)', () => {
    const p = { type: 'ERC20', options: { address: USDC.toLowerCase(), symbol: 'USDC' } };
    expect(decode(cap('wallet_watchAsset', [p]))).toMatchObject({
      kind: 'watch-asset',
      token: USDC,
    });
    expect(decode(cap('wallet_watchAsset', p))).toMatchObject({ kind: 'watch-asset', token: USDC });
  });
});

describe('decodeWalletRequest: personal_sign, SIWE and eth_sign', () => {
  it('readable text in either param order → personal-message', () => {
    expect(decode(cap('personal_sign', ['Welcome!', CANARY_A])).kind).toBe('personal-message');
    expect(decode(cap('personal_sign', [CANARY_A, 'Welcome!'])).kind).toBe('personal-message');
    expect(
      decode(cap('personal_sign', [CANARY_A.toLowerCase(), stringToHex('Welcome!')])).kind,
    ).toBe('personal-message');
    // Order is decided by which param is the canary / an address, not by position.
    expect(decode(cap('personal_sign', [SPENDER, 'Welcome!'])).kind).toBe('personal-message');
  });

  it('a 32-byte hex message that decodes to printable UTF-8 is a personal-message', () => {
    const text = 'Please sign this message today!!';
    const hex = stringToHex(text);
    expect((hex.length - 2) / 2).toBe(32);
    expect(personalMessageText(hex)).toBe(text);
    expect(decode(cap('personal_sign', [hex, CANARY_A])).kind).toBe('personal-message');
    expect(decode(cap('personal_sign', [CANARY_A, hex])).kind).toBe('personal-message');
    // Printable 32 bytes of anything ("ZZZ…Z") are readable too.
    expect(decode(cap('personal_sign', ['0x' + '5a'.repeat(32), CANARY_A])).kind).toBe(
      'personal-message',
    );
  });

  it('a non-printable 32-byte hash or unreadable bytes → blind-hash (either order)', () => {
    const hash = keccak256(stringToHex('an order to sign blindly'));
    expect(personalMessageText(hash)).toBeNull();
    expect(personalMessageText('0x' + '01'.repeat(32))).toBeNull(); // control bytes
    expect(decode(cap('personal_sign', [hash, CANARY_A])).kind).toBe('blind-hash');
    expect(decode(cap('personal_sign', [CANARY_A, hash])).kind).toBe('blind-hash');
    expect(
      decode(cap('personal_sign', [toHex(new Uint8Array([0, 1, 2, 255])), CANARY_A])).kind,
    ).toBe('blind-hash');
    // Unparseable (e.g. truncated at the scanner's 64 KiB cap): nothing readable was decoded.
    expect(decode(cap('personal_sign', '["Welcome to a very long mess')).kind).toBe('blind-hash');
  });

  it('SIWE for the page itself → siwe, no mismatch, chain id from the message', () => {
    const e = decode(
      cap('personal_sign', [siwe('app.example.org', 'https://app.example.org'), CANARY_A]),
    );
    expect(e).toMatchObject({
      kind: 'siwe',
      siweDomain: 'app.example.org',
      chainId: 1,
      domainMismatch: false,
      chainIdMismatch: false,
    });
  });

  it('SIWE hex-encoded, in reversed param order, still decodes', () => {
    const msg = stringToHex(siwe('evil.example', 'https://evil.example'));
    const e = decode(cap('personal_sign', [CANARY_A, msg]));
    expect(e).toMatchObject({ kind: 'siwe', siweDomain: 'evil.example', domainMismatch: true });
  });

  const cases: Array<[string, string, string, string, boolean]> = [
    // [page origin, SIWE domain, URI, why, mismatch]
    ['https://app.example.org', 'evil.example', 'https://evil.example', 'another site', true],
    ['https://app.example.org', 'example.org', 'https://example.org', 'parent domain', false],
    ['https://example.org', 'login.example.org', 'https://login.example.org', 'subdomain', false],
    ['https://a.example.org', 'b.example.org', 'https://b.example.org', 'sibling', true],
    ['https://app.example.co.uk', 'co.uk', 'https://co.uk', 'public suffix', true],
    [
      'https://app.example.org',
      'app.example.org',
      'https://evil.example/login',
      'URI elsewhere',
      true,
    ],
    [
      'https://app.example.org:8443',
      'app.example.org:8443',
      'https://app.example.org:8443',
      'port',
      false,
    ],
    ['https://app.example.org', 'app.example.org', 'ipfs://bafy', 'non-http URI', false],
    // Documented rule: scheme and port are ignored, only the host relation counts.
    [
      'https://app.example.org',
      'app.example.org:8080',
      'http://app.example.org:8080/login',
      'scheme and port ignored',
      false,
    ],
    ['http://localhost:3000', 'localhost', 'https://localhost', 'port vs none', false],
    ['https://www.example.org', 'example.org', 'https://example.org', 'www vs apex', false],
  ];
  for (const [origin, domain, uri, why, mismatch] of cases) {
    it(`SIWE domain check: ${why} → mismatch ${mismatch}`, () => {
      const e = decode(cap('personal_sign', [siwe(domain, uri), CANARY_A], { origin }));
      expect(e.kind).toBe('siwe');
      expect(e.domainMismatch).toBe(mismatch);
    });
  }

  it('SIWE from an opaque frame origin is judged against the page origin', () => {
    const msg = siwe('app.example.org', 'https://app.example.org');
    const e = decode(cap('personal_sign', [msg, CANARY_A], { origin: 'null', frame: 'iframe' }));
    expect(e).toMatchObject({ domainMismatch: false, origin: 'null', frame: 'iframe' });
  });

  it('SIWE naming another chain than the wallet is on → chainIdMismatch', () => {
    const e = decode(
      cap('personal_sign', [siwe('app.example.org', 'https://app.example.org', 10), CANARY_A]),
    );
    expect(e).toMatchObject({ chainId: 10, chainIdMismatch: true });
  });

  it('the canary inside a SIWE domain or the calling origin is redacted', () => {
    const domain = `${forms.coreLower}.evil.example`;
    const e = decode(
      cap('personal_sign', [siwe(domain, `https://${domain}`), CANARY_A], {
        origin: `https://${forms.coreLower}.evil.example`,
      }),
    );
    expect(e.siweDomain).toBe('<CANARY>.evil.example');
    expect(e.origin).toBe('https://<CANARY>.evil.example');
  });

  it('eth_sign → eth-sign', () => {
    expect(
      decode(cap('eth_sign', [CANARY_A, '0x' + '11'.repeat(32)], { outcome: 'rejected' })),
    ).toMatchObject({
      kind: 'eth-sign',
      outcome: 'rejected',
    });
  });
});

describe('decodeWalletRequest: typed data', () => {
  it('Permit2 PermitSingle with MAX_UINT160 → permit2, unlimited, expiration as deadline', () => {
    const td = permitSingle(MAX_UINT160.toString(), SCAN + 3600, 137);
    const e = decode(cap('eth_signTypedData_v4', [CANARY_A, JSON.stringify(td)]));
    expect(e).toMatchObject({
      kind: 'permit2',
      verifyingContract: PERMIT2_ADDRESS,
      token: USDC,
      spender: SPENDER,
      amount: MAX_UINT160.toString(),
      deadline: String(SCAN + 3600),
      unlimited: true,
      longDeadline: false,
      chainId: 137,
      chainIdMismatch: true,
    });
  });

  it('typed data as [json, address], as an object, with a hex chain id', () => {
    const td = permitSingle('1000', SCAN + 3600, '0x1');
    expect(decode(cap('eth_signTypedData_v4', [JSON.stringify(td), CANARY_A]))).toMatchObject({
      kind: 'permit2',
      chainId: 1,
      chainIdMismatch: false,
      unlimited: false,
      amount: '1000',
    });
    expect(decode(cap('eth_signTypedData_v3', [CANARY_A, td])).kind).toBe('permit2');
  });

  it('long deadlines: > scan time + 30 days, including the max uint48', () => {
    const at = (exp: number) =>
      decode(cap('eth_signTypedData_v4', [CANARY_A, JSON.stringify(permitSingle('1', exp))]));
    expect(at(SCAN + 29 * DAY).longDeadline).toBe(false);
    expect(at(SCAN + 30 * DAY).longDeadline).toBe(false);
    expect(at(SCAN + 31 * DAY).longDeadline).toBe(true);
    expect(at(2 ** 48 - 1).longDeadline).toBe(true);
    expect(at(0).longDeadline).toBe(false); // Permit2: 0 expires in the same block
  });

  it('PermitBatch: first entry reported; unlimited if ANY entry is', () => {
    const td = typed(
      'PermitBatch',
      {
        details: [
          { token: USDC, amount: '5', expiration: SCAN + 60, nonce: 0 },
          { token: NFT, amount: MAX_UINT160.toString(), expiration: SCAN + 60, nonce: 0 },
        ],
        spender: SPENDER,
        sigDeadline: SCAN + 60,
      },
      { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2_ADDRESS },
    );
    expect(decode(cap('eth_signTypedData_v4', [CANARY_A, JSON.stringify(td)]))).toMatchObject({
      kind: 'permit2',
      token: USDC,
      amount: '5',
      unlimited: true,
    });
  });

  it('PermitBatch: longDeadline if ANY entry expires late; the first entry is reported', () => {
    const batch = (expirations: number[]) =>
      decode(
        cap('eth_signTypedData_v4', [
          CANARY_A,
          JSON.stringify(
            typed(
              'PermitBatch',
              {
                details: expirations.map((expiration, i) => ({
                  token: i === 0 ? USDC : NFT,
                  amount: String(i + 1),
                  expiration,
                  nonce: 0,
                })),
                spender: SPENDER,
                sigDeadline: SCAN + 60,
              },
              { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2_ADDRESS },
            ),
          ),
        ]),
      );
    expect(batch([SCAN + 60, SCAN + 365 * DAY])).toMatchObject({
      kind: 'permit2',
      token: USDC,
      amount: '1',
      deadline: String(SCAN + 60), // first entry
      unlimited: false,
      longDeadline: true, // second entry
    });
    expect(batch([SCAN + 365 * DAY, SCAN + 60]).longDeadline).toBe(true);
    expect(batch([SCAN + 60, SCAN + 29 * DAY]).longDeadline).toBe(false);
  });

  it('Permit2 SignatureTransfer (single, batch, witness): message deadline', () => {
    const domain = { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2_ADDRESS };
    const single = typed(
      'PermitTransferFrom',
      {
        permitted: { token: USDC, amount: '0x' + 'f'.repeat(64) },
        spender: SPENDER,
        nonce: 1,
        deadline: SCAN + 40 * DAY,
      },
      domain,
    );
    expect(decode(cap('eth_signTypedData_v4', [CANARY_A, JSON.stringify(single)]))).toMatchObject({
      kind: 'permit2',
      amount: MAX_UINT256.toString(),
      unlimited: true,
      deadline: String(SCAN + 40 * DAY),
      longDeadline: true,
    });
    const batch = typed(
      'PermitBatchTransferFrom',
      {
        permitted: [{ token: NFT, amount: '7' }],
        spender: SPENDER,
        nonce: 1,
        deadline: SCAN + 60,
      },
      domain,
    );
    expect(decode(cap('eth_signTypedData_v4', [CANARY_A, JSON.stringify(batch)]))).toMatchObject({
      kind: 'permit2',
      token: NFT,
      amount: '7',
      unlimited: false,
    });
    // By primary type alone (another verifying contract): still Permit2-shaped.
    const witness = typed(
      'PermitWitnessTransferFrom',
      {
        permitted: { token: USDC, amount: '1' },
        spender: SPENDER,
        nonce: 1,
        deadline: SCAN + 60,
        witness: { x: 1 },
      },
      { ...domain, verifyingContract: NFT },
    );
    expect(decode(cap('eth_signTypedData_v4', [CANARY_A, JSON.stringify(witness)]))).toMatchObject({
      kind: 'permit2',
      verifyingContract: NFT,
    });
  });

  it('EIP-2612 Permit: token = verifyingContract; the owner (canary) never appears', () => {
    const td = typed(
      'Permit',
      {
        owner: CANARY_A,
        spender: SPENDER,
        value: MAX_UINT256.toString(),
        nonce: 0,
        deadline: MAX_UINT256.toString(),
      },
      { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC },
    );
    const e = decode(cap('eth_signTypedData_v4', [CANARY_A, JSON.stringify(td)]));
    expect(e).toMatchObject({
      kind: 'permit',
      token: USDC,
      verifyingContract: USDC,
      spender: SPENDER,
      amount: MAX_UINT256.toString(),
      unlimited: true,
      longDeadline: true,
    });
    expect(JSON.stringify(e).toLowerCase()).not.toContain(forms.coreLower);
  });

  it('EIP-2612 value as a JSON number: exact when safe, magnitude only when not', () => {
    const permit = (value: unknown) =>
      typed(
        'Permit',
        { owner: CANARY_A, spender: SPENDER, value, nonce: 0, deadline: SCAN + 60 },
        { chainId: 1, verifyingContract: USDC },
      );
    const small = decode(cap('eth_signTypedData_v4', [CANARY_A, JSON.stringify(permit(1000))]));
    expect(small).toMatchObject({ amount: '1000', unlimited: false });
    const huge = decode(cap('eth_signTypedData_v4', [CANARY_A, JSON.stringify(permit(2 ** 256))]));
    expect(huge).toMatchObject({ amount: null, unlimited: true });
  });

  it('DAI-style permit: allowed=true is unlimited; expiry 0 never expires', () => {
    const td = typed(
      'Permit',
      { holder: CANARY_A, spender: SPENDER, nonce: 0, expiry: 0, allowed: true },
      { chainId: 1, verifyingContract: USDC },
    );
    expect(decode(cap('eth_signTypedData_v4', [CANARY_A, JSON.stringify(td)]))).toMatchObject({
      kind: 'permit',
      amount: null,
      deadline: '0',
      unlimited: true,
      longDeadline: true,
    });
  });

  it('a spender equal to the canary is dropped, not published', () => {
    const td = typed(
      'Permit',
      { owner: SPENDER, spender: CANARY_A.toLowerCase(), value: '1', nonce: 0, deadline: SCAN },
      { chainId: 1, verifyingContract: USDC },
    );
    expect(decode(cap('eth_signTypedData_v4', [CANARY_A, JSON.stringify(td)])).spender).toBeNull();
  });

  it('other typed data → typed-data; legacy v1 arrays and junk too', () => {
    const mail = typed(
      'Mail',
      { contents: 'hi' },
      { name: 'Ether Mail', chainId: 5, verifyingContract: NFT },
    );
    expect(decode(cap('eth_signTypedData_v4', [CANARY_A, JSON.stringify(mail)]))).toMatchObject({
      kind: 'typed-data',
      chainId: 5,
      verifyingContract: NFT,
      chainIdMismatch: true,
    });
    const notPermit = typed('Permit', { foo: 1 }, { chainId: 1, verifyingContract: USDC });
    expect(decode(cap('eth_signTypedData_v4', [CANARY_A, JSON.stringify(notPermit)])).kind).toBe(
      'typed-data',
    );
    const v1 = [[{ type: 'string', name: 'Message', value: 'Hi' }], CANARY_A];
    expect(decode(cap('eth_signTypedData', v1, { outcome: 'error' }))).toMatchObject({
      kind: 'typed-data',
      chainId: null,
      verifyingContract: null,
    });
    expect(decode(cap('eth_signTypedData_v4', [CANARY_A, '{not json'])).kind).toBe('typed-data');
  });
});

describe('decodeWalletRequest: transactions', () => {
  const tx = (data: string, over: object = {}) => [
    { from: CANARY_A, to: USDC.toLowerCase(), data, ...over },
  ];

  it('approve(spender, MAX_UINT256) → approve, unlimited, token = to', () => {
    const data = calldata(
      APPROVE_SELECTOR,
      [{ type: 'address' }, { type: 'uint256' }],
      [SPENDER, MAX_UINT256],
    );
    expect(decode(cap('eth_sendTransaction', tx(data), { outcome: 'rejected' }))).toMatchObject({
      kind: 'approve',
      token: USDC,
      spender: SPENDER,
      amount: MAX_UINT256.toString(),
      unlimited: true,
      deadline: null,
      outcome: 'rejected',
    });
  });

  it('a bounded approve is not unlimited; `input` works like `data`', () => {
    const data = calldata(
      APPROVE_SELECTOR,
      [{ type: 'address' }, { type: 'uint256' }],
      [SPENDER, 10n ** 6n],
    );
    expect(decode(cap('eth_signTransaction', [{ to: USDC, input: data }]))).toMatchObject({
      kind: 'approve',
      amount: '1000000',
      unlimited: false,
    });
  });

  it('setApprovalForAll(operator, true) → set-approval-for-all; false is a plain transaction', () => {
    const on = calldata(
      SET_APPROVAL_FOR_ALL_SELECTOR,
      [{ type: 'address' }, { type: 'bool' }],
      [SPENDER, true],
    );
    expect(decode(cap('eth_sendTransaction', [{ to: NFT, data: on }]))).toMatchObject({
      kind: 'set-approval-for-all',
      token: NFT,
      spender: SPENDER,
      unlimited: true,
    });
    const off = calldata(
      SET_APPROVAL_FOR_ALL_SELECTOR,
      [{ type: 'address' }, { type: 'bool' }],
      [SPENDER, false],
    );
    expect(decode(cap('eth_sendTransaction', [{ to: NFT, data: off }]))).toMatchObject({
      kind: 'transaction',
      spender: null,
      unlimited: false,
    });
  });

  it('malformed calldata, plain transfers and raw transactions → transaction', () => {
    expect(decode(cap('eth_sendTransaction', tx(APPROVE_SELECTOR + '00'))).kind).toBe(
      'transaction',
    );
    expect(decode(cap('eth_sendTransaction', [{ to: SPENDER, value: '0x1' }])).kind).toBe(
      'transaction',
    );
    expect(decode(cap('eth_sendRawTransaction', ['0x02f8'])).kind).toBe('transaction');
  });

  it('a transaction naming another chain → chainIdMismatch', () => {
    const e = decode(cap('eth_sendTransaction', [{ to: SPENDER, value: '0x1', chainId: '0x89' }]));
    expect(e).toMatchObject({ kind: 'transaction', chainId: 137, chainIdMismatch: true });
  });

  it('an approve to the canary as spender drops the spender', () => {
    const data = calldata(
      APPROVE_SELECTOR,
      [{ type: 'address' }, { type: 'uint256' }],
      [CANARY_A, 1n],
    );
    expect(decode(cap('eth_sendTransaction', tx(data))).spender).toBeNull();
  });
});

describe('decodeWalletRequests: wallet state through the capture', () => {
  const mail = (chainId: number) =>
    JSON.stringify(typed('Mail', { contents: 'hi' }, { chainId, verifyingContract: NFT }));

  it('preConnect is relative to the first eth_requestAccounts', () => {
    const out = decodeWalletRequests(
      [
        cap('eth_signTypedData_v4', [CANARY_A, mail(1)]),
        cap('eth_requestAccounts', [], { outcome: 'answered' }),
        cap('eth_signTypedData_v4', [CANARY_A, mail(1)]),
      ],
      ctx(),
    );
    expect(out.map((d) => d.evidence.preConnect)).toEqual([true, false, false]);
  });

  it('chain mismatch is judged after a switch-chain (answered, string target only)', () => {
    const out = decodeWalletRequests(
      [
        cap('eth_requestAccounts', [], { outcome: 'answered' }),
        cap('wallet_switchEthereumChain', [{ chainId: '0x89' }], { outcome: 'answered' }),
        cap('eth_signTypedData_v4', [CANARY_A, mail(137)]),
        cap('eth_signTypedData_v4', [CANARY_A, mail(1)]),
        cap('wallet_switchEthereumChain', [{ chainId: '0xa' }], { outcome: 'error' }),
        cap('wallet_switchEthereumChain', [{ chainId: 10 }], { outcome: 'answered' }),
        cap('eth_signTypedData_v4', [CANARY_A, mail(137)]),
      ],
      ctx(),
    );
    expect(out.map((d) => d.walletChainId)).toEqual([1, 1, 137, 137, 137, 137, 137]);
    expect(out.map((d) => d.evidence.chainIdMismatch)).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  it('state is per calling frame: an iframe connecting does not connect the page', () => {
    const iframe = { frame: 'iframe' as const, origin: 'https://widget.example' };
    const out = decodeWalletRequests(
      [
        cap('eth_requestAccounts', [], { ...iframe, outcome: 'answered' }),
        cap('wallet_switchEthereumChain', [{ chainId: '0x89' }], {
          ...iframe,
          outcome: 'answered',
        }),
        cap('eth_signTypedData_v4', [CANARY_A, mail(137)]),
        cap('eth_signTypedData_v4', [CANARY_A, mail(137)], iframe),
      ],
      ctx(),
    );
    expect(out[2]!.evidence).toMatchObject({ preConnect: true, chainIdMismatch: true });
    expect(out[3]!.evidence).toMatchObject({ preConnect: false, chainIdMismatch: false });
  });

  it('is deterministic', () => {
    const list = [cap('eth_requestAccounts', []), cap('personal_sign', ['hi', CANARY_A])];
    expect(canonicalize(decodeWalletRequests(list, ctx()).map((d) => d.evidence))).toBe(
      canonicalize(decodeWalletRequests(list, ctx()).map((d) => d.evidence)),
    );
  });
});

describe('paramsDigest', () => {
  it('is the same for the same request made to different canaries, and never the canary', () => {
    const formsB = buildCanaryForms(CANARY_B);
    const params = (c: string) =>
      JSON.stringify([siwe('app.example.org', 'https://app.example.org', 1, c), c.toLowerCase()]);
    const a = walletParamsDigest(params(CANARY_A), forms);
    const b = walletParamsDigest(params(CANARY_B), formsB);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(walletParamsDigest(JSON.stringify(['other', CANARY_A]), forms)).not.toBe(a);
  });

  it('covers object keys, unparseable params and lone surrogates', () => {
    const keyed = walletParamsDigest(JSON.stringify([{ [CANARY_A]: 1 }]), forms);
    const keyedB = walletParamsDigest(
      JSON.stringify([{ [CANARY_B]: 1 }]),
      buildCanaryForms(CANARY_B),
    );
    expect(keyed).toBe(keyedB);
    expect(walletParamsDigest(`["${CANARY_A}`, forms)).toMatch(/^[0-9a-f]{64}$/);
    expect(walletParamsDigest('["\\ud800"]', forms)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('decoded items carry no time and no raw params', () => {
  it('only the documented fields', () => {
    const e: WalletRequestEvidence = decode(cap('personal_sign', ['hi', CANARY_A]));
    expect(Object.keys(e)).not.toContain('t');
    expect(Object.keys(e)).not.toContain('params');
  });
});
