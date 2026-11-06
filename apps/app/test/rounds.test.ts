import { describe, expect, it } from 'vitest';
import type {
  Agreement,
  PublishedScan,
  RoundSummary,
  ScanRequest,
  SiteResponse,
} from '../src/api.js';
import {
  AGREEMENT_EXPLAINED,
  RECHECK_WINDOW_S,
  REQUEST_EXPIRED,
  comparableKey,
  nodeLabel,
  railGroups,
  roundLabel,
  roundOf,
  roundRequestKey,
  shouldRecheck,
  statusText,
} from '../src/rounds.js';

const k = (n: number) => `0x${String(n).padStart(64, '0')}`;
const scan = (version: number, request: string | null = null): PublishedScan => ({
  key: k(version),
  hostname: 'app.example.org',
  version,
  previous: version > 1 ? k(version - 1) : null,
  scannedAt: 1_790_000_000 + version,
  scanId: 'a'.repeat(64),
  evidenceSha256: 'b'.repeat(64),
  findingSetSha256: 'f'.repeat(64),
  state: 'no-address-observed',
  coverage: 'full',
  recipients: 1,
  addressRecipients: 0,
  trackingRecipients: 0,
  usesAnonRpc: false,
  scannerVersion: '0.3.0',
  reportVersion: '3.0.0',
  expiresAtBlock: null,
  request,
});
const request = (n: number): ScanRequest => ({
  key: k(100 + n),
  hostname: 'app.example.org',
  url: 'https://app.example.org/',
  requestedAt: 1_790_000_000,
  expiresAtBlock: null,
});

// v5 + v4: request A by two nodes; v3: request B by one node; v2: no request; v1: unlisted.
const versions = [5, 4, 3, 2, 1].map((n) => scan(n));
const A: RoundSummary = {
  request: request(1),
  scans: [
    { version: 5, key: k(5), node: 'Scanner 2' },
    { version: 4, key: k(4), node: 'Scanner 1' },
  ],
};
const B: RoundSummary = {
  request: request(2),
  scans: [{ version: 3, key: k(3), node: 'Scanner 1' }],
};
const C: RoundSummary = { request: null, scans: [{ version: 2, key: k(2), node: 'Scanner 1' }] };

describe('version rail grouped by round', () => {
  it('versions of one request sit together under "Request · N scanners"', () => {
    const g = railGroups(versions, [A, B, C]);
    expect(g.map((x) => [x.label, x.items.map((i) => [i.v.version, i.node])])).toEqual([
      [
        'Request · 2 scanners',
        [
          [5, 'Scanner 2'],
          [4, 'Scanner 1'],
        ],
      ],
      ['Request · 1 scanner', [[3, 'Scanner 1']]],
      [null, [[2, 'Scanner 1']]],
      [null, [[1, null]]], // listed by no round: no node chip, never a guess
    ]);
  });
  it('members of a round are pulled together even when another version sits between them', () => {
    const r: RoundSummary = {
      request: request(3),
      scans: [
        { version: 5, key: k(5), node: 'Scanner 2' },
        { version: 3, key: k(3), node: 'Scanner 1' },
      ],
    };
    const g = railGroups(versions.slice(0, 3), [r]);
    expect(g.map((x) => x.items.map((i) => i.v.version))).toEqual([[5, 3], [4]]);
  });
  it('no rounds (an API older than scanner nodes): every version stands alone', () => {
    expect(railGroups(versions, []).every((x) => x.label === null && x.items.length === 1)).toBe(
      true,
    );
  });
  it('the scanner count is of distinct nodes', () => {
    expect(
      roundLabel({ ...A, scans: [...A.scans, { version: 6, key: k(6), node: 'Scanner 2' }] }),
    ).toBe('Request · 2 scanners');
    expect(roundLabel(C)).toBeNull();
  });
});

describe('agreement: which round, and only when there is something to compare', () => {
  it('finds the round of a version by its entity key', () => {
    expect(roundOf(4, versions, [A, B, C])).toBe(A);
    expect(roundOf(1, versions, [A, B, C])).toBeNull();
    expect(roundOf(9, versions, [A])).toBeNull();
  });
  it('a request fulfilled by ≥ 2 scans is comparable; one scan or no request is not', () => {
    expect(comparableKey(A, versions)).toBe(A.request!.key);
    expect(comparableKey(B, versions)).toBeNull();
    expect(comparableKey({ ...C, scans: [...C.scans, ...A.scans] }, versions)).toBeNull();
    expect(comparableKey(null, versions)).toBeNull();
  });
  it('an expired request (request: null) is still a round: keyed by the request its scans name', () => {
    const key = request(1).key;
    const vs = [scan(5, key), scan(4, key), scan(3)];
    const expired: RoundSummary = { request: null, scans: A.scans };
    expect(roundRequestKey(expired, vs)).toBe(key);
    expect(comparableKey(expired, vs)).toBe(key);
    expect(roundLabel(expired, vs)).toBe('Request · 2 scanners');
    expect(railGroups(vs, [expired])[0]!.items.map((i) => i.v.version)).toEqual([5, 4]);
    // Scans that name different requests, or none, are not one request's round.
    expect(roundRequestKey(expired, [scan(5, key), scan(4, request(2).key)])).toBeNull();
    expect(roundRequestKey(expired, [scan(5, key), scan(4)])).toBeNull();
    expect(roundRequestKey(expired, [])).toBeNull();
    expect(REQUEST_EXPIRED).toBe('Request expired; the scans remain on Arkiv.');
  });
  it('status words come from the API status; partial names who saw it', () => {
    const nodes = ['Scanner 1', 'Scanner 2', 'Scanner 3'];
    const row = (
      status: Agreement['rows'][number]['status'],
      seen: string[],
    ): Agreement['rows'][number] => ({
      registrableDomain: 'segment.io',
      class: 'analytics',
      status,
      byNode: Object.fromEntries(
        nodes.map((n) => [n, seen.includes(n) ? { verdict: 'tracking', address: 'exact' } : null]),
      ),
    });
    expect(statusText(row('agree', nodes), nodes)).toBe('Agree');
    expect(statusText(row('differ', nodes), nodes)).toBe('Differ');
    expect(statusText(row('partial', ['Scanner 1']), nodes)).toBe('Only Scanner 1');
    expect(statusText(row('partial', ['Scanner 1', 'Scanner 3']), nodes)).toBe(
      'Only Scanner 1 and Scanner 3',
    );
  });
  it('the explanation says pages vary between runs, so agreement is per third party', () => {
    expect(AGREEMENT_EXPLAINED).toMatch(/pages vary between runs/);
    expect(AGREEMENT_EXPLAINED).toMatch(/per third party/);
  });
});

describe('scanner nodes are shown by label, never by address', () => {
  it('a label is shown as given', () => {
    expect(nodeLabel('Scanner 2')).toBe('Scanner 2');
  });
  it('a label that carries an address (or nothing) is not shown', () => {
    expect(nodeLabel('0x5c0f3e2d9a1b4c6e8f7a9b0c1d2e3f4a5b6c7d8e')).toBe('Unnamed scanner');
    expect(nodeLabel('node 0x5C0F3E2D9A1B4C6E8F7A9B0C1D2E3F4A5B6C7D8E')).toBe('Unnamed scanner');
    expect(nodeLabel('  ')).toBe('Unnamed scanner');
  });
});

describe('shouldRecheck', () => {
  const req = (requestedAt: number): ScanRequest => ({
    key: '0x' + 'ab'.repeat(32),
    hostname: 'a.example',
    url: 'https://a.example/',
    requestedAt,
    expiresAtBlock: null,
  });
  const site = (over: Partial<SiteResponse>): SiteResponse => ({
    hostname: 'a.example',
    versions: [],
    scanning: null,
    rounds: [],
    ...over,
  });
  const now = 1_800_000_000;
  it('re-checks while a scan is running', () => {
    expect(shouldRecheck(site({ scanning: { id: 'j', state: 'running' } }), now)).toBe(true);
  });
  it('re-checks while a recent request may still be answered', () => {
    expect(shouldRecheck(site({ rounds: [{ request: req(now - 60), scans: [] }] }), now)).toBe(
      true,
    );
  });
  it('stops once the window has passed, for expired requests and for no rounds', () => {
    expect(
      shouldRecheck(site({ rounds: [{ request: req(now - RECHECK_WINDOW_S), scans: [] }] }), now),
    ).toBe(false);
    expect(shouldRecheck(site({ rounds: [{ request: null, scans: [] }] }), now)).toBe(false);
    expect(shouldRecheck(site({}), now)).toBe(false);
  });
  it('ignores a request dated far in the future', () => {
    expect(shouldRecheck(site({ rounds: [{ request: req(now + 3600), scans: [] }] }), now)).toBe(
      false,
    );
  });
});
