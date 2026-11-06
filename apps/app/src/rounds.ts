/**
 * Rounds (docs/design/SCAN-NETWORK.md): a request and the trusted scans that
 * fulfilled it. Pure arrangement and wording of what GET /api/sites/:hostname
 * and GET /api/sites/:hostname/rounds/:requestKey return — the API decides
 * the rounds, the node labels and every agree / differ / partial status.
 * Unit-tested in test/rounds.test.ts.
 */
import type { Agreement, PublishedScan, RoundSummary } from './api.js';

const ADDRESS = /0x[0-9a-fA-F]{40}/;

/**
 * A scanner node's label as the API gave it ("Scanner 1"). Labels are never
 * addresses; should one ever contain an address, it is not shown.
 */
export function nodeLabel(label: string): string {
  return ADDRESS.test(label) || !label.trim() ? 'Unnamed scanner' : label;
}

/** Distinct node labels of a round, in the order the API lists its scans. */
export function roundNodes(round: RoundSummary): string[] {
  return [...new Set(round.scans.map((s) => s.node))];
}

/**
 * The key of the request a round was made for. The API sends the request
 * itself while its entity lives; once it has expired on Arkiv it sends
 * `request: null` but still groups the scans that fulfilled it, each of
 * which carries the request's key — so the key is the one all its scans
 * name. Null for a scan made without a request.
 */
export function roundRequestKey(
  round: RoundSummary,
  versions: readonly PublishedScan[],
): string | null {
  if (round.request !== null) return round.request.key;
  const byKey = new Map(versions.map((v) => [v.key, v]));
  const named = round.scans.map((s) => byKey.get(s.key)?.request ?? null);
  const first = named[0] ?? null;
  if (first === null) return null;
  return named.every((k) => k !== null && k.toLowerCase() === first.toLowerCase()) ? first : null;
}

/** "Request · 2 scanners" (null for a scan made without a request). */
export function roundLabel(
  round: RoundSummary,
  versions: readonly PublishedScan[] = [],
): string | null {
  if (roundRequestKey(round, versions) === null) return null;
  const n = roundNodes(round).length;
  return `Request · ${n} scanner${n === 1 ? '' : 's'}`;
}

export interface RailItem {
  v: PublishedScan;
  /** The node that published it, from the rounds; null when no round lists it. */
  node: string | null;
}
export interface RailGroup {
  round: RoundSummary | null;
  /** Group heading; null for a version shown on its own. */
  label: string | null;
  items: RailItem[];
}

/**
 * The version rail, newest first, with the versions of one request kept
 * together under one heading (the group sits where its newest version is).
 * Versions no round lists, and scans made without a request, stand alone.
 */
export function railGroups(
  versions: readonly PublishedScan[],
  rounds: readonly RoundSummary[],
): RailGroup[] {
  const byKey = new Map<string, { round: RoundSummary; node: string }>();
  for (const round of rounds)
    for (const s of round.scans) byKey.set(s.key, { round, node: s.node });
  const placed = new Set<string>();
  const out: RailGroup[] = [];
  for (const v of versions) {
    if (placed.has(v.key)) continue;
    const info = byKey.get(v.key);
    if (!info || roundRequestKey(info.round, versions) === null) {
      placed.add(v.key);
      out.push({
        round: info?.round ?? null,
        label: null,
        items: [{ v, node: info?.node ?? null }],
      });
      continue;
    }
    const items = versions
      .filter((x) => !placed.has(x.key) && byKey.get(x.key)?.round === info.round)
      .map((x) => ({ v: x, node: byKey.get(x.key)!.node }));
    for (const i of items) placed.add(i.v.key);
    out.push({ round: info.round, label: roundLabel(info.round, versions), items });
  }
  return out;
}

/** The round that lists the version numbered `n` (by its entity key), else null. */
export function roundOf(
  n: number,
  versions: readonly PublishedScan[],
  rounds: readonly RoundSummary[],
): RoundSummary | null {
  const v = versions.find((x) => x.version === n);
  if (!v) return null;
  return rounds.find((r) => r.scans.some((s) => s.key === v.key)) ?? null;
}

/**
 * A round worth comparing — made for a request (live or expired), fulfilled
 * by at least two scans — gives the request key to load it by; else null.
 */
export function comparableKey(
  round: RoundSummary | null,
  versions: readonly PublishedScan[],
): string | null {
  if (round === null || round.scans.length < 2) return null;
  return roundRequestKey(round, versions);
}

/** Shown in place of the request when the API says its entity has expired (request: null). */
export const REQUEST_EXPIRED = 'Request expired; the scans remain on Arkiv.';

type Row = Agreement['rows'][number];

/** The status of one recipient in words; `partial` names the nodes that saw it. */
export function statusText(row: Row, nodes: readonly string[]): string {
  if (row.status === 'agree') return 'Agree';
  if (row.status === 'differ') return 'Differ';
  const seen = nodes.filter((n) => row.byNode[n]).map(nodeLabel);
  if (seen.length === 0) return 'Seen by no scanner';
  return `Only ${seen.join(' and ')}`;
}

export const AGREEMENT_EXPLAINED =
  'Live pages vary between runs — A/B tests, location, timing — so two scanners’ reports almost never match byte for byte, and agreement is shown per third party. For each recipient the API checks that every scanner saw it, gave it the same verdict, and saw the same about the address.';
