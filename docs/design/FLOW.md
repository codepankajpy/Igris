# IGRIS — the one flow (design)

Owner direction (2026-11-06): one product, one flow, no CLI.

1. A visitor opens the website and **searches for a site** (domain or URL).
2. If the site was already scanned, its **latest report** is shown, with its
   **version history** and a **Retest** button.
3. A new scan or a retest runs **every check** (wallet connect with the
   canary, address leaks in any encoding, IP exposure, RPC calls and methods,
   trackers, security headers, cookies/storage, timing) and produces a
   **detailed visual report** (Report 3.0.0: verdicts, timeline, traffic,
   RPC inventory, evidence — no score).
4. Every completed scan is **published to Arkiv automatically**. A retest
   publishes version n+1 linked to version n, so the site's history lives on
   Arkiv.

## Components

- `apps/app` — the website (Preact, hash routing, zero third-party requests).
- `apps/api` — the backend: runs scans (isolated Chromium, egress
  public-only), publishes to and reads from Arkiv, serves reports to the app.
  The app never talks to Arkiv directly.
- `packages/scanner`, `packages/core` — scanning, detection, Report 3.0.0.
- `packages/registry` — `SiteRegistry` (`src/site-registry.ts`): Arkiv and
  local backends with identical behaviour.

## Arkiv entities (signed by the backend's scanner key; reads trust only `trustedOwners`)

All bytes payloads are **gzip of the canonical JSON** (≤ 128 KiB after
compression; larger → publish refused, never truncated). Expiry: the longest
Arkiv allows (`ARKIV_EXPIRY_DAYS`, default 180) so history persists. One scan
= one atomic `executeBatch` of: scan + evidence + flows.

### `igris.scan.v2` — one per published version

| attribute                                               | type  | indexed |                                       |
| ------------------------------------------------------- | ----- | ------- | ------------------------------------- |
| `hostname`                                              | str   | yes     | the site                              |
| `version`                                               | i32   | yes     | 1, 2, 3 … per (hostname, owner)       |
| `previous`                                              | str   | no      | entity key of version − 1 ("" for v1) |
| `scannedAt`                                             | u64   | yes     | unix seconds                          |
| `scanId`                                                | str   | yes     | `contentHash(report)`                 |
| `evidenceSha256`                                        | str   | yes     | `bundleHash(bundle)`                  |
| `findingSetSha256`                                      | str   | yes     | same behaviour ⇔ same digest          |
| `state`                                                 | str   | yes     | summarise() state                     |
| `coverage`                                              | str   | yes     | full / pre-connect-only               |
| `recipients`, `addressRecipients`, `trackingRecipients` | i32   | yes     | counts                                |
| `usesAnonRpc`                                           | bool  | yes     |                                       |
| `scannerVersion`, `reportVersion`                       | str   | no      |                                       |
| `report`                                                | bytes | no      | gzip(canonical Report 3.0.0)          |

The full report is published so any IGRIS instance can render any site's
report from Arkiv alone. It is canary-safe: the evidence is redacted by
construction; the report's own `canaryAddress` is the scan's throwaway,
never-funded address.

### `igris.evidence.v1` — one per version

`sha256` (str, indexed), `scanId` (str, indexed), `bundleVersion` (str),
`bundle` (bytes: gzip(canonical bundle)).

### `igris.flow.v1` — one per recipient of a version (cross-site view)

`hostname`, `recipient`, `class`, `verdict`, `address`, `preConnect` (bool),
`version` (i32), `scanId`, `scannedAt` (u64) — all indexed. Powers "this
tracker also receives data on N other scanned sites" inside the report.

### Verification on read

`load()` gunzips, checks `contentHash(report) === scanId`,
`bundleHash(bundle) === evidenceSha256 === report.evidence.sha256`, schema
validity and `verifyReportIntegrity` (which recomputes recipients/verdicts).
Any mismatch → `verified: false` with the problems, and the UI says so.

## API (apps/api) — the only routes

```
GET  /api/health                         → { ok: true }
GET  /api/registry                       → { mode, publisher, network, trustedOwners, ready, reason? }
GET  /api/sites?limit=                   → { sites: PublishedScan[] }             (recent, latest per hostname)
GET  /api/sites/:hostname                → { hostname, versions: PublishedScan[], scanning: { id, state } | null }
GET  /api/sites/:hostname/versions/:n    → { scan: PublishedScan, report, evidence, verified, problems,
                                             summary, changes: Changes | null, source: 'arkiv' | 'local' }
                                           404 no such version; 502 neither the registry nor the cache has it
POST /api/sites/:hostname/scans  {url?}  → 202 { id }        (scan or retest; one in-flight scan per hostname)
                                           400 bad/unpublishable hostname or url; 409 { error, id } one is running;
                                           503 registry not ready or queue full
GET  /api/scans/:id                      → { scan: Job }      (state, events, hostname, version?, error?, publish?)
GET  /api/scans/:id/events               → SSE: state, progress, done { state, hostname, version | null, error | null, publish }
GET  /api/scans/:id/report               → { report, evidence, verified, problems, summary, source: 'local' }
                                           404 unknown job or nothing cached; 409 job not completed
POST /api/scans/:id/publish              → { publish: JobPublish }  (retry; 404 unknown; 409 not retryable or stale)
GET  /api/recipients/:domain             → { flows: FlowEntity[] }  (other sites sending data to this recipient)
```

`source` says where a version's content was read: `'arkiv'` / `'local'`
is the registry backend itself (`registry.mode`); when the registry copy
cannot be loaded the API falls back to this server's local cache — re-verified
against the entity's `scanId` / `evidenceSha256` (schema, integrity, hashes) —
and answers `source: 'local'` with a problem saying so.

`GET /api/scans/:id/report` serves a **completed** job's scan from the local
cache, re-verified on every read (schema, `verifyReportIntegrity`,
`contentHash(report) === scanId`, `bundleHash(bundle) === report.evidence.sha256`),
so a scan whose publish failed or is pending can still be viewed.

`GET /api/registry`: in Arkiv mode `ready` / `reason` combine the
configuration (scanner key loaded?) with a live probe of the node
(`status()`), bounded by a 5 s timeout and cached for 30 s (one probe at a
time). Local mode is not probed.

`Changes` (version n vs n − 1, computed by the API from the two reports):
`{ sameBehaviour: boolean (findingSet equal), added: RecipientRef[],
removed: RecipientRef[], changed: Array<{ ref, from: {verdict, address},
to: {verdict, address} }> }` with `RecipientRef = { registrableDomain,
class }`. Version n − 1 is the entity version n links to — `scan.previous`,
resolved with `SiteRegistry.byKey` (it must be the same hostname and owner,
version n − 1) — never "whatever is numbered n − 1", and changes are only
computed when that version **verifies**. Otherwise `changes: null` and
`problems` gains `changes not shown: previous version v{n−1} could not be
verified: <why>`.

After a scan completes the API publishes it. If publishing fails, the job
is `completed` with `publish: { ok: false, error }`, the report stays
viewable from the local cache (`GET /api/scans/:id/report`), and
`POST /api/scans/:id/publish` retries. A retry (and a job cut short by a
server restart while publishing) first asks `SiteRegistry.findByScanId(hostname,
scanId)`: a scan already in the registry is adopted (`version`, `publish: {
ok: true, mode, scanKey }`), never published twice; if the registry cannot
be asked, nothing is published. A retry is refused (409, and the job's
`publish` stays `ok: false` with the reason) when a later job of the
hostname is already published or the registry's latest version was scanned
at or after the cached scan — history never runs backwards (the registry
also refuses such a publish itself). A scan whose page never loaded
(coverage none) is not a version: the job is `failed` with the reason and
the UI offers to retry.

Abuse controls: POSTs share a per-client limit (`IGRIS_RATE_LIMIT_MAX`
per `IGRIS_RATE_LIMIT_WINDOW_MS`); the expensive reads (`versions/:n`,
`scans/:id/report`) have their own (`IGRIS_READ_RATE_LIMIT_MAX`, default
120). Verified registry loads are kept in a 64-entry in-memory LRU keyed by
entity (published content is immutable). Behind a reverse proxy set
`IGRIS_TRUST_PROXY` to the number of proxy hops: the client is the address
that many hops from the right of `X-Forwarded-For`, never its
client-written first entry.

Hostname normalisation: lower-case, strip `www.`? **No** — the hostname is
exactly what the visitor typed (www.bungee.exchange ≠ bungee.exchange); the
search box accepts a URL or a bare host and uses `https://<host>/`.

Configuration (environment): `IGRIS_REGISTRY` (`arkiv` | `local`,
default `arkiv` when a scanner profile exists, else `local`),
`ARKIV_ACCESS_KEY` (loaded from `.env.arkiv`), `IGRIS_SCANNER` (profile
name, default the only profile; Arkiv mode only — local mode always
publishes as `local`), `IGRIS_TRUSTED_SCANNERS` (comma-separated owners;
default the publisher), `ARKIV_EXPIRY_DAYS` (default 180).
