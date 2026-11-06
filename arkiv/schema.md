# Arkiv schema (registry v2)

Code: [packages/registry/src/schemas.ts](../packages/registry/src/schemas.ts).
Design: [docs/design/FLOW.md](../docs/design/FLOW.md),
[docs/design/SCAN-NETWORK.md](../docs/design/SCAN-NETWORK.md),
[docs/design/WALLET-REQUESTS.md](../docs/design/WALLET-REQUESTS.md).

Every completed scan is published as **one atomic `executeBatch`** signed by
the backend's scanner key:

```
1 × igris.scan.v2       the version (attributes + the full report)
1 × igris.evidence.v1   the canonical evidence bundle
N × igris.flow.v1       one per recipient with a hostname (the cross-site view)
M × igris.walletreq.v1  one per wallet request except "connect" (≤ 64)
```

Either all of them land or none do. Separately, anyone may create an
**`igris.request.v1`** (an open scan request) that any scanner node may
fulfil — see "Open scan requests" below. Schema names are versioned: a breaking
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
| `request`                                               | str   | yes     | key of the `igris.request.v1` it fulfilled; `""` when none |
| `report`                                                | bytes | no      | gzip(canonical Report 3.0.0)                               |

`request` was added after the first versions were published: an entity
without the attribute decodes as `request: null` (not made for a request).
It holds the lower-case entity key; `publish(report, bundle, { request })`
writes it only after checking that the request is live, valid and for the
same hostname.

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
| `bundleVersion` | str   | no      | e.g. `igris.evidence.v4`        |
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

## `igris.walletreq.v1` — one per wallet request of a version

What the page asked the canary wallet to do, decoded
([WALLET-REQUESTS.md](../docs/design/WALLET-REQUESTS.md)), from the
report's `walletRequests`. `connect` (eth_requestAccounts /
wallet_requestPermissions) gets no entity. Written in the **same batch** as
the scan.

| attribute                                                      | type | indexed | value                                                   |
| -------------------------------------------------------------- | ---- | ------- | ------------------------------------------------------- |
| `hostname`                                                     | str  | yes     | the scanned site                                        |
| `kind`                                                         | str  | yes     | permit2, permit, approve, siwe, eth-sign, blind-hash, … |
| `method`                                                       | str  | yes     | the provider method (`eth_signTypedData_v4`, …)         |
| `outcome`                                                      | str  | yes     | answered / signed / rejected / error                    |
| `unlimited`, `chainIdMismatch`, `domainMismatch`, `preConnect` | i32  | yes     | booleans as `0` / `1`, so they can be filtered          |
| `verifyingContract`, `spender`                                 | str  | yes     | checksummed address, `""` when none                     |
| `version`                                                      | i32  | yes     | the site version it belongs to                          |
| `scanId`                                                       | str  | yes     | that version's `scanId`                                 |
| `scannedAt`                                                    | u64  | yes     | unix seconds                                            |

A report built before wallet requests were recorded (`walletRequests`
absent or `null`) publishes none. Every entry is re-checked before
publishing (kind, method, outcome, booleans, addresses); a malformed entry,
or an address equal to the canary, refuses the publish. `version` is
indexed (the design note lists it without the flag) so `walletRequests()`
and the idempotent republish can find one version's rows.

**Cap: 64 per version.** A page can fire any number of wallet requests; an
unbounded index would let a site make its own scan too large for one
transaction. Above 64, requests with any risk flag (`unlimited`,
`chainIdMismatch`, `domainMismatch`, `preConnect`) are indexed first, then
the rest, in request order; the full report still lists every request.

`walletRequests({ kind?, unlimited?, hostname?, limit? })` returns only rows
of each site's **latest** trusted version, newest first (like `flowsTo`).

## `igris.request.v1` — open scan requests

| attribute     | type | indexed | value                                                           |
| ------------- | ---- | ------- | --------------------------------------------------------------- |
| `hostname`    | str  | yes     | lower-case DNS hostname                                         |
| `url`         | str  | no      | canonical http(s) URL on `hostname`, ≤ 128 bytes (else refused) |
| `requestedAt` | u64  | yes     | unix seconds                                                    |

`createRequest(hostname, url)` refuses a hostname that is not a lower-case
DNS name and a URL that is not http(s), not on that hostname, carries
credentials, or is longer than 128 bytes (never truncated). It stores the
canonical form (`new URL(url).href`).

**Flags: `readonly` + `permissionlessExtension`.** Checked in the SDK
(1.0.1): the creation flags are two independent bits of one byte
(`readonly` = 1, `permissionlessExtension` = 2; `encodeCreationFlags` ORs
them; any other bit is `ReservedCreationFlags`), and the engine's
`ReadOnlyEntity` rule only forbids changing attributes — a readonly entity
"can still be extended, transferred or deleted". So readonly does **not**
block extension, and IGRIS creates its requests with both: anyone may keep
one alive, nobody (not even its creator) can switch its URL after a node
fulfilled it. Readonly is **not required of other creators**: readers accept
requests with or without it, so a third party following the spec may
create a mutable one. That is safe because a scan stores only the request's
key and every node re-validates the URL it reads (SSRF guard, public-only
egress) right before it scans; what was scanned is in each published
report. An edited request can only make two nodes' scans of one round
differ, which the agreement table shows.

**Any creator.** `request(key)` and `openRequests({ since, limit })` do not
filter on `$creator`: anyone may ask for a scan. Every field is therefore
untrusted input, and each row is validated strictly (schema tag, hostname,
the URL rules above, `requestedAt`); a hostile row is skipped. A
`requestedAt` more than **300 s** after the reader's clock is rejected (a
request dated ahead would otherwise sort above every honest one), and the
query bounds it too: `requestedAt >= u64(since) AND requestedAt <= u64(now + 300)`.
`openRequests` reads newest first and takes at most **20 requests per
`$creator`** (its newest), skipping the rest of that creator's rows and
reading on — up to 5,000 rows — so one creator's flood can neither use up
the limit nor hide other creators' requests. It returns at most `limit`
(default 100), oldest first.
The scanner node still applies its own SSRF guard, rate limits and block
list before it scans anything.

### The open-request protocol

1. **Ask.** Anyone creates an `igris.request.v1` (permissionlessExtension,
   7-day expiry; IGRIS's own are also readonly). On the website,
   `POST /api/sites/:hostname/scans` does it with the node's key.
2. **Discover.** Every scanner node polls `requestedAt >= u64(now − window)
AND requestedAt <= u64(now + 300)`
   (no creator filter), validates each row strictly, applies its own
   egress / SSRF checks, per-creator limits and block list, and skips
   requests it already fulfilled (`fulfilments(key)` has a scan by itself).
3. **Fulfil.** The node scans and publishes the usual atomic batch with the
   scan's `request` = the request key. Two nodes fulfilling one request
   publish two versions (one version sequence per site).
4. **Compare.** Readers group trusted scans by `request` (`fulfilments(key)`:
   `$creator` ∈ trusted scanners, newest first) into rounds and compare
   recipients per node.
5. **Keep alive (optional).** Anyone may extend a request's expiry; nobody
   can change it.

## Lifetime and flags per entity type

| entity               | expiry                         | flags                              | creator          |
| -------------------- | ------------------------------ | ---------------------------------- | ---------------- |
| `igris.scan.v2`      | 180 days (`ARKIV_EXPIRY_DAYS`) | readonly                           | the scanner node |
| `igris.evidence.v1`  | same as its scan               | readonly                           | the scanner node |
| `igris.flow.v1`      | same as its scan               | readonly                           | the scanner node |
| `igris.walletreq.v1` | same as its scan               | readonly                           | the scanner node |
| `igris.request.v1`   | **7 days**                     | readonly + permissionlessExtension | anyone           |

Scans default to **180** days — close to Arkiv's maximum (7,884,000 blocks
≈ 182.5 days), so history persists as long as the chain allows; valid range
1–182. Requests are short-lived: a request is a call to act now, and anyone
who still cares can extend it. The local backend emulates the 7-day request
lifetime from `requestedAt`.

## Batch size (gas)

One transaction is capped at 2^24 = 16,777,216 gas (EIP-7825). Method
(`estimateBatchGas` in
[packages/registry/src/gas.ts](../packages/registry/src/gas.ts)):

- **Calldata, exactly**: the batch is ABI-encoded the way the SDK encodes
  it (`execute((uint8,bytes)[])`, each create = salt, expiresAt,
  minLifetime, creationFlags and `(bytes32 name, uint8 typeId, bytes
value)[]` attributes including the schema tag; worst-case salt), and zero
  and non-zero bytes are counted.
- **Lower bound** = 21,000 + 4 per zero + 16 per non-zero byte (EIP-2028):
  nothing can charge less. `publish` refuses a batch above the cap by this
  bound alone, before signing.
- **Estimate** = 21,000 + max(EIP-2028 calldata + execution, EIP-7623 floor
  of 10 per zero + 40 per non-zero byte). The Arkiv engine's execution cost
  is **not documented or measured**; it is assumed by EVM analogy (25,000
  per create, 2,100 per attribute, 8 per encoded byte).

Results (unit test in `network.test.ts`): a version with **20 wallet
requests + 40 flows** and the sample report — 62 creates, 703 attributes,
164,900 calldata bytes — estimates **≈ 5.35 M gas (32 % of the cap)**; its
calldata floor alone is ≈ 2.48 M. The same index with **both payloads at
the 128 KiB limit** (incompressible) estimates ≈ 12.8 M (76 %), dominated
by the calldata floor. Live publishes should log `gasUsed` to replace the
execution assumption (friction.md #12).

## Trust and verification on read

Every IGRIS entity is created with the `readonly` flag: once published, no
attribute can be patched — not even by the publisher. IGRIS's requests are
also readonly (plus `permissionlessExtension`); readers accept other
creators' requests without the flag (see `igris.request.v1` above).

Anyone can write entities tagged with these names. An entity is an
**attestation by its creator**, not a fact. Scans, evidence, flows and
wallet requests are read only from trusted creators; requests are read from
any creator (anyone may ask) and validated strictly instead. Reads filter on `$creator`
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

Versions published before wallet-request auditing carry a **draft 3.0.0**
report (no `walletRequests`, an `igris.evidence.v3` bundle). Their hashes
are checked against the bytes exactly as published; only then is the pair
upgraded for display (`walletRequests` null = not recorded, bundle
re-labelled v4, items unchanged) and schema + integrity run on the upgraded
pair. Such a version loads `verified: true` with the note "published before
wallet-request auditing (shown as not recorded)". A draft whose bytes do
not match its entity is never upgraded.

## Queries for organisers

### Every site sending data to one recipient

IGRIS's scanners: `0x36DfF990206FfF8e8BA91f38A0b111418C985Bbe` (Scanner 1) and
`0xc11870c95Ffc869872e4CBB9d9F6FBC71aF7b869` (Scanner 2); both run by the IGRIS author.
No access key needed (the public endpoint is rate limited; an access key from
hub.arkiv.network, appended to the URL as a path segment, raises the budget).

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

### Open scan requests (and who asked)

Requests from **any** creator since a unix time (here 2026-11-07T00:00Z =
`1794009600`; the upper bound is the reader's clock + 300 s, here a reader at 01:00Z). `creator`
and `creationFlags` are selected so you can see who asked and whether the
request is readonly (IGRIS's are; others need not be). Add
`AND $creator = addr(0x…)` to see one node's requests only.

```sh
curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' --data @- <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":[
  "arkiv.schema = str('igris.request.v1') AND requestedAt >= u64(1794009600) AND requestedAt <= u64(1794013500) ORDER BY requestedAt:u64 DESC",
  {"select":{"key":true,"creator":true,"creationFlags":true,"expiresAt":true,"attributes":true},"limit":"0x64"}]}
EOF
```

Which trusted scanners fulfilled one of them (replace `<request key>`;
select `creator` to see who signed each scan). Combine creators with the
keyword `OR` — the symbol forms `||` / `&&` are rejected by the node:

```
arkiv.schema = str('igris.scan.v2') AND request = str('<request key>') AND ($creator = addr(0x36dff990206fff8e8ba91f38a0b111418c985bbe) OR $creator = addr(0xc11870c95ffc869872e4cbb9d9f6fbc71af7b869)) ORDER BY version:i32 DESC
```

Live example: request
`0x2d8a19473bb961d8135929bbe1115d399ab611ed3d56dd466619aac6124b17d4`
(app.ens.domains) returns v3 by Scanner 1 and v4 by Scanner 2.

### Unlimited Permit2 requests across every scanned site

```sh
curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' --data @- <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":[
  "arkiv.schema = str('igris.walletreq.v1') AND kind = str('permit2') AND unlimited = i32(1) AND $creator = addr(0x36DfF990206FfF8e8BA91f38A0b111418C985Bbe) ORDER BY scannedAt:u64 DESC",
  {"select":{"key":true,"creator":true,"attributes":true},"limit":"0x64"}]}
EOF
```

Each row names the site (`hostname`), the `spender`, the
`verifyingContract` and the site `version`. Drop `kind = …` for every
unlimited approval (permit, approve, setApprovalForAll too). The raw query
returns rows of every version; the IGRIS API (`GET /api/wallet-requests`)
keeps only each site's latest version. Always filter on `$creator`, never
`$owner` (see "Trust and verification on read").
