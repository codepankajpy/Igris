# Scoring

**This is a heuristic, not an audit.** The score compresses one scan's
observable evidence into a number developers can track in CI. It cannot see
server-side forwarding, encrypted or obfuscated exfiltration, or anything
behind a login — see [METHODOLOGY.md](./METHODOLOGY.md) for false-negative
risks. Treat 100 as "nothing detectable", never "nothing wrong".

**No score at all** when nothing was measured (page never loaded): `score`
is `null` and the report cannot be published. A scan whose wallet never
connected is scored but marked `coverage: pre-connect-only` — see
[METHODOLOGY.md](./METHODOLOGY.md#when-a-scan-is-not-scored).

Since Report v2 the score is computed only from **privacy findings**, by
rules registered per detector that read the findings' evidence
(`packages/core/src/scoring-v2.ts`). Security observations are a separate
type and never reach the scorer. The arithmetic below is unchanged from v1;
the migration tests and the live demo (leaky 0, fixed 17) confirm identical
scores.

Every number lives in one file:
[packages/core/src/weights.ts](../packages/core/src/weights.ts). The engine
([scoring.ts](../packages/core/src/scoring.ts)) starts at 100, subtracts the
itemized penalties below, floors at 0, and emits a ledger where each line
names its rule and the finding IDs that caused it. `igris scan --explain`
prints the ledger; the HTML report and the registry entity embed it.

## Leak penalties (address reached a third party)

Charged **once per (registrable domain, class) pair** — a tracker that
receives the address fifty times is one leak, not fifty, so one chatty SDK
cannot dominate the score (dedup rule, tested in scoring.test.ts).

| Recipient class     | Points | Rationale                                                                                                       |
| ------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| rpc-provider        | 15     | learns (address, IP) but needs the address to serve reads — bad, expected, and exactly what `igris fix` removes |
| walletconnect-relay | 15     | infrastructure that inherently sees addresses                                                                   |
| ipfs-gateway        | 20     | no business seeing addresses; often interchangeable                                                             |
| cdn                 | 20     | an address in a CDN URL is gratuitous                                                                           |
| analytics           | 25     | deliberate profiling of (address ↔ IP ↔ behaviour)                                                              |
| error-monitoring    | 25     | addresses in breadcrumbs end up in a third-party DB forever                                                     |
| support-chat        | 25     | same as analytics, plus PII adjacency                                                                           |
| unknown-third-party | 35     | worst case: nobody can even audit the recipient                                                                 |
| first-party         | 0      | the user chose to visit them                                                                                    |
| anon-rpc            | 0      | the privacy-preserving path we recommend                                                                        |

- **How a recipient gets its class**: first party (target, redirect
  target, `--first-party`), then `data/third-parties.json`, then **RPC by
  behaviour** — an unknown domain whose every observed request was pure
  Ethereum JSON-RPC is scored as `rpc-provider` (one non-RPC request keeps it
  `unknown-third-party`) — see METHODOLOGY.md "Recipient classification".
- **Hashed forms** (keccak256/sha256 of the address): ×0.5. Deterministic
  hashes are still linkable across datasets — reduced, not forgiven.
- **Partial display forms** (0x1234…abcd): excluded from the score (low
  confidence), still reported.
- **Cookies/localStorage** holding the address: reported ("persisted
  locally", survives reloads), not charged — no third party received it.

## IP-exposure penalties (contact without the address)

Per **distinct third-party registrable domain** contacted: 2 points before
wallet connect (every visitor leaks this), 3 points after (the visit is now
known to be a wallet user's). Each phase capped at 15 so an asset-heavy page
cannot zero the score by itself.

## Worked example (the leaky fixture)

4 leak classes (15+25+25+20) + contacts ≈ 100+ → score 0. The fixed fixture
drops the rpc-provider line entirely and gains `usesAnonRpc: true`.

## Tuning

Change weights.ts, run `pnpm --filter @igris/core test` (ordering invariants
are tested: rpc < analytics < unknown), and document the reasoning here.
