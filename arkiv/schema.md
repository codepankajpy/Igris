# Arkiv schema (registry v2)

Code: [packages/registry/src/schemas.ts](../packages/registry/src/schemas.ts).
Design: [docs/design/FLOW.md](../docs/design/FLOW.md).

Every completed scan is published as **one atomic `executeBatch`** signed by
the backend's scanner key:

```
1 × igris.scan.v2      the version (attributes + the full report)
1 × igris.evidence.v1  the canonical evidence bundle
N × igris.flow.v1      one per recipient with a hostname (the cross-site view)
```

Either all of them land or none do. Schema names are versioned: a breaking
change gets a new name instead of corrupting old rows. `igris.scan.v1` (the
scored v1 entity) was never published and is retired.

## Payloads

`report` and `bundle` are **gzip of the RFC 8785 canonical JSON**
(`encodePayload` in payload.ts). A payload larger than **128 KiB after
compression** (Arkiv's per-entity bytes limit) is refused, never truncated.
On read, payloads are inflated with a 32 MiB output cap (decompression-bomb
guard).

## `igris.scan.v2` — one per published version

| attribute                                               | type  | indexed | value                                                      |
| ------------------------------------------------------- | ----- | ------- | ---------------------------------------------------------- |
| `hostname`                                              | str   | yes     | the site, exactly as scanned (www.x ≠ x)                   |
| `version`                                               | i32   | yes     | 1, 2, 3 … per hostname                                     |
| `previous`                                              | str   | no      | entity key of version − 1; `""` for version 1              |
| `scannedAt`                                             | u64   | yes     | unix seconds (`$createdAt` cannot be sorted on)            |
| `scanId`                                                | str   | yes     | `contentHash(report)` (64 hex)                             |
| `evidenceSha256`                                        | str   | yes     | `bundleHash(bundle)` (64 hex)                              |
| `findingSetSha256`                                      | str   | yes     | same behaviour ⇔ same digest                               |
| `state`                                                 | str   | yes     | `summarise()` state (never `not-observed`)                 |
| `coverage`                                              | str   | yes     | `full` / `pre-connect-only`                                |
| `recipients`, `addressRecipients`, `trackingRecipients` | i32   | yes     | all / address (exact or hashed) / tracking-or-unidentified |
| `usesAnonRpc`                                           | bool  | yes     |                                                            |
| `scannerVersion`, `reportVersion`                       | str   | no      | `reportVersion` is always `3.0.0`                          |
| `report`                                                | bytes | no      | gzip(canonical Report 3.0.0)                               |

**Version history.** `version` = (highest version of this hostname among
the trusted owners and the publisher) + 1, and `previous` = that entity's
key. The history is a linked list on Arkiv; `versions(hostname)` reads it
newest first, and `byKey(previous)` follows one link exactly.

**Idempotent, never backwards.** A version is identified by its `scanId`.
Publishing a report whose `scanId` already exists for that hostname (among
the trusted owners and the publisher) writes nothing and returns the
existing version (`txHash` null, its evidence and flow keys looked up);
`findByScanId(hostname, scanId)` answers the same question before a publish.
A report whose `scannedAt` is strictly older than the latest version's is
refused: history never runs backwards.

The full report is published so any IGRIS instance can render any site from
Arkiv alone. It is canary-safe: the evidence is redacted by construction
(`assertCanaryFree` runs again before publishing), and the report's
`canaryAddress` is the scan's throwaway, never-funded address. There is no
score anywhere.

## `igris.evidence.v1` — one per version

| attribute       | type  | indexed | value                           |
| --------------- | ----- | ------- | ------------------------------- |
| `sha256`        | str   | yes     | `bundleHash(bundle)`            |
| `scanId`        | str   | yes     | the version's `scanId`          |
| `bundleVersion` | str   | no      | `igris.evidence.v3`             |
| `bundle`        | bytes | no      | gzip(canonical evidence bundle) |

Published so anyone can re-verify a report's hashes and every finding's
evidence from Arkiv alone.

## `igris.flow.v1` — one per recipient of a version

| attribute    | type | indexed | value                                               |
| ------------ | ---- | ------- | --------------------------------------------------- |
| `hostname`   | str  | yes     | the scanned site                                    |
| `recipient`  | str  | yes     | the recipient's registrable domain                  |
| `class`      | str  | yes     | recipient class (analytics, rpc-provider, …)        |
| `verdict`    | str  | yes     | expected / avoidable / tracking / unidentified      |
| `address`    | str  | yes     | exact / hashed / possible / none                    |
| `preConnect` | bool | yes     | it received a request or the address before connect |
| `version`    | i32  | yes     | the site version this flow belongs to               |
| `scanId`     | str  | yes     | that version's `scanId`                             |
| `scannedAt`  | u64  | yes     | unix seconds                                        |

Powers "this tracker also receives data from N other scanned sites".
`flowsTo(recipient)` keeps a site only when the flow belongs to the site's
**latest** version (a site that stopped sending to it drops out); it filters
first and trims to the limit after, and resolves the latest versions with one
scan query per 25 hostnames (an OR group), stopping once the first `limit`
results are settled.

**Recipients without a hostname get no flow.** `recipient` is an indexed str
that must be a lower-case DNS hostname (≤ 128 bytes). A recipient whose
registrable domain is an IP literal (e.g. `[2606:4700::1111]`) or otherwise
not a hostname does **not** block the publish: the scan and evidence are
published, the full report (and the scan's `recipients` count) still list
it, and only its `igris.flow.v1` entity is omitted — so it never appears in
the cross-site view.

## Lifetime

`ExpirationTime.fromDays(ARKIV_EXPIRY_DAYS)`, default **180** days — close
to Arkiv's maximum (7,884,000 blocks ≈ 182.5 days), so history persists as
long as the chain allows. Valid range 1–182.

## Trust and verification on read

Every IGRIS entity is created with the `readonly` flag: once published, no
attribute can be patched — not even by the publisher.

Anyone can write entities tagged with these names. An entity is an
**attestation by its creator**, not a fact. Reads filter on `$creator`
(immutable — never `$owner`, which anyone can set to any address by
transferring an entity they created) against `trustedOwners` (default: the
publisher) **server-side and again client-side**, and every row is decoded strictly (types, hostname / sha /
key formats, string sizes, `previous` consistent with `version`). A row that
fails is skipped, never thrown.

`load()` then checks: gunzip; `contentHash(report) === scanId`;
`bundleHash(bundle) === evidenceSha256 === report.evidence.sha256`; schema
validity; `verifyReportIntegrity` (recomputes recipients and verdicts); and
that the indexed attributes match the report. Any mismatch → `verified:
false` with the problems listed, and the UI says so.

## Query for organisers: every site sending data to one recipient

Replace `0x36DfF990206FfF8e8BA91f38A0b111418C985Bbe` with the IGRIS scanner address (filled in after
the first live publish). No access key needed (the public endpoint is rate
limited).

```sh
curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' --data @- <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":[
  "arkiv.schema = str('igris.flow.v1') AND recipient = str('segment.io') AND $creator = addr(0x36DfF990206FfF8e8BA91f38A0b111418C985Bbe) ORDER BY scannedAt:u64 DESC",
  {"select":{"key":true,"owner":true,"expiresAt":true,"attributes":true},"limit":"0x64"}]}
EOF
```

Each result's `attributes` holds `hostname`, `verdict`, `address`,
`version`, …; `u64` values come back as `0x` hex.
