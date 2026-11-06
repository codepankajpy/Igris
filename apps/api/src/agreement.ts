/**
 * Agreement between independent scanner nodes on one round
 * (docs/design/SCAN-NETWORK.md, "Rounds and agreement"). Pure and
 * deterministic: the API decides, the website only displays.
 *
 * Live pages vary between runs, so whole-scan hashes rarely match; nodes are
 * compared per recipient, keyed by (registrableDomain, class):
 *  - agree   — every node saw it, same verdict and the same "received the
 *              address" (exact/hashed vs possible/none);
 *  - differ  — every node saw it, verdict or received-the-address differs;
 *  - partial — some nodes did not see it.
 */
import type { AddressExposure, Recipient, Verdict } from '@igris/core';

export type AgreementStatus = 'agree' | 'differ' | 'partial';

export interface NodeObservation {
  verdict: Verdict;
  address: AddressExposure;
}

export interface AgreementRow {
  registrableDomain: string;
  class: string;
  /** One entry per node (by label); null when that node did not see the recipient. */
  byNode: Record<string, NodeObservation | null>;
  status: AgreementStatus;
}

export interface Agreement {
  /** Node labels, in the order given. */
  nodes: string[];
  rows: AgreementRow[];
  summary: Record<AgreementStatus, number>;
}

/** One node's (verified) report of the round. */
export interface NodeReport {
  node: string;
  report: {
    recipients: ReadonlyArray<
      Pick<Recipient, 'registrableDomain' | 'class' | 'verdict' | 'learned'>
    >;
  };
}

/** Did the recipient receive the wallet address (exact or hashed forms)? */
export function receivedAddress(a: AddressExposure): boolean {
  return a === 'exact' || a === 'hashed';
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Compare the reports of ≥ 2 distinct nodes; null with fewer than 2 (a single
 * node agrees with nobody). Throws on a duplicated node label — the caller
 * picks one report per node. Rows are sorted by registrableDomain, then class.
 */
export function compareRound(inputs: readonly NodeReport[]): Agreement | null {
  const nodes = inputs.map((i) => i.node);
  if (new Set(nodes).size !== nodes.length) throw new Error('compareRound: one report per node');
  if (nodes.length < 2) return null;

  const rows = new Map<string, AgreementRow>();
  const keyOf = (domain: string, cls: string) => JSON.stringify([domain, cls]);
  for (const { node, report } of inputs) {
    for (const r of report.recipients) {
      const k = keyOf(r.registrableDomain, r.class);
      let row = rows.get(k);
      if (!row) {
        row = {
          registrableDomain: r.registrableDomain,
          class: r.class,
          byNode: Object.fromEntries(nodes.map((n) => [n, null])),
          status: 'partial',
        };
        rows.set(k, row);
      }
      // A report lists each (domain, class) once; should one repeat, the first counts.
      row.byNode[node] ??= { verdict: r.verdict, address: r.learned.address };
    }
  }

  const summary: Record<AgreementStatus, number> = { agree: 0, differ: 0, partial: 0 };
  for (const row of rows.values()) {
    const seen = nodes.map((n) => row.byNode[n] ?? null);
    if (seen.some((o) => o === null)) row.status = 'partial';
    else {
      const [first, ...rest] = seen as NodeObservation[];
      const same = rest.every(
        (o) =>
          o.verdict === first!.verdict &&
          receivedAddress(o.address) === receivedAddress(first!.address),
      );
      row.status = same ? 'agree' : 'differ';
    }
    summary[row.status] += 1;
  }

  return {
    nodes,
    rows: [...rows.values()].sort(
      (a, b) => cmp(a.registrableDomain, b.registrableDomain) || cmp(a.class, b.class),
    ),
    summary,
  };
}
