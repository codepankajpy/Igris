import { describe, expect, it } from 'vitest';
import {
  loadThirdPartyDb,
  validateThirdPartyDb,
  ThirdPartyDbError,
} from './third-parties.js';

describe('data/third-parties.json', () => {
  it('validates against its schema', () => {
    const db = loadThirdPartyDb();
    expect(db.version).toBe(1);
    expect(db.entries.length).toBeGreaterThan(20);
  });

  it('every entry has a source note', () => {
    for (const e of loadThirdPartyDb().entries) {
      expect(e.source, `${e.name} must cite a source`).toMatch(/^(https?:\/\/|observed in fixture)/);
    }
  });

  it('no duplicate domains across entries', () => {
    const seen = new Map<string, string>();
    for (const e of loadThirdPartyDb().entries) {
      for (const d of e.domains) {
        expect(seen.has(d), `${d} appears in both "${seen.get(d)}" and "${e.name}"`).toBe(false);
        seen.set(d, e.name);
      }
    }
  });
});

describe('validateThirdPartyDb', () => {
  it('rejects a missing class', () => {
    expect(() =>
      validateThirdPartyDb({ version: 1, entries: [{ name: 'x', domains: ['a.b'], source: 's' }] }),
    ).toThrow(ThirdPartyDbError);
  });
  it('rejects an unknown class', () => {
    expect(() =>
      validateThirdPartyDb({
        version: 1,
        entries: [{ name: 'x', class: 'nonsense', domains: ['a.b'], source: 's' }],
      }),
    ).toThrow(/class/);
  });
  it('rejects empty domains', () => {
    expect(() =>
      validateThirdPartyDb({
        version: 1,
        entries: [{ name: 'x', class: 'cdn', domains: [], source: 's' }],
      }),
    ).toThrow(/domains/);
  });
  it('rejects unknown properties', () => {
    expect(() =>
      validateThirdPartyDb({
        version: 1,
        entries: [{ name: 'x', class: 'cdn', domains: ['a.b'], source: 's', extra: true }],
      }),
    ).toThrow(/unknown property/);
  });
  it('accepts a valid db', () => {
    expect(() =>
      validateThirdPartyDb({
        version: 1,
        entries: [{ name: 'x', class: 'cdn', domains: ['a.b'], suffixes: ['c.a.b'], source: 's' }],
      }),
    ).not.toThrow();
  });
});
