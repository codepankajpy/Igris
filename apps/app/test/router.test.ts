import { describe, expect, it } from 'vitest';
import { parse, paths } from '../src/router.js';

const ID = '0b5f8a52-3c1e-4d2a-9f60-1a2b3c4d5e6f';
const EV = `ev_${'0123456789abcdef'.repeat(2).slice(0, 24)}`;

describe('unpublished scan report routes (addition 7)', () => {
  it('#/scan/:id/report is the cached report of a completed scan', () => {
    expect(parse(`#/scan/${ID}/report`)).toEqual({ name: 'scan-report', id: ID });
    expect(paths.scanReport(ID)).toBe(`/scan/${ID}/report`);
    expect(parse(`#${paths.report({ kind: 'scan', id: ID })}`)).toEqual({
      name: 'scan-report',
      id: ID,
    });
  });
  it('its evidence explorer, with and without an item', () => {
    expect(parse(`#/scan/${ID}/report/evidence`)).toEqual({ name: 'scan-evidence', id: ID });
    expect(parse(`#/scan/${ID}/report/evidence/${EV}`)).toEqual({
      name: 'scan-evidence',
      id: ID,
      item: EV,
    });
    expect(paths.evidenceOf({ kind: 'scan', id: ID }, EV)).toBe(
      `/scan/${ID}/report/evidence/${EV}`,
    );
  });
  it('published versions keep their routes', () => {
    const ref = { kind: 'version' as const, hostname: 'app.example.org', version: 2 };
    expect(paths.report(ref)).toBe('/site/app.example.org/v/2');
    expect(paths.evidenceOf(ref, EV)).toBe(`/site/app.example.org/v/2/evidence/${EV}`);
    expect(parse(`#/scan/${ID}`)).toEqual({ name: 'scan', id: ID });
  });
  it('malformed scan routes are not found', () => {
    expect(parse(`#/scan/${ID}/report/x`).name).toBe('not-found');
    expect(parse(`#/scan/${ID}/report/evidence/ev_zz`).name).toBe('not-found');
    expect(parse(`#/scan/a.b/report`).name).toBe('not-found');
  });
});
