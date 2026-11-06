# Report 3.0.0 — no score; verdicts and a timeline (design)

Status: **proposed** (implemented on `mvp-web-app`; frozen and hash-pinned
only after the project owner approves this document). Owner decisions this
implements (2026-11-06): "don't score websites — list what we find, what is
legit and what is safe, show it with timelines and graphs", and "remove the
score from reports too".

## What changes from 2.2.0

| 2.2.0                              | 3.0.0                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `privacy.score` (0–100 or null)    | **removed**                                                              |
| `privacy.ledger` (penalty lines)   | **removed**                                                              |
| `finding.countsTowardPrivacyScore` | **removed** (findings otherwise identical; same ids and fingerprints)    |
| `privacy.coverage`                 | unchanged (`full` / `pre-connect-only` / `none`)                         |
| —                                  | **`recipients[]`**: one per (registrable domain, class), with a verdict  |
| —                                  | **`timeline`**: milestones + per-recipient first contact / first address |
| evidence `igris.evidence.v3`       | unchanged (3.0.0 ↔ v3)                                                   |
| `findingSet`                       | unchanged definition → comparable with 2.x reports of the same behaviour |

Everything else (scan meta incl. `connection` / `failure`, detectors,
security observations, contacts, wallet, telemetry, evidence summary,
`migratedFrom`) is unchanged. A test asserts the exact schema difference.

## `recipients[]`

```
{
  registrableDomain: string,
  class: RecipientClass,                  // 2.2.0 class list (incl. wallet-sdk); never first-party
  hosts: string[],                        // sorted, distinct
  learned: {
    address: 'exact' | 'hashed' | 'possible' | 'none',
    addressPhases: Phase[],               // when the address was observed (sorted)
    ip: Phase[]                           // phases with HTTP(S) contact (sorted); [] = WebSocket only
  },
  verdict: 'expected' | 'avoidable' | 'tracking' | 'unidentified',
  rule: string,                           // e.g. "verdict.rpc-with-address@1"
  reason: string,                         // one plain sentence, from the rule
  findingIds: string[]                    // canary-leak / ip-exposure findings about it (sorted)
}
```

Sorted by verdict (unidentified, tracking, avoidable, expected), then
domain, then class. Recipients come from HTTP(S) contacts and from address
receipts over any transport; a WebSocket-only host that received no address
is not listed (the frozen `contacts` record HTTP(S) only). Anon-RPC hosts are
listed with `address: none`: what Anon-RPC relays is an observation, not an
exposure. No size caps (recipients mirror contacts, which are unbounded);
`verifyReportIntegrity` recomputes recipients and verdicts and rejects any
mismatch. `address`: `exact` if any canary-leak issue with an
exact/encoded (non-hashed, non-partial) form; else `hashed`; else
`possible` (only an unscored truncated display form); else `none`.

### Verdict rules (deterministic, `packages/core/src/verdicts.ts`)

| class               | address received (exact/hashed)                                                     | no address (possible counts as none) |
| ------------------- | ----------------------------------------------------------------------------------- | ------------------------------------ |
| unknown-third-party | unidentified                                                                        | unidentified                         |
| analytics           | tracking                                                                            | tracking                             |
| error-monitoring    | tracking                                                                            | avoidable                            |
| support-chat        | tracking                                                                            | avoidable                            |
| rpc-provider        | avoidable (Anon-RPC exists)                                                         | expected                             |
| cdn, ipfs-gateway   | avoidable (not needed to serve)                                                     | expected                             |
| walletconnect-relay | expected                                                                            | expected                             |
| wallet-sdk          | expected (the login the dApp chose; it keeps its own record — stated in the reason) | expected                             |
| anon-rpc            | expected                                                                            | expected                             |

Meaning, in the product's words: **expected** — needed for the app to work
as built; **avoidable** — the app works without this exposure; **tracking**
— not needed, profiles visitors; **unidentified** — nobody can say what it
does with what it receives.

## `timeline` (volatile telemetry, like `telemetry`; `null` when not recorded)

```
{
  origin: 'navigation-start',             // t = 0 when page.goto starts
  milestones: Array<{ event: 'page-loaded' | 'connect-started' | 'accounts-requested'
                     | 'connect-finished' | 'observation-ended', t: number }>,
  recipients: Array<{ registrableDomain, class, firstContactMs: number | null,
                      firstAddressMs: number | null }>,  // same keys as recipients[]
  requestsPerSecond: Array<{ t: number, firstParty: number, thirdParty: number }>  // 1 s buckets, ≤ 600
}
```

All `t` values are integer milliseconds ≥ 0. Times come from the scanner's
capture (`CapturedRequest.t`, `CapturedWsFrame.t`, `Capture.milestones`);
the evidence bundle never contains times.

## Consumers

- Scanner/CLI: `--fail-under <score>` is replaced by
  `--fail-on <tracking|avoidable|unidentified>` (exit 1 when any recipient
  has that verdict or worse; order unidentified > tracking > avoidable).
- `assess()` becomes `summarise()`: a descriptive state (`not-observed`,
  `address-to-trackers`, `address-to-services`, `no-address-observed`), a
  headline and points — no level, no grade.
- Migration `migrateReportV2toV3(report, bundle)`: drops score / ledger /
  countsTowardPrivacyScore, computes `recipients` from contacts + findings +
  evidence, `timeline: null`, sets `migratedFrom`.

## Arkiv (registry schema v2, separate document: arkiv/schema.md)

Published per scan: one `igris.scan.v2` entity (no score), one
`igris.flow.v1` entity per recipient (the cross-dApp tracker map), and one
`igris.evidence.v1` entity holding the canonical evidence bundle (anyone can
re-verify the report's hashes from Arkiv alone).
