import { describe, expect, it } from 'vitest';
import type { Finding, ThirdPartyContact } from './report.js';
import { countsTowardScore, scoreReport } from './scoring.js';
import { WEIGHTS } from './weights.js';

let n = 0;
function finding(partial: Partial<Finding>): Finding {
  n += 1;
  return {
    id: `f${n}`,
    category: 'exact',
    encoding: 'lowercase',
    location: 'request-body',
    url: 'http://x.test/',
    method: 'POST',
    host: 'x.test',
    registrableDomain: 'x.test',
    class: 'analytics',
    phase: 'post-connect',
    snippet: '<CANARY>',
    countsTowardScore: true,
    ...partial,
  };
}

function contact(partial: Partial<ThirdPartyContact>): ThirdPartyContact {
  return {
    host: 'x.test',
    registrableDomain: 'x.test',
    class: 'analytics',
    phases: ['pre-connect'],
    requestCount: 1,
    ...partial,
  };
}

describe('countsTowardScore', () => {
  it('excludes partial matches', () => {
    expect(countsTowardScore({ category: 'partial', location: 'url', class: 'analytics' })).toBe(false);
  });
  it('excludes locally persisted findings', () => {
    expect(countsTowardScore({ category: 'exact', location: 'local-storage', class: 'analytics' })).toBe(false);
    expect(countsTowardScore({ category: 'exact', location: 'cookie', class: 'analytics' })).toBe(false);
  });
  it('excludes first-party and anon-rpc', () => {
    expect(countsTowardScore({ category: 'exact', location: 'url', class: 'first-party' })).toBe(false);
    expect(countsTowardScore({ category: 'exact', location: 'url', class: 'anon-rpc' })).toBe(false);
  });
  it('counts exact and hashed third-party leaks', () => {
    expect(countsTowardScore({ category: 'exact', location: 'url', class: 'rpc-provider' })).toBe(true);
    expect(countsTowardScore({ category: 'hashed', location: 'request-body', class: 'analytics' })).toBe(true);
  });
});

describe('scoreReport ledger', () => {
  it('perfect page scores 100 with an empty ledger', () => {
    const { score, ledger } = scoreReport([], []);
    expect(score).toBe(100);
    expect(ledger).toEqual([]);
  });

  it('one leak = one ledger line with the class weight', () => {
    const f = finding({ class: 'analytics', registrableDomain: 'mixpanel.com' });
    const { score, ledger } = scoreReport([f], []);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.points).toBe(WEIGHTS.leak.analytics);
    expect(ledger[0]!.findingIds).toContain(f.id);
    expect(score).toBe(100 - WEIGHTS.leak.analytics);
  });

  it('dedup: many findings to the same (domain, class) charge once', () => {
    const fs = Array.from({ length: 50 }, () =>
      finding({ class: 'analytics', registrableDomain: 'mixpanel.com' }),
    );
    const { ledger } = scoreReport(fs, []);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.points).toBe(WEIGHTS.leak.analytics);
    expect(ledger[0]!.findingIds).toHaveLength(50);
  });

  it('different domains of the same class charge separately', () => {
    const { ledger } = scoreReport(
      [
        finding({ class: 'analytics', registrableDomain: 'mixpanel.com' }),
        finding({ class: 'analytics', registrableDomain: 'amplitude.com' }),
      ],
      [],
    );
    expect(ledger).toHaveLength(2);
  });

  it('hashed-only destinations get the reduced penalty', () => {
    const f = finding({ category: 'hashed', class: 'analytics', registrableDomain: 'seg.test' });
    const { ledger } = scoreReport([f], []);
    expect(ledger[0]!.points).toBe(WEIGHTS.leak.analytics * WEIGHTS.hashedMultiplier);
    expect(ledger[0]!.rule).toContain('hashedMultiplier');
  });

  it('an exact finding alongside hashed removes the discount', () => {
    const { ledger } = scoreReport(
      [
        finding({ category: 'hashed', class: 'analytics', registrableDomain: 'seg.test' }),
        finding({ category: 'exact', class: 'analytics', registrableDomain: 'seg.test' }),
      ],
      [],
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.points).toBe(WEIGHTS.leak.analytics);
  });

  it('weight ordering: rpc < analytics < unknown', () => {
    expect(WEIGHTS.leak['rpc-provider']).toBeLessThan(WEIGHTS.leak.analytics);
    expect(WEIGHTS.leak.analytics).toBeLessThan(WEIGHTS.leak['unknown-third-party']);
  });

  it('contact penalties: per distinct domain per phase, capped', () => {
    const contacts = Array.from({ length: 20 }, (_, i) =>
      contact({ registrableDomain: `cdn${i}.test`, phases: ['pre-connect'] }),
    );
    const { ledger } = scoreReport([], contacts);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.points).toBe(WEIGHTS.contact.capPerPhase);
    expect(ledger[0]!.label).toContain('capped');
  });

  it('post-connect contact costs more than pre-connect', () => {
    const pre = scoreReport([], [contact({ phases: ['pre-connect'] })]);
    const post = scoreReport([], [contact({ phases: ['post-connect'] })]);
    expect(post.score).toBeLessThan(pre.score);
  });

  it('first-party and anon-rpc contacts cost nothing', () => {
    const { score } = scoreReport(
      [],
      [
        contact({ class: 'first-party', registrableDomain: 'example.com' }),
        contact({ class: 'anon-rpc', registrableDomain: 'whatever.test' }),
      ],
    );
    expect(score).toBe(100);
  });

  it('score never goes below 0', () => {
    const fs = Array.from({ length: 10 }, (_, i) =>
      finding({ class: 'unknown-third-party', registrableDomain: `evil${i}.test` }),
    );
    const { score } = scoreReport(fs, []);
    expect(score).toBe(0);
  });

  it('ledger is deterministic regardless of input order', () => {
    const a = finding({ class: 'analytics', registrableDomain: 'a.test' });
    const b = finding({ class: 'rpc-provider', registrableDomain: 'b.test' });
    const l1 = scoreReport([a, b], []).ledger.map((l) => l.label);
    const l2 = scoreReport([b, a], []).ledger.map((l) => l.label);
    expect(l1).toEqual(l2);
  });
});
