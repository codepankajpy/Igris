import { describe, expect, it } from 'vitest';
import type { PublishedScan } from '../src/api.js';
import { elapsedMs, ipText, onArkiv, proofStatus, provenance, railChange } from '../src/wording.js';

const scan = (version: number, findingSetSha256 = 'f'.repeat(64)): PublishedScan => ({
  key: `0x${String(version).padStart(64, '0')}`,
  owner: `0x${'5'.repeat(40)}`,
  hostname: 'app.example.org',
  version,
  previous: version > 1 ? `0x${String(version - 1).padStart(64, '0')}` : null,
  scannedAt: 1_790_000_000 + version,
  scanId: 'a'.repeat(64),
  evidenceSha256: 'b'.repeat(64),
  findingSetSha256,
  state: 'address-to-trackers',
  coverage: 'full',
  recipients: 3,
  addressRecipients: 1,
  trackingRecipients: 1,
  usesAnonRpc: false,
  scannerVersion: '0.3.0',
  reportVersion: '3.0.0',
  expiresAtBlock: null,
});

describe('proof chip: provenance (defect 1)', () => {
  it('a published version served from the cache while the registry is Arkiv says so', () => {
    const d = { source: 'local' as const, scan: scan(2) };
    expect(provenance(d, 'arkiv')).toBe('Published on Arkiv · served from this server’s cache');
    expect(onArkiv(d, 'arkiv')).toBe(true);
  });
  it('read back from Arkiv / stored in a local registry / registry not known yet', () => {
    expect(provenance({ source: 'arkiv', scan: scan(2) }, 'arkiv')).toBe('Published on Arkiv');
    expect(provenance({ source: 'local', scan: scan(2) }, 'local')).toBe(
      'Stored in the local registry',
    );
    expect(onArkiv({ source: 'local', scan: scan(2) }, 'local')).toBe(false);
    // Never claims "local registry" before the registry mode is known.
    expect(provenance({ source: 'local', scan: scan(2) }, undefined)).toBe(
      'Served from this server’s store',
    );
  });
  it('an unpublished scan is never called published', () => {
    expect(provenance({ source: 'local', scan: null }, 'arkiv')).toBe(
      'Not published on Arkiv yet · served from this server’s cache',
    );
    expect(provenance({ source: 'local', scan: null }, undefined)).toMatch(/^Not published/);
    expect(provenance({ source: 'local', scan: null }, 'local')).toMatch(/^Not saved/);
    expect(onArkiv({ source: 'local', scan: null }, 'arkiv')).toBe(false);
  });
});

describe('proof chip: status never hides problems (defect 1)', () => {
  it('verified with no problems is the only ✓', () => {
    expect(proofStatus({ verified: true, problems: [] })).toEqual({
      ok: true,
      text: 'verified ✓',
    });
  });
  it('verified but with problems shows the count, not a bare ✓', () => {
    const s = proofStatus({ verified: true, problems: ['Arkiv read failed: timeout'] });
    expect(s.ok).toBe(false);
    expect(s.text).toBe('verified · 1 problem');
    expect(s.text).not.toContain('✓');
    expect(proofStatus({ verified: true, problems: ['a', 'b'] }).text).toBe(
      'verified · 2 problems',
    );
  });
  it('not verified', () => {
    expect(proofStatus({ verified: false, problems: ['x'] })).toEqual({
      ok: false,
      text: 'verification failed · 1 problem',
    });
    expect(proofStatus({ verified: false, problems: [] }).text).toBe('verification failed');
  });
});

describe('version history compares by version number (defect 2)', () => {
  it('consecutive versions compare with version − 1', () => {
    const vs = [scan(2, 'x'.repeat(64)), scan(1, 'y'.repeat(64))];
    expect(railChange(vs[0]!, vs)).toBe('finding set differs from v1');
    expect(railChange(vs[1]!, vs)).toBe('first version');
    const same = [scan(2), scan(1)];
    expect(railChange(same[0]!, same)).toBe('same finding set as v1');
  });
  it('a gap in the list is not "first version" and not compared with the wrong one', () => {
    // v4 and v2 are missing (expired, or signed by an untrusted owner).
    const vs = [scan(5), scan(3), scan(1, 'z'.repeat(64))];
    expect(railChange(vs[0]!, vs)).toBe('previous version not listed');
    expect(railChange(vs[1]!, vs)).toBe('previous version not listed');
    expect(railChange(vs[2]!, vs)).toBe('first version');
    // Oldest listed entry is v3, not v1: still not the first version.
    const tail = [scan(4), scan(3)];
    expect(railChange(tail[1]!, tail)).toBe('previous version not listed');
    expect(railChange(tail[0]!, tail)).toBe('same finding set as v3');
  });
  it('"first version" when previous is null', () => {
    const v = { ...scan(3), previous: null };
    expect(railChange(v, [v])).toBe('first version');
  });
});

describe('scan elapsed time never mixes clocks (defect 4)', () => {
  // The browser clock is 1 hour ahead of the server's.
  const SKEW = 3_600_000;
  const server = (ms: number) => new Date(Date.parse('2026-11-06T09:00:00Z') + ms).toISOString();
  const browser = (ms: number) => Date.parse('2026-11-06T09:00:00Z') + ms + SKEW;

  it('finished: the job’s finishedAt − startedAt, whatever the browser clock says', () => {
    expect(
      elapsedMs({
        t0: server(0),
        anchor: { at: server(4_000), seenAt: browser(4_100) },
        finishedAt: server(15_000),
        finished: true,
        now: browser(99_000),
      }),
    ).toBe(15_000);
  });
  it('finished before the job is re-fetched: the last event’s time', () => {
    expect(
      elapsedMs({
        t0: server(0),
        anchor: { at: server(4_000), seenAt: browser(4_100) },
        finishedAt: undefined,
        finished: true,
        now: browser(99_000),
      }),
    ).toBe(4_000);
  });
  it('running: server progress + browser time since the last event, skew-free', () => {
    expect(
      elapsedMs({
        t0: server(0),
        anchor: { at: server(4_000), seenAt: browser(4_100) },
        finishedAt: undefined,
        finished: false,
        now: browser(6_100),
      }),
    ).toBe(6_000);
  });
  it('not started → null; never negative', () => {
    expect(
      elapsedMs({
        t0: undefined,
        anchor: undefined,
        finishedAt: undefined,
        finished: false,
        now: 0,
      }),
    ).toBeNull();
    expect(
      elapsedMs({
        t0: server(5_000),
        anchor: { at: server(1_000), seenAt: browser(1_000) },
        finishedAt: undefined,
        finished: false,
        now: browser(0),
      }),
    ).toBe(0);
  });
});

describe('recipient IP wording (defect 5)', () => {
  it('WebSocket-only contact still reveals the IP', () => {
    const t = ipText({ learned: { address: 'none', addressPhases: [], ip: [] } });
    expect(t).toBe(
      'Contacted over WebSocket only (no HTTP request); the connection still revealed the visitor’s IP',
    );
  });
  it('HTTP contact lists its phases', () => {
    const t = ipText({ learned: { address: 'none', addressPhases: [], ip: ['pre-connect'] } });
    expect(t).toMatch(/^Learned the visitor’s IP /);
  });
});
