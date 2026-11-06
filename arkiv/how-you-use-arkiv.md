# How Igris uses Arkiv

## Writes (CLI, Node)

`igris publish <report.json>` →
[packages/registry/src/arkiv.ts](../packages/registry/src/arkiv.ts):

- signed by this machine's scanner key (`igris scanner init`; stored mode
  0600 in `~/.igris`, bound to this node, never read from env); chain
  `rabdi({ accessKey })`, transport `http()` (endpoint overridable with
  `ARKIV_RPC_URL` / `--rpc-url`);
- before signing, the report and its evidence bundle are schema-validated
  and integrity-checked (`igris verify` semantics);
- `walletClient.createEntity(ScanSchema, values, { expiration:
ExpirationTime.fromDays(30) })` — one entity per scan, schema
  `igris.scan.v1` ([schema.md](./schema.md));
- the `summary` bytes column holds redacted compact JSON (summary v2);
  `reportSha256` is the canonical content hash of the Report v2 and
  `summary.evidenceSha256` the hash of its evidence bundle
  ([docs/CONTRACTS.md](../docs/CONTRACTS.md)). Publishing the bundle itself
  so third parties can check it is ROADMAP P2-3.

## Reads (CLI and the static viewer — reads drive visible features)

- `igris query --hostname h --min-score n --max-score n --class c --since iso
--scanner 0x… --uses-anon-rpc true|false` → SDK query builder:
  `select('*').from(ScanSchema).where(and(eq/gte/lte/…)).ownedBy(scanner)
.orderBy(desc('scannedAt')).limit(n)`.
- The viewer (apps/web) runs the same query from the browser against a
  **user-configurable** endpoint, renders the result list (latest entity per
  hostname per scanner, "N scanners agree"), and a per-dapp detail page from
  the entity's summary — filters change the Arkiv query itself, not just
  client-side trimming. One exception: leak-class matching is client-side
  because the query language has no substring operator
  ([friction.md](./friction.md) #2).
- `igris snapshot` walks every `igris.scan.v1` entity with key-cursor
  pagination (`$key > key(last) ORDER BY $key ASC`, pages of 100) into one
  JSON file for the offline viewer mode and the extension stub.

## Offline parity

`LocalRegistry` (a JSON file) implements the same `RegistryBackend`
interface, so `pnpm demo`, the e2e suite and the viewer all work with the
testnet down — the demo's fallback path during judging.

## Verified vs. unverified

- **Verified live** (2026-11-06, public Rabdi RPC): query and snapshot walk
  (zero entities before our first publish), CORS from Node and the browser.
- **UNVERIFIED**: a real funded publish — the faucet is a human browser flow.
  Exact repro: STATUS.md → "TODO(human): fund and publish".
