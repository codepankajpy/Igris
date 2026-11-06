import { describe, expect, it } from 'vitest';
import { diffVersions } from './diff.js';
import { fixedSegment, leaky } from './test-fixtures.js';

describe('diffVersions', () => {
  it('same behaviour, nothing changed (a retest of an unchanged site)', () => {
    const a = leaky('2026-11-06T00:00:00.000Z').report;
    const b = leaky('2026-11-08T00:00:00.000Z').report;
    expect(diffVersions(a, b)).toEqual({
      sameBehaviour: true,
      added: [],
      removed: [],
      changed: [],
    });
  });

  it('a recipient that stopped receiving is removed; the reverse is added', () => {
    const a = leaky().report;
    const b = fixedSegment().report;
    expect(diffVersions(a, b)).toEqual({
      sameBehaviour: false,
      added: [],
      removed: [{ registrableDomain: 'segment.io', class: 'analytics' }],
      changed: [],
    });
    expect(diffVersions(b, a)).toMatchObject({
      sameBehaviour: false,
      added: [{ registrableDomain: 'segment.io', class: 'analytics' }],
      removed: [],
    });
  });

  it('verdict or address changes are listed with from/to, sorted by domain', () => {
    const a = leaky().report;
    const b = structuredClone(a);
    const infura = b.recipients.find((r) => r.registrableDomain === 'infura.io')!;
    infura.verdict = 'expected';
    infura.learned.address = 'none';
    const sentry = b.recipients.find((r) => r.registrableDomain === 'sentry.io')!;
    sentry.learned.address = 'exact';
    const changes = diffVersions(a, b);
    expect(changes.sameBehaviour).toBe(true); // finding set untouched in this synthetic edit
    expect(changes.changed).toEqual([
      {
        ref: { registrableDomain: 'infura.io', class: 'rpc-provider' },
        from: { verdict: 'avoidable', address: 'exact' },
        to: { verdict: 'expected', address: 'none' },
      },
      {
        ref: { registrableDomain: 'sentry.io', class: 'error-monitoring' },
        from: { verdict: 'tracking', address: 'hashed' },
        to: { verdict: 'tracking', address: 'exact' },
      },
    ]);
  });

  it('the same domain under a different class is a different recipient', () => {
    const a = leaky().report;
    const b = structuredClone(a);
    b.recipients.find((r) => r.registrableDomain === 'googleapis.com')!.class = 'analytics';
    const changes = diffVersions(a, b);
    expect(changes.added).toEqual([{ registrableDomain: 'googleapis.com', class: 'analytics' }]);
    expect(changes.removed).toEqual([{ registrableDomain: 'googleapis.com', class: 'cdn' }]);
  });
});
