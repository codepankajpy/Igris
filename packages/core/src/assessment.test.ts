import { describe, expect, it } from 'vitest';
import { assess } from './assessment.js';
import { req, sampleCapture, sampleResult } from './test-helpers.js';

describe('assess (deterministic, report-derived)', () => {
  it('critical: exact address reached analytics (the hashed Sentry leak is medium, so it does not count as severe)', () => {
    const { report, bundle } = sampleResult();
    const a = assess(report, bundle);
    expect(a.level).toBe('critical');
    expect(a.headline).toBe('Wallet address sent to 1 tracking or unidentified third party');
    expect(a.points[0]).toBe(
      'The throwaway wallet address was observed reaching infura.io, segment.io, sentry.io.',
    );
  });

  it('high: only an RPC provider received the address', () => {
    const cap = sampleCapture();
    cap.requests = cap.requests.filter((r) => !/segment|sentry/.test(r.url));
    const { report, bundle } = sampleResult({ capture: cap });
    expect(assess(report, bundle).level).toBe('high');
  });

  it('no leak: banded by score, and says the address was not observed', () => {
    const cap = sampleCapture();
    cap.requests = [req()];
    cap.storage = [];
    const { report, bundle } = sampleResult({ capture: cap });
    const a = assess(report, bundle);
    expect(report.privacy.score).toBe(100);
    expect(a.level).toBe('low');
    expect(a.points).toContain(
      'The throwaway wallet address was not observed in any third-party traffic.',
    );
  });

  it('partial coverage is always stated', () => {
    const { report, bundle } = sampleResult({ status: 'wallet-connect-failed' });
    const a = assess(report, bundle);
    expect(a.caveats[0]).toMatch(/Partial scan/);
    expect(a.points).toContain(
      'The wallet could not be connected; only behaviour before connecting was observed.',
    );
  });

  it('not-assessed when nothing was measured', () => {
    const { report, bundle } = sampleResult({ status: 'page-load-failed' });
    expect(assess(report, bundle)).toMatchObject({ level: 'not-assessed' });
  });
});
