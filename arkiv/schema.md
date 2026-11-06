# Arkiv schema: `igris.scan.v1`

One compact entity per scan, written by the scanner's wallet. Defined in
[packages/registry/src/schema.ts](../packages/registry/src/schema.ts) with the
`@arkiv-network/sdk` schema builder.

## Attributes

| Attribute | Type | Indexed | Why |
| --- | --- | --- | --- |
| `hostname` | str | yes | the registry's primary lookup ("is this dapp scanned?") |
| `score` | i32 | yes | range filters (`--min-score`, viewer slider) |
| `scannedAt` | u64 (unix s) | yes | "latest N": Arkiv cannot sort on `$createdAt`, so we store our own timestamp and `ORDER BY scannedAt DESC` |
| `leakCount` | i32 | yes | quick "has leaks" filters |
| `thirdPartyCount` | i32 | yes | IP-exposure filters |
| `usesAnonRpc` | bool | yes | the EF-bounty before/after story is queryable |
| `leakClasses` | str | no | comma-joined class list (≤128 bytes); Arkiv has no substring operator, so class filtering is client-side anyway — unindexed is cheaper |
| `scannerVersion`, `reportVersion`, `chainId` | str/str/i32 | no | provenance, returned with results |
| `reportSha256` | str | no | sha256 (hex) of the exact `report.json` bytes — anyone holding the report can prove it matches this entity |
| `summary` | bytes | n/a (bytes can't be indexed) | compact JSON: findings (class/location/encoding/category/host/phase), third parties, score ledger, reads-via-wallet. **No URLs, no snippets** — raw URLs can embed the canary |

Schema names are versioned (`igris.scan.v1`); a breaking change ships as
`igris.scan.v2` instead of corrupting old rows.

## Owners and trust model

Arkiv is a public, permissionless database: **anyone** can write entities with
the `igris.scan.v1` tag. An entity is therefore an **attestation by its
scanner address** (`$owner`), not a fact. Every consumer filters or labels by
owner:

- `igris query --scanner 0x…` filters server-side with `$owner`.
- The viewer keeps a user-editable pin list of trusted scanner addresses in
  its own localStorage, labels unpinned scanners, shows the latest entity per
  (hostname, scanner), and shows "N scanners agree" when several scanners
  attest the same hostname.
- `reportSha256` ties an entity to one exact `report.json`, so a scanner can
  be audited: re-run the scan, compare findings.

## Expiry: 30 days, configurable (`--expiry-days`, max ~182)

Expiry is mandatory on Arkiv (counted in 2-second blocks, max 7,884,000
blocks ≈ 182.5 days). We default to **30 days** on purpose: scans go stale as
dapps ship, and a stale privacy claim is actively harmful — a dapp that fixed
its leaks keeps being defamed, or a dapp that added a tracker keeps a good
score. A scanner that still stands behind a result can re-scan (fresh
evidence) or `extendEntity`. Expired entities disappear from queries, which
is exactly the behaviour a trust registry wants for unrefreshed claims.

## Queried fields in practice

- Viewer list: `select('*').from(ScanSchema).where(and(gte('score', …),
  eq('usesAnonRpc', …), eq('hostname', …))).orderBy(desc('scannedAt')).limit(…)`
  plus `ownedBy(scanner)` when a scanner filter is set.
- Snapshot (offline viewer + extension): full key-cursor walk
  (`$key > key(last) ORDER BY $key ASC`, pages of 100).
