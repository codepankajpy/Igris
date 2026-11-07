# How IGRIS uses Arkiv

One product, one flow: a visitor searches a site on the website, sees its
latest report and version history, and can retest. Every completed scan is
published to Arkiv by the backend (`apps/api`); the website never talks to
Arkiv directly. Entities: [schema.md](./schema.md).

## Writes (backend)

[packages/registry/src/arkiv.ts](../packages/registry/src/arkiv.ts) —
`ArkivSiteRegistry.publish(report, bundle)`:

1. `buildPublication` refuses anything that must not be published: a report
   that is not 3.0.0, fails schema validation or integrity against its
   evidence, has coverage `none` (the page never loaded), contains the canary
   in its evidence (or as a wallet-request address), has a malformed
   wallet-request entry, or whose gzip payload exceeds 128 KiB.
2. It reads the latest version of the hostname (trusted owners and the
   publisher) → `version = latest + 1`, `previous = latest.key`.
3. **One `walletClient.executeBatch({ creates })`**: the `igris.scan.v2`
   entity (attributes, gzip report), the `igris.evidence.v1`
   entity (gzip bundle), one `igris.flow.v1` per recipient and one
   `igris.walletreq.v1` per wallet request except `connect`, all readonly
   with `ExpirationTime.fromDays(180)`. The batch is atomic, so a version
   never exists without its evidence, flows or wallet requests. The created
   keys come back in batch order: scan, evidence, flows, wallet requests.
   Before signing, a batch whose calldata alone would exceed the 2^24 gas
   cap is refused (schema.md → "Batch size").

Signing key: the node's scanner profile (`loadScanner()`, mode 0600 under
`~/.igris`, never from env). Chain `rabdi({ accessKey })` with
`ARKIV_ACCESS_KEY`; publishes within one process are serialised.

## Reads (backend → website)

Raw `arkiv_query` JSON-RPC calls whose query strings are built with the SDK
expression builders (`and`, `or`, `eq`, `checkAgainstSchema`):

| feature                      | query                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| site page, version history   | scan.v2 `hostname = …` AND owners, `ORDER BY version:i32 DESC`                                      |
| one version                  | … AND `version = i32(n)`                                                                            |
| recently scanned sites       | scan.v2 AND owners, `ORDER BY scannedAt:u64 DESC` → latest per hostname                             |
| full report of a version     | scan.v2 `$key = key(…)` (selecting `report`) + evidence.v1 `sha256`,`scanId`                        |
| "also receives data from …"  | flow.v1 `recipient = …` AND owners, then each site's latest version                                 |
| wallet requests across sites | walletreq.v1 [`kind`, `unlimited = i32(1)`, `hostname`] AND owners, then each site's latest version |

"owners" is always `$creator = addr(…)` OR-ed over the trusted scanners,
never `$owner`.

Listings select every column except the `report` payload. Every row is
decoded strictly and skipped when invalid
([packages/registry/src/rows.ts](../packages/registry/src/rows.ts)); the
SDK's own row decoding is bypassed because one malformed value fails a whole
page there. `load()` verifies the report and evidence against the entity
(schema.md → "Trust and verification on read").

When version n is shown, the API loads version n − 1 too and computes
`diffVersions(prev, next)`: same behaviour (finding-set digest), recipients
added / removed, verdict or address changes.

## Offline parity

`LocalSiteRegistry` stores the **same entities, attributes and bytes** in
one JSON file, in Arkiv's JSON-RPC entity shape, so one decoder reads both
and every behaviour (versions, verification, refusals, trust) is identical.
Deterministic keys (`local:<sha256>`), atomic writes (temp + rename).

## Verified vs. unverified

- **Verified live** (2026-11-06, public Rabdi RPC, no access key): every
  query shape above returns without error (owner OR-groups, `ORDER BY
version:i32` / `scannedAt:u64`, attribute selection), and the
  organisers' curl in schema.md.
- **Verified with a mocked node**: the batch contents, version chaining,
  load verification and owner filtering (`packages/registry/src/arkiv.test.ts`);
  wallet-request entities and their flags, every new
  query string, hostile rows and `$owner`-transfer forgeries for every
  entity type, and the gas estimate (`packages/registry/src/network.test.ts`,
  against both backends).
- **Verified live** (2026-11-06/07, Rabdi): publishes of app.uniswap.org
  (v1 → v3), swap.cow.fi and app.ens.domains; entities come back readonly
  (`creationFlags` `{"readonly":true,…}`), `$creator` = the scanner, and the
  `previous` chain intact.
- **UNVERIFIED**: a live `igris.walletreq.v1` write (no scanned real site
  has asked for a signature yet; the fixture page that does is not hosted
  publicly, so it is covered offline by `packages/scanner/e2e/wallet-requests.e2e.ts`
  and the registry tests).
