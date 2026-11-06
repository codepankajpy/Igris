# Open scan requests and independent scanner nodes (design)

Status: approved direction (owner, 2026-11-07: "Options 1 + 2"); schemas
pinned after review. Shared types: `packages/registry/src/site-registry.ts`.

## Why

Today one backend scans and publishes. A reader must trust that one
operator. With open requests on Arkiv, **anyone can ask for a scan, any
scanner node can fulfil it, and readers compare independent results** —
there is no single server to trust or to censor a site.

Honest limits: live pages vary between runs (A/B tests, geography, timing),
so whole-scan hashes rarely match; agreement is shown **per recipient**.
Two nodes run by one person are not independent — the README names who runs
each node.

## Arkiv: `igris.request.v1`

| attribute     | type                                   | indexed |
| ------------- | -------------------------------------- | ------- |
| `hostname`    | str                                    | yes     |
| `url`         | str (≤ 128 B; longer URLs are refused) | no      |
| `requestedAt` | u64 (unix s)                           | yes     |

Created with `permissionlessExtension` (anyone may keep it alive) and a
**7-day** expiry (scans keep 180 days). Any creator may create one.

- **readonly is ours, not a rule.** IGRIS nodes create requests readonly
  as well (the SDK combines both flags; readonly still allows extension),
  so their URL can never change. Readers accept requests **with or without**
  readonly: a third party following this spec may create a mutable one.
  That is safe because a scan stores only the request's key, and every node
  re-validates the URL it reads (SSRF guard, public-only egress) right
  before scanning; what was actually scanned is in each published report.
  An edited request can only make two nodes' scans of one round differ,
  which the agreement table shows.
- **Clock skew.** `requestedAt` is self-declared. A request dated more than
  **300 s** after the reader's clock is ignored (by `openRequests` and
  `request`); the Arkiv query also bounds it
  (`requestedAt >= since AND requestedAt <= now + 300`).
- **Per-creator cap.** `openRequests` reads newest first and takes at most
  **20** requests per `$creator` (the newest), skipping the rest and
  reading on (up to 5,000 rows), so one creator's flood cannot hide other
  creators' requests. The worker's own per-creator rate limit applies on top.

`igris.scan.v2` gains `request` (str, indexed; "" when none). Entities
published earlier have no `request` attribute → read as null.

## Scanner node (apps/api)

- **Request on the website**: `POST /api/sites/:hostname/scans` creates an
  `igris.request.v1` (signed by this node) and immediately starts this
  node's local job for it. The response carries both.
- **Worker** (`IGRIS_WORKER=1`, default on in Arkiv mode): every
  `IGRIS_WORKER_POLL_MS` (default 15 s) it reads `openRequests({ since: now −
IGRIS_REQUEST_WINDOW_S (default 3600) })`, skips requests it already
  fulfilled (`fulfilments(key)` has a scan whose owner is this node) or is
  running, validates hostname/URL exactly like the POST route (SSRF guard,
  public-only egress) and fulfils the rest through the same job queue,
  publishing with `{ request: key }`. Limits: ≤ `IGRIS_REQUESTS_PER_CREATOR`
  (default 5) per creator per hour; queue caps apply; requests whose
  creator is in `IGRIS_BLOCKED_REQUESTERS` are ignored. Every decision is
  logged without addresses.
- Version numbering is unchanged: one version sequence per site across all
  trusted creators; two nodes fulfilling one request publish two versions.

## Rounds and agreement

A **round** = one request and the trusted scans that fulfilled it (scans
with no request are rounds of one). For a round with ≥ 2 scans the API
loads (and verifies) each report and compares recipients by
`(registrableDomain, class)`:

- `agree` — every node saw it, same verdict and the same "received the
  address" (exact/hashed vs not);
- `differ` — every node saw it, verdict or address differs;
- `partial` — some nodes did not see it.

Nodes are shown as **"Scanner 1", "Scanner 2"…** (order of
`IGRIS_TRUSTED_SCANNERS`; this node first). Addresses are not shown; each
scan links to its Arkiv entity and transaction, where the signer is public
by design.

## API (exact)

```
POST /api/sites/:hostname/scans { url? } → 202 { id, request: ScanRequest | null }
GET  /api/sites/:hostname → { hostname, versions: PublishedScan[], scanning, rounds: RoundSummary[] }
     RoundSummary = { request: ScanRequest | null, scans: Array<{ version: number; key: string; node: string }> }
GET  /api/sites/:hostname/rounds/:requestKey → { request: ScanRequest | null, scans: Array<{ scan: PublishedScan; node: string; verified: boolean }>,
                                                agreement: Agreement | null }
     request null: the request entity expired (or is another site's) but trusted scans of this site reference the key;
     404 only when no trusted scan of the site references it and no live request of the site has it
     Agreement = { nodes: string[], rows: Array<{ registrableDomain: string; class: string;
                   byNode: Record<string, { verdict: Verdict; address: 'exact'|'hashed'|'possible'|'none' } | null>;
                   status: 'agree' | 'differ' | 'partial' }>, summary: { agree: number; differ: number; partial: number } }
GET  /api/nodes → { nodes: Array<{ label: string; self: boolean }> }
GET  /api/wallet-requests?kind=&unlimited=&hostname=&limit= → { requests: WalletRequestEntity[] }
GET  /api/sites/:hostname/versions/:n → (unchanged) + node: string
```

## Website

- Site page: version rail grouped by round ("Request · 2 scanners"), a
  "Scanned by" chip per version, and an **Agreement** panel for rounds with
  ≥ 2 scans (per-recipient table: agree / differ / only Scanner N).
- Live scan page: shows the request entity (explorer link) and that other
  nodes may pick it up.
- Report: "What the site asked your wallet to do" (WALLET-REQUESTS.md).

## Second node for the demo

A second process with its own `IGRIS_HOME` (own key, own node id),
`IGRIS_DATA_DIR`, port and `IGRIS_TRUSTED_SCANNERS` = both addresses;
funded by the owner at the faucet. On one machine it demonstrates the
protocol, not independence; a node on another machine (Railway / Render
config exists) demonstrates both.
