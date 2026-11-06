# How Igris uses Arkiv

## Writes (CLI, Node)

`igris publish <report.json>` →
[packages/registry/src/arkiv.ts](../packages/registry/src/arkiv.ts):

- wallet from `ARKIV_PRIVATE_KEY` (never committed; `.env.example` documents
  it), chain `rabdi({ accessKey })`, transport `http()` (endpoint overridable
  with `ARKIV_RPC_URL` / `--rpc-url`);
- `walletClient.createEntity(ScanSchema, values, { expiration:
  ExpirationTime.fromDays(30) })` — one entity per scan, schema
  `igris.scan.v1` ([schema.md](./schema.md));
- the `summary` bytes column holds redacted compact JSON; `reportSha256`
  binds the entity to the exact `report.json`.

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
