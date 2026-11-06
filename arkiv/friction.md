# Arkiv friction log

Kept as we worked (newest last). Each entry: what we expected, what happened,
how to reproduce.

## 1. Terminology drift between ecosystem material and current docs

- **Expected** (from older Golem-Base/Arkiv material and our own brief):
  entities with a "payload", "annotations" and a "BTL" lifetime.
- **Happened**: the current docs and SDK v1.x use typed attribute _columns_,
  a named-schema tag (`arkiv.schema`), and `expiration` built from
  `ExpirationTime` in **blocks**. No "payload"/"annotations"/"BTL" anywhere.
- **Repro**: compare any pre-2026 Arkiv/GolemDB tutorial with
  https://docs.arkiv.network/start-here/first-entity/.
- **Cost**: we designed our entity around the old model first; redesigned to
  columns + a `bytes` summary column. Not painful, but the ghost terminology
  is everywhere in third-party material.

## 2. No substring/CONTAINS operator → leak-class filter is client-side

- **Expected**: filter entities where `leakClasses` contains `analytics`.
- **Happened**: the query language has `=`, ranges, `BETWEEN`, `STARTSWITH`
  (str prefix only), `EXISTS`, `TYPEOF` — no substring or set-membership
  operator, and no array-typed column. Our `leakClasses` is a comma-joined
  str, so `igris query --class analytics` fetches server-side-filtered rows
  and then filters classes **client-side** (`matchesQuery` in
  packages/registry/src/record.ts).
- **Repro**: https://docs.arkiv.network/reference/query-language/ — comparison
  list.
- **Workaround considered**: one bool column per class (classes are a closed
  set) would make it indexable; costs 8 indexed columns. Reasonable for v2.

## 3. `$createdAt` cannot be sorted on → store your own timestamp

- **Expected**: "latest scans" via `ORDER BY $createdAt DESC`.
- **Happened**: `$createdAt`/`$updatedAt` are selectable but not sortable
  (documented). We store `scannedAt` (u64 unix seconds, indexed) and sort on
  that.
- **Repro**: query-language reference, sorting section.

## 4. Strictly typed comparisons are easy to get silently wrong

- **Expected**: `eq('score', 50)` to match i32 scores.
- **Happened**: it does — but only because bare numbers are i32. A bare
  bigint is u256 (not u64!), and `gte('scannedAt', 1793900000)` would be an
  i32/u64 type mismatch that matches **nothing, silently**. We wrap every
  non-trivial value (`u64(BigInt(...))`, `i32(...)`, `bool(...)`).
- **Repro**: publish an entity, query a u64 column with a bare number.

## 5. Public RPC warns loudly without an access key

- **Expected**: light anonymous reads for a hackathon demo.
- **Happened**: works (CORS `*`, verified live on 2026-11-06 from Node), but
  every client construction logs a rate-limit warning, and the docs say the
  public endpoint is heavily rate limited. Access keys are per-wallet via the
  Hub; in a browser the key rides in the RPC URL, so it is visible to users —
  Origins allowlisting is attribution, not access control.
- **Repro**: `rabdi({ accessKey: '' })` → console warning; then any query.
- **Consequence for us**: the viewer ships with the public endpoint as the
  default and makes the endpoint user-configurable; heavy users bring a key.

## 6. Faucet + access keys are browser-flow only

- **Expected**: scriptable faucet for CI ("fund this address").
- **Happened**: https://hub.arkiv.network/faucet is an interactive app; there
  is no documented API. Our real-publish path therefore needs one manual
  human step (see STATUS.md → TODO(human)); everything else is automated.

## 7. Reads reveal the reader's IP

Not a bug — inherent to any hosted RPC — but worth logging: a privacy
registry whose _viewer_ leaks every reader's interest to one endpoint would
be ironic. Mitigations we shipped: user-configurable endpoint, offline
snapshot mode (`igris snapshot` → `snapshot.json`), and the extension stub
matches locally against a snapshot instead of querying per visited site.

## 8. One malformed entity fails a whole query page in the SDK

- **Expected**: `select().from(Schema).fetch()` with `onMismatch: "skip"` to
  skip hostile rows.
- **Happened**: `skip` only covers schema mismatches. Before that,
  `runQuery` decodes every entity of the page (`entityFromRpcResult` →
  `decodeRpcValue`), and a value it cannot decode throws for the **whole
  page**. On a permissionless store where anyone can write an entity with
  our schema tag, that is a denial-of-service lever for one reader.
- **Workaround**: the registry builds query strings with the SDK expression
  builders but sends raw `arkiv_query` requests and decodes each entity
  itself, skipping invalid ones (packages/registry/src/rows.ts).
- **Repro**: `@arkiv-network/sdk` 1.0.1, `src/query/engine.ts` (`result.data.map(entityFromRpcResult)`).

## 9. `str` attributes are limited to 128 bytes

- **Expected**: a hostname attribute can hold any DNS name (≤ 253 chars).
- **Happened**: `MAX_STRING_BYTES = 128`. We refuse to publish a site (or a
  recipient domain) longer than 128 bytes instead of truncating it, which
  would change the data.
- **Repro**: `str('a'.repeat(129))` throws `InvalidValueError`.

## 10. The node returns a `cursor` the SDK does not use

- **Observed** (live, 2026-11-06): `arkiv_query` responses carry
  `"cursor": "b64:…"` next to `data`, while the SDK pages with `offset`
  (`MAX_LIMIT` 100). We page with `offset` like the SDK; it is not clear
  from the docs whether offsets stay stable while entities are written.

## 11. Ownership-filtering several owners needs a hand-built OR

- **Expected**: `ownedBy([a, b])`.
- **Happened**: `ownedBy` takes one address. Several trusted scanners need
  `or(eq('$creator', addr(a)), eq('$creator', addr(b)))` in `where` (we filter on `$creator`; see #13). Works
  (verified live), just undocumented.

## 12. Batch gas for large payloads is unverified

- A version can carry two bytes values of up to 128 KiB each (report and
  evidence) plus N flow entities in one transaction, and one transaction is
  capped at 2^24 gas (`MAX_TRANSACTION_GAS`). We have not measured a
  maximal batch on Rabdi; the first live publishes should log gas used.
- Since wallet requests (≤ 64 `igris.walletreq.v1` per version) joined the
  batch, `estimateBatchGas` (packages/registry/src/gas.ts) computes the
  exact calldata offline and refuses a batch whose calldata alone exceeds
  the cap. The engine's execution cost is not documented, so the estimate
  assumes it by EVM analogy (schema.md → "Batch size"): a version with
  20 wallet requests and 40 flows ≈ 5.35 M gas; both payloads at the
  limit ≈ 12.8 M.

## 13. `$owner` is not an identity: transfers need no consent

- **Expected**: filtering on `$owner` identifies who published an entity.
- **Happened**: `changeOwnership({ entityKey, newOwner })` takes effect
  without the new owner's consent. Anyone can create an `igris.scan.v2`
  for any site and transfer it to a trusted scanner's address; a reader
  that filters on `$owner` then shows the forgery as trusted. Found in a
  review of our own reader (2026-11-07).
- **Fix**: trust `$creator` (immutable): server-side filter
  `$creator = addr(…)`, select `creator` and re-check it client-side.
  Verified live on Rabdi. Every IGRIS entity is also created `readonly`
  so published history cannot be patched later.
