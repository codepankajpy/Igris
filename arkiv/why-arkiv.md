# Why Arkiv

IGRIS tells people which third parties a dApp sends their wallet address
and IP to. Those results must not live only on our server: you would have to
trust us not to edit history, and they would disappear with our hosting.

What the registry needs, and what Arkiv gives:

1. **Attributable writes.** Every entity is owned by the wallet that signed
   it. "Who says this site sends my address to a tracker?" has a
   cryptographic answer: the scanner address. Readers trust owners they
   choose (`IGRIS_TRUSTED_SCANNERS`); anyone else's entities are ignored.
2. **Version history as data.** Each retest is a new `igris.scan.v2` entity
   whose `previous` points at the last one. The history of a site is on
   Arkiv, not in our database, and any IGRIS instance can rebuild it.
3. **Self-verifying content.** The full report and its evidence bundle are
   published (gzip, canonical JSON). Their hashes are indexed attributes, so
   a reader re-checks the hashes, the schema and every verdict from Arkiv
   alone, without trusting the API that served them.
4. **A cross-site view nobody else has.** One `igris.flow.v1` entity per
   recipient of each scan makes "which scanned sites send data to
   segment.io?" a single indexed query, for us and for anyone else. One
   `igris.walletreq.v1` per decoded wallet request does the same for "which
   scanned sites ask for an unlimited Permit2 approval?".
5. **No single server to trust or censor.** Anyone can write an
   `igris.request.v1` asking for a scan; any scanner node polls for them,
   scans independently and publishes a version linked to the request.
   Readers compare the nodes' results per recipient. Arkiv supplies each
   piece: permissionless writes (anyone may ask), an immutable `$creator`
   (each node's results are attributable; trust is the reader's choice),
   `readonly` (IGRIS's requests cannot be changed after a node acted on
   them; other creators' need not be, since each node re-validates the URL
   it scans) and `permissionlessExtension` (anyone may keep a request alive
   for longer than its 7 days).
6. **Queryable without an indexer.** `arkiv_query` filters, sorts and
   selects typed attributes directly. No subgraph, no separate database.
7. **Atomic batches.** `executeBatch` writes the scan, its evidence, its
   flows and its wallet requests in one transaction, so a version is never
   half-published.
8. **Expiry matches the data.** A privacy scan describes a site at one
   moment. Scan entities live 180 days (close to Arkiv's maximum) and then
   expire unless the site is retested, which publishes a new version. A
   scan request is a call to act now: it lives 7 days.

What we do not put on Arkiv: anything secret (there is none) and anything
that could identify a real user. The only wallet address in a report is the
scan's throwaway canary, and the evidence bundle is checked to contain no
form of it before publishing.
