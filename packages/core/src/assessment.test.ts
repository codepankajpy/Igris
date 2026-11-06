import { describe, expect, it } from 'vitest';
import { recipientsOf, summarise } from './assessment.js';
import { req, sampleCapture, sampleResult, sampleResultV2 } from './test-helpers.js';

describe('summarise (deterministic, report-derived, no score)', () => {
  it('address-to-trackers: the address reached analytics / error monitoring', () => {
    const { report, bundle } = sampleResult();
    const s = summarise(report, bundle);
    expect(s.state).toBe('address-to-trackers');
    expect(s.headline).toBe(
      'Wallet address sent to 2 third parties that track visitors or could not be identified',
    );
    expect(s.points[0]).toBe(
      'The throwaway wallet address was observed reaching infura.io, segment.io, sentry.io.',
    );
    expect(s.points).toContain('2 third parties are trackers: segment.io, sentry.io.');
  });

  it('address-to-services: only an RPC provider received the address', () => {
    const cap = sampleCapture();
    cap.requests = cap.requests.filter((r) => !/segment|sentry/.test(r.url));
    const { report, bundle } = sampleResult({ capture: cap });
    const s = summarise(report, bundle);
    expect(s.state).toBe('address-to-services');
    expect(s.headline).toBe('Wallet address sent to 1 service the dApp uses; no trackers');
    expect(s.points.some((p) => p.includes('avoidable') && p.includes('infura.io'))).toBe(true);
  });

  it('no-address-observed: says the address was not observed', () => {
    const cap = sampleCapture();
    cap.requests = [req()];
    cap.storage = [];
    const { report, bundle } = sampleResult({ capture: cap });
    const s = summarise(report, bundle);
    expect(s.state).toBe('no-address-observed');
    expect(s.headline).toBe('No wallet-address leak observed; 0 third parties contacted');
    expect(s.points).toContain(
      'The throwaway wallet address was not observed in any third-party traffic.',
    );
  });

  it('a third party contacted without the address is listed with its verdict, not as a leak', () => {
    const cap = sampleCapture();
    cap.requests = cap.requests.slice(0, 2); // first party + fonts.googleapis.com
    cap.storage = [];
    const { report, bundle } = sampleResult({ capture: cap });
    const s = summarise(report, bundle);
    expect(s.state).toBe('no-address-observed');
    expect(s.points.join(' ')).toMatch(/googleapis\.com/);
    expect(s.points.join(' ')).toMatch(/before any wallet interaction/);
  });

  it('partial coverage is always stated', () => {
    const { report, bundle } = sampleResult({ status: 'wallet-connect-failed' });
    const s = summarise(report, bundle);
    expect(s.caveats[0]).toMatch(/Partial scan/);
    expect(s.points).toContain(
      'The wallet could not be connected; only behaviour before connecting was observed.',
    );
  });

  it('not-observed when nothing was measured', () => {
    const { report, bundle } = sampleResult({ status: 'page-load-failed' });
    expect(summarise(report, bundle)).toMatchObject({ state: 'not-observed' });
  });

  it('headlines and points never mention a score or grade', () => {
    for (const r of [
      sampleResult(),
      sampleResult({ status: 'wallet-connect-failed' }),
      sampleResult({ status: 'page-load-failed' }),
    ]) {
      const s = summarise(r.report, r.bundle);
      expect([s.headline, ...s.points, ...s.caveats].join(' ')).not.toMatch(
        /score|grade|\/100|points/i,
      );
    }
  });

  it('2.x reports: same recipients and same summary as their 3.0.0 counterpart', () => {
    const v3 = sampleResult();
    const v2 = sampleResultV2();
    expect(recipientsOf(v2.report, v2.bundle)).toEqual(v3.report.recipients);
    expect(summarise(v2.report, v2.bundle)).toEqual(summarise(v3.report, v3.bundle));
  });
});
