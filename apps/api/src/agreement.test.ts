/**
 * Pure units of the scan network: agreement between nodes (per recipient)
 * and node labels.
 */
import { describe, expect, it } from 'vitest';
import type { AddressExposure, Verdict } from '@igris/core';
import { compareRound, receivedAddress, type NodeReport } from './agreement.js';
import { NodeLabels, UNLISTED_NODE } from './nodes.js';

type Rec = NodeReport['report']['recipients'][number];

function rec(
  registrableDomain: string,
  verdict: Verdict,
  address: AddressExposure,
  cls: Rec['class'] = 'analytics',
): Rec {
  return {
    registrableDomain,
    class: cls,
    verdict,
    learned: { address, addressPhases: [], ip: ['post-connect'] },
  };
}

const node = (name: string, ...recipients: Rec[]): NodeReport => ({
  node: name,
  report: { recipients },
});

describe('compareRound', () => {
  it('agree: every node saw it with the same verdict and the same received-the-address', () => {
    const a = compareRound([
      node('Scanner 1', rec('segment.io', 'tracking', 'exact')),
      node('Scanner 2', rec('segment.io', 'tracking', 'exact')),
    ]);
    expect(a).toEqual({
      nodes: ['Scanner 1', 'Scanner 2'],
      rows: [
        {
          registrableDomain: 'segment.io',
          class: 'analytics',
          byNode: {
            'Scanner 1': { verdict: 'tracking', address: 'exact' },
            'Scanner 2': { verdict: 'tracking', address: 'exact' },
          },
          status: 'agree',
        },
      ],
      summary: { agree: 1, differ: 0, partial: 0 },
    });
  });

  it('exact vs hashed both received the address (agree); possible vs none both did not (agree)', () => {
    const a = compareRound([
      node('Scanner 1', rec('a.io', 'tracking', 'exact'), rec('b.io', 'expected', 'possible')),
      node('Scanner 2', rec('a.io', 'tracking', 'hashed'), rec('b.io', 'expected', 'none')),
    ])!;
    expect(a.rows.map((r) => r.status)).toEqual(['agree', 'agree']);
    // byNode keeps what each node actually saw.
    expect(a.rows[0]!.byNode['Scanner 2']).toEqual({ verdict: 'tracking', address: 'hashed' });
  });

  it('differ: verdict differs, or one node saw the address reach it and another did not', () => {
    const a = compareRound([
      node('Scanner 1', rec('a.io', 'tracking', 'none'), rec('b.io', 'tracking', 'hashed')),
      node('Scanner 2', rec('a.io', 'avoidable', 'none'), rec('b.io', 'tracking', 'possible')),
    ])!;
    expect(a.rows.map((r) => [r.registrableDomain, r.status])).toEqual([
      ['a.io', 'differ'],
      ['b.io', 'differ'],
    ]);
    expect(a.summary).toEqual({ agree: 0, differ: 2, partial: 0 });
  });

  it('partial: some node did not see the recipient (null for that node)', () => {
    const a = compareRound([
      node('Scanner 1', rec('a.io', 'tracking', 'exact'), rec('only1.io', 'tracking', 'exact')),
      node('Scanner 2', rec('a.io', 'tracking', 'exact')),
      node('Scanner 3', rec('a.io', 'tracking', 'exact'), rec('only3.io', 'expected', 'none')),
    ])!;
    const by = Object.fromEntries(a.rows.map((r) => [r.registrableDomain, r]));
    expect(by['a.io']!.status).toBe('agree');
    expect(by['only1.io']!.status).toBe('partial');
    expect(by['only1.io']!.byNode).toEqual({
      'Scanner 1': { verdict: 'tracking', address: 'exact' },
      'Scanner 2': null,
      'Scanner 3': null,
    });
    expect(by['only3.io']!.status).toBe('partial');
    expect(a.summary).toEqual({ agree: 1, differ: 0, partial: 2 });
    expect(a.nodes).toEqual(['Scanner 1', 'Scanner 2', 'Scanner 3']);
  });

  it('keys rows by (registrableDomain, class) and sorts them', () => {
    const a = compareRound([
      node(
        'Scanner 1',
        rec('z.io', 'expected', 'none', 'rpc-provider'),
        rec('z.io', 'tracking', 'exact'),
      ),
      node(
        'Scanner 2',
        rec('z.io', 'expected', 'none', 'rpc-provider'),
        rec('a.io', 'tracking', 'exact'),
      ),
    ])!;
    expect(a.rows.map((r) => [r.registrableDomain, r.class, r.status])).toEqual([
      ['a.io', 'analytics', 'partial'],
      ['z.io', 'analytics', 'partial'],
      ['z.io', 'rpc-provider', 'agree'],
    ]);
  });

  it('a recipient repeated within one report counts once (the first)', () => {
    const a = compareRound([
      node('Scanner 1', rec('a.io', 'tracking', 'exact'), rec('a.io', 'expected', 'none')),
      node('Scanner 2', rec('a.io', 'tracking', 'exact')),
    ])!;
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]!.status).toBe('agree');
  });

  it('null with fewer than two nodes; throws on a node given twice', () => {
    expect(compareRound([])).toBeNull();
    expect(compareRound([node('Scanner 1', rec('a.io', 'tracking', 'exact'))])).toBeNull();
    expect(() => compareRound([node('Scanner 1'), node('Scanner 1')])).toThrow(/one report/);
  });

  it('two nodes that saw nothing agree on nothing (no rows)', () => {
    expect(compareRound([node('Scanner 1'), node('Scanner 2')])).toEqual({
      nodes: ['Scanner 1', 'Scanner 2'],
      rows: [],
      summary: { agree: 0, differ: 0, partial: 0 },
    });
  });

  it('receivedAddress: exact and hashed only', () => {
    expect((['exact', 'hashed', 'possible', 'none'] as const).map(receivedAddress)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe('NodeLabels', () => {
  const A = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
  const B = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
  const C = '0xcccccccccccccccccccccccccccccccccccccccc';

  it('this node first, then IGRIS_TRUSTED_SCANNERS order; case-insensitive', () => {
    const l = new NodeLabels(B, [A, B, C]);
    expect([l.label(B), l.label(A), l.label(C)]).toEqual(['Scanner 1', 'Scanner 2', 'Scanner 3']);
    expect(l.label(A.toLowerCase())).toBe('Scanner 2');
    expect(l.list()).toEqual([
      { label: 'Scanner 1', self: true },
      { label: 'Scanner 2', self: false },
      { label: 'Scanner 3', self: false },
    ]);
    expect(l.isSelf(B.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(l.isSelf(A)).toBe(false);
  });

  it('read-only node: no self; unknown owners are unlisted; rank sorts labels', () => {
    const l = new NodeLabels(null, [A, C]);
    expect(l.list()).toEqual([
      { label: 'Scanner 1', self: false },
      { label: 'Scanner 2', self: false },
    ]);
    expect(l.label(B)).toBe(UNLISTED_NODE);
    expect(
      ['Scanner 10', UNLISTED_NODE, 'Scanner 2'].sort((x, y) => l.rank(x) - l.rank(y)),
    ).toEqual(['Scanner 2', 'Scanner 10', UNLISTED_NODE]);
  });

  it('labels never contain the address', () => {
    const l = new NodeLabels(A, [C]);
    expect(JSON.stringify(l.list())).not.toMatch(/0x/i);
  });
});
