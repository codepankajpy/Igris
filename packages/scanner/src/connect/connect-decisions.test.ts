/**
 * P1 unit tests for the pure decision functions behind connecting:
 * strict candidate scoring, kit identification and load classification.
 * Cases are taken from real observations (docs/CORPUS.md).
 */
import { describe, expect, it } from 'vitest';
import { isNavigatingLink, scoreCandidates } from './candidates.js';
import { identifyKit, type KitSignal } from './fingerprint.js';
import type { RawCandidate } from './page-probes.js';
import { classifyLoad, cleanNavError } from '../load-state.js';
import { FALLBACK_NAMES, HOP_NAMES, SIGN_NAMES, isCanaryChoice, rankIn } from './choice.js';
import { isUnexpectedNavigation } from './open.js';

let n = 0;
const c = (over: Partial<RawCandidate>): RawCandidate => ({
  index: n++,
  tag: 'button',
  name: 'Connect Wallet',
  role: null,
  href: null,
  disabled: false,
  visible: true,
  inFooter: false,
  top: 10,
  hasPopup: false,
  ...over,
});
const names = (raw: RawCandidate[]) => scoreCandidates(raw).map((s) => s.name);

describe('strict connect-control scoring', () => {
  it('real misclicks of the old heuristic are no longer candidates', () => {
    expect(
      names([
        c({ tag: 'a', href: '/connectkit', name: 'ConnectKit Connecting a wallet, made simple.' }), // family.co
        c({ name: 'Get started now' }), // demo.privy.io
        c({ name: 'Launch app' }),
        c({ name: 'Connect to stake' }),
        c({ name: 'ConnectKit' }),
      ]),
    ).toEqual([]);
  });

  it('ranks exact phrases by tier', () => {
    expect(
      names([
        c({ name: 'Log in', top: 1 }),
        c({ name: 'Connect EVM wallet', top: 2 }),
        c({ name: 'Connect', top: 3 }),
        c({ name: 'Connect Wallet', top: 4 }),
      ]),
    ).toEqual(['Connect Wallet', 'Connect', 'Connect EVM wallet', 'Log in']);
  });

  it('whitespace and case are normalised; CONNECT WALLET (curve.fi) qualifies', () => {
    expect(names([c({ name: '  CONNECT\n WALLET ' })])).toEqual(['CONNECT WALLET']);
  });

  it('never selects a navigating link, but allows button-like anchors', () => {
    expect(isNavigatingLink({ tag: 'a', href: 'https://other.example/' })).toBe(true);
    expect(isNavigatingLink({ tag: 'a', href: '/login' })).toBe(true);
    expect(isNavigatingLink({ tag: 'a', href: '#' })).toBe(false);
    expect(isNavigatingLink({ tag: 'a', href: 'javascript:void(0)' })).toBe(false);
    expect(
      names([
        c({ tag: 'a', href: '/login', name: 'Log in' }),
        c({ tag: 'a', href: '#', name: 'Sign in' }),
      ]),
    ).toEqual(['Sign in']);
  });

  it('excludes invisible, disabled and over-long candidates', () => {
    expect(
      names([
        c({ visible: false }),
        c({ disabled: true }),
        c({ name: 'Connect wallet to see your positions across all supported networks' }),
      ]),
    ).toEqual([]);
  });

  it('footer penalty and deterministic tie-breaking (higher on page, then DOM order)', () => {
    const footer = c({ name: 'Connect Wallet', inFooter: true, top: 5 });
    const low = c({ name: 'Connect Wallet', top: 900 });
    const high = c({ name: 'Connect Wallet', top: 40 });
    const sameTopA = c({ name: 'Connect', top: 300 });
    const sameTopB = c({ name: 'Connect', top: 300 });
    const r = scoreCandidates([footer, low, high, sameTopB, sameTopA].sort(() => 0));
    expect(r.map((x) => x.index)).toEqual([
      high.index,
      low.index,
      sameTopA.index,
      sameTopB.index,
      footer.index,
    ]);
    expect(r.find((x) => x.index === footer.index)).toMatchObject({
      score: 70,
      reasons: ['exact "connect wallet"', 'in <footer> (−30)'],
    });
  });
});

describe('kit identification', () => {
  const s = (
    kit: KitSignal['kit'],
    strength: KitSignal['strength'],
    stage: KitSignal['stage'],
  ): KitSignal => ({
    kit,
    strength,
    stage,
    marker: `${kit}-${stage}`,
  });
  it('an open kit modal is high confidence', () => {
    expect(identifyKit([s('connectkit', 'strong', 'modal')])).toMatchObject({
      id: 'connectkit',
      confidence: 'high',
    });
  });
  it('a modal of one kit wins over a static signal of another (the modal is what the user sees)', () => {
    expect(
      identifyKit([s('appkit', 'strong', 'static'), s('rainbowkit', 'strong', 'modal')]),
    ).toMatchObject({
      id: 'rainbowkit',
      confidence: 'high',
    });
  });
  it('strong static only → medium', () => {
    expect(identifyKit([s('appkit', 'strong', 'static')])).toMatchObject({
      id: 'appkit',
      confidence: 'medium',
    });
  });
  it('an SDK iframe/host alone is low confidence (Uniswap loads Privy but uses its own modal)', () => {
    expect(
      identifyKit([s('privy', 'weak', 'static'), s('privy', 'weak', 'network')]),
    ).toMatchObject({
      id: 'privy',
      confidence: 'low',
    });
  });
  it('conflicts are reported as ambiguous, never guessed', () => {
    expect(
      identifyKit([s('privy', 'strong', 'modal'), s('dynamic', 'strong', 'modal')]),
    ).toMatchObject({
      id: 'none',
      confidence: 'low',
    });
    expect(
      identifyKit([s('privy', 'weak', 'network'), s('dynamic', 'weak', 'network')]).signals[0],
    ).toBe('ambiguous:weak');
  });
  it('nothing → none', () => {
    expect(identifyKit([])).toEqual({ id: 'none', confidence: 'none', signals: [] });
  });
});

describe('load classification', () => {
  it('navigation errors → site-unavailable with the reason', () => {
    expect(
      classifyLoad({ error: 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://x/' }),
    ).toMatchObject({
      category: 'site-unavailable',
      detail: expect.stringMatching(/^DNS/),
    });
    expect(
      classifyLoad({ error: 'TimeoutError: page.goto: Timeout 30000ms exceeded' }).detail,
    ).toMatch(/timeout/);
  });
  it('bot-protection interstitials → bot-blocked', () => {
    expect(
      classifyLoad({ status: 403, headers: { 'cf-mitigated': 'challenge' }, title: '' }).category,
    ).toBe('bot-blocked');
    expect(classifyLoad({ status: 403, title: 'Just a moment...' }).category).toBe('bot-blocked');
    expect(classifyLoad({ status: 200, title: 'Vercel Security Checkpoint' }).category).toBe(
      'bot-blocked',
    );
    expect(
      classifyLoad({
        status: 200,
        title: 'x',
        bodyText: 'Verify you are human by completing the action below.',
      }).category,
    ).toBe('bot-blocked');
  });
  it('a working app that merely embeds a challenge widget is NOT bot-blocked', () => {
    const body = 'Swap anytime, anywhere. '.repeat(40) + 'Verify you are human';
    expect(classifyLoad({ status: 200, title: 'Uniswap Interface', bodyText: body })).toEqual({
      ok: true,
    });
  });
  it('HTTP errors without challenge markers → site-unavailable', () => {
    expect(classifyLoad({ status: 403, title: 'Forbidden' })).toMatchObject({
      category: 'site-unavailable',
      detail: expect.stringMatching(/403/),
    });
    expect(classifyLoad({ status: 500, title: '' }).category).toBe('site-unavailable');
  });
  it('explicit unsupported-browser pages → browser-incompatible', () => {
    expect(
      classifyLoad({
        status: 200,
        title: 'x',
        bodyText: 'Your browser is not supported. Please use a modern browser.',
      }).category,
    ).toBe('browser-incompatible');
  });
  it("the scanner's own egress refusal is labelled as such, not as a site error", () => {
    expect(classifyLoad({ status: 403, headers: { 'x-igris-egress': 'blocked' } })).toMatchObject({
      category: 'site-unavailable',
      detail: expect.stringMatching(/egress policy/),
    });
  });
  it('a proxied DNS failure is reported as DNS, not as an egress refusal', () => {
    const error =
      'Error: page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://nope.xyz/\nCall log:\n\u001b[2m  - navigating to "https://nope.xyz/"\u001b[22m';
    expect(classifyLoad({ error, proxyRefusal: 'DNS resolution failed' })).toEqual({
      ok: false,
      category: 'site-unavailable',
      detail: 'DNS name not resolved (checked by the egress proxy)',
    });
    expect(classifyLoad({ error, proxyRefusal: 'private address 10.0.0.1' }).detail).toBe(
      'refused by egress policy: private address 10.0.0.1',
    );
  });
  it('navigation error text is one clean line (no ANSI codes, no call log)', () => {
    const error =
      'Error: page.goto: net::ERR_CONNECTION_REFUSED at https://x.org/\nCall log:\n\u001b[2m  - navigating\u001b[22m';
    expect(cleanNavError(error)).toBe('net::ERR_CONNECTION_REFUSED at https://x.org/');
    expect(classifyLoad({ error }).detail).toBe(
      'connection refused/reset: net::ERR_CONNECTION_REFUSED at https://x.org/',
    );
  });
  it('a normal page is ok', () => {
    expect(classifyLoad({ status: 200, title: 'Aave', bodyText: 'Markets Dashboard' })).toEqual({
      ok: true,
    });
  });
});

describe('navigation guard', () => {
  it('origin changes are unexpected; same-origin route changes are not', () => {
    expect(isUnexpectedNavigation('https://app.x.org/', 'https://evil.example/')).toBe(true);
    expect(isUnexpectedNavigation('https://app.x.org/', 'https://x.org/')).toBe(true);
    expect(isUnexpectedNavigation('https://app.x.org/', 'https://app.x.org/connect')).toBe(false);
  });
});

describe('wallet choice inside the dialog (whole names only)', () => {
  it('our EIP-6963 wallet by rdns testid or exact name (+ status word)', () => {
    expect(isCanaryChoice('', 'rk-wallet-option-network.igris.canary')).toBe(true);
    expect(isCanaryChoice('', 'wallet-selector-network.igris.canary')).toBe(true);
    expect(isCanaryChoice('Igris Canary Wallet', null)).toBe(true);
    expect(isCanaryChoice('Igris Canary Wallet INSTALLED', null)).toBe(true);
    expect(isCanaryChoice('Igris  Canary Wallet Detected', null)).toBe(true);
    expect(isCanaryChoice('Learn about Igris Canary Wallet security', null)).toBe(false);
  });
  it('marketing prose that mentions a wallet is never a choice (relay.link regression)', () => {
    const prose = '$20B+ settled across 85+ chains, powering Phantom, MetaMask,';
    expect(isCanaryChoice(prose, null)).toBe(false);
    expect(rankIn(FALLBACK_NAMES, prose)).toBe(-1);
    expect(rankIn(HOP_NAMES, prose)).toBe(-1);
  });
  it('fallbacks are generic injected entries, best first', () => {
    expect(rankIn(FALLBACK_NAMES, 'Browser Wallet')).toBe(0);
    expect(rankIn(FALLBACK_NAMES, 'Injected')).toBe(1);
    expect(rankIn(FALLBACK_NAMES, 'MetaMask Detected')).toBe(2);
    expect(rankIn(FALLBACK_NAMES, 'MetaMask Portfolio')).toBe(-1);
    expect(rankIn(FALLBACK_NAMES, 'Coinbase Wallet')).toBe(-1);
  });
  it('hops reveal a wallet list (Dynamic: "Continue with a wallet")', () => {
    expect(rankIn(HOP_NAMES, 'Continue with a wallet')).toBe(0);
    expect(rankIn(HOP_NAMES, 'Other Wallets')).toBe(2);
    expect(rankIn(HOP_NAMES, 'Continue with Google')).toBe(-1);
    expect(rankIn(HOP_NAMES, 'Continue')).toBe(-1);
  });
  it('sign-in confirmations are exact (never "Sign up" or "Sign out")', () => {
    expect(rankIn(SIGN_NAMES, 'Sign message')).toBe(0);
    expect(rankIn(SIGN_NAMES, 'Verify wallet')).toBe(1);
    expect(rankIn(SIGN_NAMES, 'Sign up')).toBe(-1);
    expect(rankIn(SIGN_NAMES, 'Sign out')).toBe(-1);
  });
});
