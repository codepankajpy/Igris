/**
 * What changed between two versions of a site (docs/design/FLOW.md,
 * `Changes`). A pure function of the two reports: recipients are matched on
 * (registrable domain, class); a recipient "changed" when its verdict or what
 * it learned of the address differs.
 */
import type { AddressExposure, ReportV3, Verdict } from '@igris/core';

export interface RecipientRef {
  registrableDomain: string;
  class: string;
}

export interface RecipientState {
  verdict: Verdict;
  address: AddressExposure;
}

export interface Changes {
  /** Same finding set (digest and count): the scans observed the same behaviour. */
  sameBehaviour: boolean;
  added: RecipientRef[];
  removed: RecipientRef[];
  changed: Array<{ ref: RecipientRef; from: RecipientState; to: RecipientState }>;
}

const keyOf = (r: RecipientRef) => `${r.registrableDomain}\u0000${r.class}`;
const byRef = (a: RecipientRef, b: RecipientRef) =>
  a.registrableDomain < b.registrableDomain
    ? -1
    : a.registrableDomain > b.registrableDomain
      ? 1
      : a.class < b.class
        ? -1
        : a.class > b.class
          ? 1
          : 0;

/** Changes from `prev` (version n − 1) to `next` (version n). */
export function diffVersions(prev: ReportV3, next: ReportV3): Changes {
  const before = new Map(prev.recipients.map((r) => [keyOf(r), r]));
  const after = new Map(next.recipients.map((r) => [keyOf(r), r]));
  const ref = (r: RecipientRef): RecipientRef => ({
    registrableDomain: r.registrableDomain,
    class: r.class,
  });
  const added: RecipientRef[] = [];
  const removed: RecipientRef[] = [];
  const changed: Changes['changed'] = [];
  for (const [k, r] of after) {
    const old = before.get(k);
    if (!old) {
      added.push(ref(r));
    } else if (old.verdict !== r.verdict || old.learned.address !== r.learned.address) {
      changed.push({
        ref: ref(r),
        from: { verdict: old.verdict, address: old.learned.address },
        to: { verdict: r.verdict, address: r.learned.address },
      });
    }
  }
  for (const [k, r] of before) if (!after.has(k)) removed.push(ref(r));
  added.sort(byRef);
  removed.sort(byRef);
  changed.sort((a, b) => byRef(a.ref, b.ref));
  return {
    sameBehaviour:
      prev.findingSet.sha256 === next.findingSet.sha256 &&
      prev.findingSet.count === next.findingSet.count,
    added,
    removed,
    changed,
  };
}
