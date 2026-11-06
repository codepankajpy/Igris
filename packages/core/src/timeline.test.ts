import { describe, expect, it } from 'vitest';
import { keccak256, stringToBytes } from 'viem';
import type { Capture } from './contracts/capture.js';
import { buildCanaryForms } from './encodings.js';
import { buildTimeline, type TimelineOptions } from './timeline.js';
import { CANARY_A, req, sampleCapture, sampleResult } from './test-helpers.js';
import { verifyReportIntegrity } from './contracts/verify.js';
import { validateReport } from './contracts/validate.js';

const CLASSES: Record<
  string,
  'first-party' | 'analytics' | 'rpc-provider' | 'walletconnect-relay'
> = {
  'example.org': 'first-party',
  'segment.io': 'analytics',
  'infura.io': 'rpc-provider',
  'walletconnect.com': 'walletconnect-relay',
};
const classify: TimelineOptions['classify'] = (host) => {
  const rd = host.split('.').slice(-2).join('.');
  return { registrableDomain: rd, class: CLASSES[rd] ?? 'first-party' };
};
const recipients: TimelineOptions['recipients'] = [
  { registrableDomain: 'segment.io', class: 'analytics' },
  { registrableDomain: 'infura.io', class: 'rpc-provider' },
  { registrableDomain: 'walletconnect.com', class: 'walletconnect-relay' },
];
const opts = (over: Partial<TimelineOptions> = {}): TimelineOptions => ({
  classify,
  canary: buildCanaryForms(CANARY_A),
  recipients,
  ...over,
});
const empty = (): Capture => ({
  requests: [],
  wsFrames: [],
  wsConnections: 0,
  storage: [],
  cookies: [],
});

describe('buildTimeline', () => {
  it('is null when the capture recorded no times', () => {
    expect(buildTimeline(sampleCapture(), opts())).toBeNull();
    expect(buildTimeline(empty(), opts())).toBeNull();
  });

  it('first contact and first address per recipient, min over requests', () => {
    const c = empty();
    c.requests = [
      req({ url: 'https://api.segment.io/v1/page', t: 900 }),
      req({ url: 'https://api.segment.io/v1/t', body: `{"userId":"${CANARY_A}"}`, t: 4200.6 }),
      req({ url: `https://api.segment.io/v1/i?u=${CANARY_A}`, t: 3100 }),
      req({ url: 'https://api.segment.io/v1/page', t: 120 }),
      req({ url: 'https://mainnet.infura.io/v3/k', body: '{"method":"eth_chainId"}', t: 50 }),
    ];
    const t = buildTimeline(c, opts())!;
    expect(t.origin).toBe('navigation-start');
    expect(t.recipients).toEqual([
      {
        registrableDomain: 'segment.io',
        class: 'analytics',
        firstContactMs: 120,
        firstAddressMs: 3100,
      },
      {
        registrableDomain: 'infura.io',
        class: 'rpc-provider',
        firstContactMs: 50,
        firstAddressMs: null,
      },
      {
        registrableDomain: 'walletconnect.com',
        class: 'walletconnect-relay',
        firstContactMs: null,
        firstAddressMs: null,
      },
    ]);
  });

  it('headers, hashed forms and WebSocket frames count; a truncated form does not', () => {
    const hashed = keccak256(stringToBytes(CANARY_A.toLowerCase())).slice(2);
    const c = empty();
    c.requests = [
      req({ url: 'https://api.segment.io/a', headers: { 'x-user': CANARY_A }, t: 700 }),
      req({ url: `https://mainnet.infura.io/h?x=${hashed}`, t: 800 }),
      req({
        url: `https://mainnet.infura.io/p?x=${CANARY_A.slice(0, 8)}...${CANARY_A.slice(-4)}`,
        t: 10,
      }),
    ];
    c.wsFrames = [
      {
        phase: 'post-connect',
        url: 'wss://relay.walletconnect.com/',
        direction: 'sent',
        payload: 'hi',
        t: 30,
      },
      {
        phase: 'post-connect',
        url: 'wss://relay.walletconnect.com/',
        direction: 'sent',
        payload: CANARY_A,
        t: 60,
      },
    ];
    const t = buildTimeline(c, opts())!;
    expect(t.recipients.map((r) => [r.firstContactMs, r.firstAddressMs])).toEqual([
      [700, 700],
      [10, 800],
      [30, 60],
    ]);
  });

  it('requests per second: dense 1 s buckets, first vs third party, blocked and untimed excluded', () => {
    const c = empty();
    c.requests = [
      req({ url: 'https://app.example.org/', t: 0 }),
      req({ url: 'https://app.example.org/a.js', t: 999 }),
      req({ url: 'https://api.segment.io/x', t: 1000 }),
      req({ url: 'https://api.segment.io/x', t: 3500 }),
      req({ url: 'https://blocked.segment.io/x', t: 3600 }),
      req({ url: 'https://api.segment.io/x' }), // no t
      req({ url: 'data:text/plain,x', t: 10 }),
    ];
    const t = buildTimeline(c, opts({ wasBlocked: (u) => u.hostname.startsWith('blocked.') }))!;
    expect(t.requestsPerSecond).toEqual([
      { t: 0, firstParty: 2, thirdParty: 0 },
      { t: 1000, firstParty: 0, thirdParty: 1 },
      { t: 2000, firstParty: 0, thirdParty: 0 },
      { t: 3000, firstParty: 0, thirdParty: 1 },
    ]);
  });

  it('caps requestsPerSecond at 600 buckets (later requests still give first contact)', () => {
    const c = empty();
    c.requests = [req({ url: 'https://api.segment.io/x', t: 700_000 })];
    const t = buildTimeline(c, opts())!;
    expect(t.requestsPerSecond).toEqual([]);
    expect(t.recipients[0]!.firstContactMs).toBe(700_000);
    c.requests.push(req({ t: 599_999 }));
    expect(buildTimeline(c, opts())!.requestsPerSecond).toHaveLength(600);
  });

  it('milestones: integer ms, sorted, invalid dropped, at most 20', () => {
    const c = empty();
    c.milestones = [
      { event: 'connect-started', t: 2000.4 },
      { event: 'page-loaded', t: 1500 },
      { event: 'observation-ended', t: Number.NaN },
      { event: 'accounts-requested', t: -5 },
    ];
    expect(buildTimeline(c, opts())!.milestones).toEqual([
      { event: 'accounts-requested', t: 0 },
      { event: 'page-loaded', t: 1500 },
      { event: 'connect-started', t: 2000 },
    ]);
    c.milestones = Array.from({ length: 30 }, (_, i) => ({ event: 'page-loaded' as const, t: i }));
    expect(buildTimeline(c, opts())!.milestones).toHaveLength(20);
  });
});

describe('timeline in the engine', () => {
  const timedCapture = () => {
    const c = sampleCapture();
    c.requests = c.requests.map((r, i) => ({ ...r, t: 100 + i * 700 }));
    c.milestones = [
      { event: 'page-loaded', t: 400 },
      { event: 'connect-started', t: 900 },
      { event: 'connect-finished', t: 1300 },
      { event: 'observation-ended', t: 5000 },
    ];
    return c;
  };

  it('a capture without times gives timeline null', () => {
    expect(sampleResult().report.timeline).toBeNull();
  });

  it('a timed capture gives a schema-valid timeline aligned with recipients', () => {
    const { report, bundle } = sampleResult({ capture: timedCapture() });
    expect(() => validateReport(report)).not.toThrow();
    expect(verifyReportIntegrity(report, bundle)).toMatchObject({ ok: true });
    const t = report.timeline!;
    expect(t.recipients.map((r) => `${r.registrableDomain}|${r.class}`)).toEqual(
      report.recipients.map((r) => `${r.registrableDomain}|${r.class}`),
    );
    expect(t.milestones.map((m) => m.event)).toEqual([
      'page-loaded',
      'connect-started',
      'connect-finished',
      'observation-ended',
    ]);
    // Every recipient that received the address (exact/hashed) has a first-address time.
    for (const r of report.recipients) {
      const tr = t.recipients.find((x) => x.registrableDomain === r.registrableDomain)!;
      expect(tr.firstContactMs).not.toBeNull();
      expect(tr.firstAddressMs !== null).toBe(
        r.learned.address === 'exact' || r.learned.address === 'hashed',
      );
    }
    const total = t.requestsPerSecond.reduce((s, b) => s + b.firstParty + b.thirdParty, 0);
    expect(total).toBe(report.telemetry!.totalRequests);
  });

  it('times never reach the evidence bundle or the finding set', () => {
    const a = sampleResult();
    const b = sampleResult({ capture: timedCapture() });
    expect(b.report.evidence.sha256).toBe(a.report.evidence.sha256);
    expect(b.report.findingSet).toEqual(a.report.findingSet);
  });
});
