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
