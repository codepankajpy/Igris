/**
 * Scanner node labels (docs/design/SCAN-NETWORK.md): readers see "Scanner 1",
 * "Scanner 2"… — never addresses. Order: this node first, then the trusted
 * scanners in IGRIS_TRUSTED_SCANNERS order. Each scan still links to its
 * Arkiv entity and transaction, where the signer is public by design.
 */

export interface NodeView {
  label: string;
  self: boolean;
}

/** Shown for an owner outside the trusted list (registries only return trusted owners). */
export const UNLISTED_NODE = 'Unlisted scanner';

export class NodeLabels {
  private readonly order: string[];
  private readonly selfKey: string | null;

  /**
   * @param self    this node's publisher (null when read-only: no "self" node)
   * @param trusted trusted owners in configuration order (may include self)
   */
  constructor(self: string | null, trusted: readonly string[]) {
    const seen = new Set<string>();
    this.order = [];
    for (const o of self === null ? trusted : [self, ...trusted]) {
      const k = o.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      this.order.push(k);
    }
    this.selfKey = self === null ? null : self.toLowerCase();
  }

  /** "Scanner n" for a trusted owner (case-insensitive), else UNLISTED_NODE. */
  label(owner: string): string {
    const i = this.order.indexOf(owner.toLowerCase());
    return i < 0 ? UNLISTED_NODE : `Scanner ${i + 1}`;
  }

  /** Position of a label in node order (unlisted last); for sorting. */
  rank(label: string): number {
    const m = /^Scanner ([1-9][0-9]*)$/.exec(label);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  }

  isSelf(owner: string): boolean {
    return this.selfKey !== null && owner.toLowerCase() === this.selfKey;
  }

  /** Every known node, in label order (labels only). */
  list(): NodeView[] {
    return this.order.map((k, i) => ({ label: `Scanner ${i + 1}`, self: k === this.selfKey }));
  }
}
