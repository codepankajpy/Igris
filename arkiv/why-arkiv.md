# Why Arkiv

Igris needs a registry that is **not ours**. A privacy scanner whose results
live on the scanner authors' server has two fatal problems: you must trust us
to not edit history, and the registry dies when our hosting does. The bounty
rule "no backend we operate" is not a constraint we worked around — it is the
product.

What the registry needs, and what Arkiv gives:

1. **Attributable writes.** Every entity is signed by and owned by a wallet.
   "Who says this dapp leaks?" has a cryptographic answer: the scanner
   address. Our trust model (attestation, not fact; pin scanners you trust;
   "N scanners agree") falls directly out of `$owner`.
2. **Queryable without an indexer.** The viewer needs score ranges, hostname
   lookup, usesAnonRpc filters, newest-first — `arkiv_query` does this
   directly from a static page (CORS `*` verified). No subgraph, no API
   server, no database. A plain JSON-RPC POST is the whole backend.
3. **Mandatory expiry is a feature.** Privacy scans rot. Arkiv forces an
   expiry on every entity, so unrefreshed claims disappear by construction
   (we choose 30 days; justification in [schema.md](./schema.md)). A plain
   blockchain or IPFS would preserve stale accusations forever.
4. **Open write access matches the mission.** Anyone can run `igris scan` and
   publish their own attestations next to ours, with the same schema, and
   viewers can pin whichever scanners they trust. A permissioned registry
   would make us the gatekeeper — exactly what CROPS says to avoid.
5. **Cheap, small, structured.** One scan is one entity with 12 typed
   attributes and a few-KB summary blob — Arkiv's sweet spot, vs. abusing
   calldata or events on an L1 and rebuilding query infra around it.

What we deliberately do NOT use Arkiv for: raw reports (they can embed
canary-bearing URLs; we publish a redacted summary plus a sha256 binding to
the full report), and anything secret (there are no secrets in Igris).
