# Engineering log

Newest entries at the bottom. Each entry records what changed, why, how it
was verified, and what remains unverified. Statuses follow
[ROADMAP.md](./ROADMAP.md).

---

## 2026-11-06 — Assessment and roadmap

**Inspected:** every source file, doc and config. Ran build, lint, format,
94 unit tests and 22 e2e tests (all green). Ran live scans of github.com and
a dead URL. Probed the Arkiv Rabdi RPC live. Researched the bounty pages,
Arkiv SDK 1.0.1 source, anon-rpc spec v0.4.0, Kohaku, WalletBeat and EAS.

**Decisions (approved by the project owner):**

- Execution order P0 → P0.5 → {P1, P2, P3, P5} → P4 gate → P6.
- The hosted scanner stays local/Docker-only until P0 passes.
- Viewer rewrite in Preact with hash routing (P5).
- Arkiv scanner keys funded by a human at the Rabdi faucet. Paid Swarm
  postage is deferred until after validation.
- A second Mac runs an independent scanner node with its own key and profile.
- EF target: **Best CROPS App**, with Privacy as the lead property.
  Anon-RPC is the remediation story. The Anon-RPC prize requires the app's
  _own_ reads to go through Anon-RPC, and IGRIS's reads go to Arkiv.

**Why these are out of scope:** smart-contract analysis (Slither and
similar exist, false-positive risk, no differentiation); active probing of
third-party sites (ethics, legality); contracts, tokens or staking (no
security benefit over signed, attributable entities); EAS (duplicates Arkiv,
no CROPS gain); TEE proofs (out of reach, and "verifiable" here means
attributable + content-addressed + reproducible + corroborated); LLM findings
(violates determinism); hosted authenticated scanning (credentials would
reach our server, which breaks P).

Reconciliation findings R1–R17 are in ROADMAP.md.

---

## 2026-11-06 — P0 Integrity

Branch `p0-integrity`. Commits: `ad6cd78` (report/registry), `7bc9432`
(egress, API, build), `f211f7b` (viewer/extension/scripts), plus a
docs/tests commit.

### What changed and why

| Criterion | Change                                                                                                                                                                                                                                                                                                         | Verified by                                                                                                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1      | Report 1.1.0. `score: null` + `coverage: none` when the page never loaded, the main document returned HTTP ≥ 400, or the scan was aborted. `recordFromReport` throws `UnpublishableReportError`; the CLI exits 2; HTML/CLI/viewer render "not scored".                                                         | unit: report-builder, validate, cli; e2e: cli (exit 2, publish refused), headers (404)                                                                                                                                                               |
| P0-2      | `coverage: pre-connect-only` for wallet-connect-failed; labelled in CLI, HTML, viewer list and detail.                                                                                                                                                                                                         | unit: cli; e2e: headers, viewer                                                                                                                                                                                                                      |
| P0-3      | Headers come from the main frame's first non-redirect document response in phase A, as `allHeaders`. Absent → omitted ("unknown"). Legacy registry rows (request-header data) are discarded on read.                                                                                                           | unit: report-builder (incl. regression and report-only CSP); e2e: positive, negative, redirect chain; live: github.com now shows CSP + HSTS present                                                                                                  |
| P0-4      | `validate.ts`: strict parser for every registry row (types, closed enums, sizes, hostname/hex patterns). `validateRecords` drops and counts invalid rows. It is used by ArkivRegistry, LocalRegistry, viewer snapshot mode and (simplified) the extension. Every rendered value is escaped or `num()`-guarded. | unit: 25 hostile mutations, garbage SDK rows, u64 overflow, non-JSON summary; e2e: viewer and popup with XSS payloads (no execution)                                                                                                                 |
| P0-5      | `egress/proxy.ts` + `ip-policy.ts` with Chromium flags (`--proxy-server`, `<-loopback>`, `--disable-quic`, WebRTC `disable_non_proxied_udp`). Refused hosts are excluded from findings and contacts and listed in report notes.                                                                                | unit: 47 IP cases, 11 raw-socket blocked cases, allowlist exactness; e2e: control proves 7 HTTP/WS routes + WebRTC STUN reach the internal servers, public-only run shows 0 hits on all; direct, DNS-to-private and main-redirect targets never load |
| P0-6      | `repo.ts`: strict `https://github.com/<o>/<r>` pattern, `--`, protocol allowlist, `core.symlinks=false`, hooks/credential helper/redirects off, no global/system config, size/file/source-file limits before parsing.                                                                                          | unit: 21 rejected inputs, args shape, git itself refusing `file://`, symlink not followed, each limit; HTTP 400/422                                                                                                                                  |
| P0-7      | `limits.ts`: JobQueue (concurrency, bounded wait, hard timeout with abort and slot held until settle), RateLimiter (salted-hash keys). Exact-origin CORS, 16 KB body, no `x-powered-by`.                                                                                                                       | unit + HTTP: 429, 503, 504 (abort observed), 413, 400, CORS allow/deny                                                                                                                                                                               |
| P0-8      | API holds no key and returns `provenance: "unpublished"` and a `preview` (null when unscored); `/api/reports*` removed. Viewer has provenance per row; "trusted" → "pinned"; `DEFAULT_PINNED = []`.                                                                                                            | HTTP tests; viewer e2e (API result never shows as an Arkiv entity, old address absent)                                                                                                                                                               |
| P0-9      | `igris-dist` export condition; production start `node --conditions=igris-dist …`; Dockerfile non-root with `PLAYWRIGHT_BROWSERS_PATH`; `.dockerignore` (keeps `.env` out of the build context).                                                                                                                | live: production API starts, `/api/health` OK, metadata URL → 400, real github.com scan through the egress proxy. **Docker build/run UNVERIFIED** (daemon not running).                                                                              |
| P0-10     | Scored-only leak counts, `wsConnections` vs `wsFrames`, false marketing copy removed, repo-scan copy no longer claims "already private". Found and fixed a viewer bug: scan outcomes were never rendered.                                                                                                      | unit, viewer e2e                                                                                                                                                                                                                                     |
| P0-11     | README CROPS rewritten per letter against the code; Registry says "none yet"; STATUS, SUBMISSION_CHECKLIST, JUDGES, METHODOLOGY, SCORING, ARCHITECTURE, PROJECT_GUIDE, PLAN and AI_USAGE corrected. Also corrected a false code comment claiming the JSON Schema was test-enforced.                            | review                                                                                                                                                                                                                                               |
| P0-12     | lint, format, build, 264 unit, 39 e2e, `pnpm demo` all pass.                                                                                                                                                                                                                                                   | runs below                                                                                                                                                                                                                                           |

### Decisions

- **The egress control is a proxy, not URL validation.** Page JS,
  redirects, subresources, WebSockets, WebRTC and DNS rebinding all bypass
  URL checks. The API still validates URLs, but only to fail fast.
- **Local CLI stays unrestricted by default.** Scanning localhost and dev
  builds is a core use case, and the user is scanning their own network.
  Public-only is mandatory only for hosted scans, and the API does not let a
  request change it.
- **HTTP ≥ 400 main documents are unscored**, not scored as "clean". Bot
  walls get a finer status (`blocked-by-target`) in P1-4.
- **Real Arkiv publishing moved from P0 to P2.** v1 entities would be
  superseded by schema v2 immediately, and funding is a human step.
- **The API keeps no results store.** The old in-memory store mixed seeded
  snapshot data with fresh scans and fed the fabricated "Arkiv entity" UI.

### Known limitations (carried forward, not hidden)

- **Chromium sandbox.** Playwright launches Chromium with `--no-sandbox` by
  default, so in the API container a renderer exploit runs as the
  unprivileged `igris` user with network egress already filtered. That is
  acceptable for local use only. Public deployment requires ROADMAP P4-6.
- **Docker build not verified** (P0-9). Repro is in STATUS.md.
- **`reportSha256` is not independently checkable** until evidence is
  published (P05-4, P2-3). The viewer says so next to the hash.
- **The `.env` key** was generated by an earlier AI session and never funded.
  It is superseded by per-node keys (P05-6).
- **`allowAddresses`** in the egress proxy is an operator and test escape
  hatch. The API never sets it from request input.

---

## 2026-11-06 — P0-9 Docker verification → P0 PASS

Docker 28.3.3 (arm64, Docker Desktop). Image `igris-api:p0`
(`sha256:8148ef76…d8e3`, rebuilt after the fix below), built from
`apps/api/Dockerfile`.

| Check                                                                | Result                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker build`                                                       | succeeds; image config `User=igris`, `Cmd=node --conditions=igris-dist apps/api/dist/index.js`                                                                                                                                                                                   |
| Runtime user                                                         | `id` → `10001:igris` (non-root)                                                                                                                                                                                                                                                  |
| Secrets in image                                                     | no `.env` anywhere in the filesystem; no `ARKIV_PRIVATE_KEY=0x…` under `/app`                                                                                                                                                                                                    |
| `/api/health`                                                        | 200, `egress: public-only`, no key held                                                                                                                                                                                                                                          |
| Internal targets                                                     | `169.254.169.254` → 400 (fail-fast); `file:///app/.git` repo → 400                                                                                                                                                                                                               |
| Egress inside the container, real public DNS that resolves privately | `localtest.me` (→ 127.0.0.1/::1), `127.0.0.1.nip.io`, `169.254.169.254.nip.io`: all `page-load-failed`, score null, preview null, `egress blocked: … (loopback / link-local / cloud metadata)`. These names pass the API's URL check by design, so the proxy alone stopped them. |
| Real public scans in the container                                   | github.com: CSP + HSTS present, coverage pre-connect-only, score 93, provenance unpublished. example.com: document 200, score 100, pre-connect-only.                                                                                                                             |
| Rate limit                                                           | 5 requests per minute per client, then 429 (rejected requests count too). This caused one empty probe response during verification; it was rerun on a fresh container.                                                                                                           |
| Logs                                                                 | only listen line and `scan finished: status=… score=…` — no client IPs, no URLs                                                                                                                                                                                                  |

**Fix made during verification:** the refusal reason for IPv6 forms
(`::1`, IPv4-mapped, `fe80::/10`, `fc00::/7`) said "non-public address".
It now names the class. Unit-tested. Blocking behaviour was already
correct; only the reason label changed. The image was rebuilt and rechecked
after the fix.

**P0 status: PASS.** The Chromium-sandbox limitation stays recorded as
P4-6 and gates any public deployment.

---

## 2026-11-06 — P0.5 Foundations → PASS

Branch `p05-foundations` (from `p0-integrity`). Specification:
[CONTRACTS.md](./CONTRACTS.md).

### Per criterion

| Criterion             | Delivered                                                                                                                                                           | Verified by                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P05-1 Report v2       | `contracts/report-v2.ts`: detector-agnostic findings with fingerprint-derived ids; types + JSON Schema (Ajv 2020, strict, `additionalProperties:false`)             | compile-time key exhaustiveness in `lockstep.ts` (part of the build; drift proven to fail it), runtime key/schema tests, 13 hostile-document rejections                    |
| P05-2 separation      | `privacy` vs `security` sections; `SecurityObservation.countsTowardPrivacyScore: false` literal; `scorePrivacy` refuses non-privacy findings; schema `const: false` | `@ts-expect-error` assertions in `lockstep.ts`; runtime and schema tests; score identical with or without the security detector                                            |
| P05-3 detector API    | `contracts/detector.ts`, `engine.ts`; canary-leak, ip-exposure, security-headers ported to core as pure detectors                                                   | contract tests: missing evidence, invalid evidence, scored security finding, missing scoring rule, duplicate identity, duplicate detector, canary in evidence → scan fails |
| P05-4 evidence bundle | `igris.evidence.v1`, content-addressed, canary-free, RFC 8785 + sha256; `evidence.json` written as canonical bytes                                                  | RFC 8785 vectors; same capture → byte-identical report and bundle; `shasum evidence.json` == report hash on all examples; tamper detection                                 |
| P05-5 migration       | `migrate.ts`; 9 frozen v1 fixtures (1.0.0/1.1.0; completed/partial/failed; synthetic + real uniswap/github/dead-URL)                                                | 69 regression tests: schema-valid, every finding kept field-for-field, scores identical (cross-checked with the v1 scorer), deterministic, canary-free                     |
| P05-6 identity        | `registry/src/identity.ts`, `igris scanner init/import/list/show`; node-bound profiles; publish signs only with this node's key                                     | 10 identity tests + CLI test (keys never printed)                                                                                                                          |

### Decisions

- **Two digests, not one.** Measuring two real scans of the fixture showed
  the evidence bundles differ: wagmi stores a random connection id next to
  the address in localStorage, so a faithful snippet differs between scans.
  Rather than normalize evidence (lossy, heuristic), Report v2 also carries
  `findingSet.sha256`, a digest of the sorted finding fingerprints. It is
  stable across scans with different canaries (asserted in the real-browser
  e2e, repeated 5×). ROADMAP P2-5 and P6-2 were updated to compare
  `findingSet`. I first wrote an assertion that the evidence hash is equal
  across scans; it failed, the cause was diagnosed, and the assertion was
  replaced with the property that actually holds.
- **The finding identity excludes the canary.** Fingerprints exclude the
  canary, timestamps and snippets, so ids are stable across scans and nodes
  — the basis for history diffs (P2-4).
- **Hex label precedence fixed.** A canary whose EIP-55 checksum is
  all-lowercase or all-uppercase letters was labelled
  "lowercase"/"uppercase" rather than "checksummed", so its fingerprint
  depended on the random canary (probability ≈ 2^-letters). A match equal to
  the checksummed form is now always "checksummed". There is a regression
  test with a real such address.
- **The detector always records header evidence.** The security-headers
  detector always emits an info "summary" observation carrying the
  document-headers evidence, so "all headers present" is evidenced and
  distinguishable from "no main document observed".
- **Scanner keys are never read from env.** This is stricter than the
  roadmap text ("file or env"): env keys leak into process listings, CI
  logs and Docker layers, and cannot be bound to a node. `.env.example`
  no longer mentions a key.
- **Report hash semantics changed:** `reportSha256` in registry records is
  now the canonical content hash (summary v2). It was the hash of the raw
  report.json bytes. The evidence hash is added as `summary.evidenceSha256`.
- **The scripts are typechecked now** (`scripts/tsconfig.json`, part of
  `pnpm build`). This immediately caught a latent P0 type error in
  `batch-scan.ts`.

### Deviations from the roadmap text (stated, not hidden)

- P05-1 lists a field `kind`. v2 splits it into `domain` (privacy/security)
  and `kind` (issue/risk/observation), because the roadmap's "confirmed
  issue vs potential risk vs observation" distinction and the
  privacy/security split are independent axes.
- P05-5 "scores identically wherever the v1 score was valid". One real
  fixture (app.uniswap.org, pre-b915636) had an invalid v1 score: it charged
  for a "third party" with an empty hostname. The migration removes that
  contact and records 82 → 83 with the reason in `scan.notes`. Any other
  mismatch throws `MigrationError`.

### Known limitations

- Two machines that each import the same key by hand cannot be detected
  locally (on Arkiv they are one owner, i.e. one scanner).
- Evidence-bundle hashes are not reproducible across scans of pages that
  embed nonces near the address. Use `findingSet` to compare.
- The viewer still renders registry summaries (summary v2). It does not yet
  consume Report v2 or evidence bundles directly (P2-3/P5-4).
- Docker re-verified on the P0.5 code: build, non-root user, health,
  internal target refused, real github.com scan producing Report v2 with
  public-only egress.

## 2026-11-06 — P1 Reliability (partial, paused by the MVP direction change)

Committed as `dd47f45` on `p1-reliability`. What exists:

- Kit discovery tooling: page probes (read-only, shadow-DOM aware), kit
  fingerprinting whose confidence is earned (`high` only when the kit's modal
  was observed), strict connect-control scoring (no navigating links), and
  `openConnectUi` with a navigation guard.
- Load taxonomy: `site-unavailable`, `bot-blocked`, `browser-incompatible`;
  a page that is not the dApp is never scored.
- Corpus: 57 candidates, discovery and diagnosis data, 60 research leads
  (assumptions with citations, verified separately). 14 kits confirmed live
  (RainbowKit 2, Privy 5, AppKit 5, ConnectKit 1, Dynamic 1).
- Contract successors, additive: Report 2.1.0 (optional `scan.connection`,
  `scan.failure`) and `igris.evidence.v2` (+ `contact-classification`). The
  frozen 2.0.0 / v1 schemas are untouched and hash-pinned. Approved by
  the project owner on 2026-11-06 (see below).

Not done: kit recipes are not wired into `scan()` (scans still connect with
the legacy heuristic, `legacy-heuristic@0`); terms/consent gates (Morpho,
zkSync, MetaMask Portfolio) need an owner decision on auto-accepting; the
discovery report awaits the owner's review before recipe work starts.

## 2026-11-06 — MVP web application (strategic direction change)

The owner asked for a working web application before further P1 work.

### What changed and why

- **Scan jobs** (`apps/api/src/scans.ts`, `c95980e`): `POST /api/scans`,
  list, detail, report, SSE events, dashboard stats. Progress events are the
  scanner's own (`scan({ onProgress })`); the service never invents a stage
  or a percentage. Scans persist under `.igris-data/scans/<id>/` (gitignored,
  operator's machine only, unpublished and unattributed). Every report is
  re-verified (schema + integrity) when read; a tampered file is refused
  with 500. A restart marks in-flight scans `failed: interrupted`.
- **`assess()`** (`packages/core/src/assessment.ts`, `a5c4c63`): the risk
  level and executive summary, deterministic and derived only from the
  report and evidence. Levels: not-assessed / critical (scored canary leak
  of high severity) / high (any other scored leak) / elevated (<70) /
  moderate (<90) / low. Partial coverage is always stated.
- **Web app** (`apps/app`, `43a3ba2`): Preact 10.29.8 (11.x was published
  the same day — not adopted), hash routing, self-hosted fonts, no
  third-party requests. Pages: Landing, Dashboard, New Scan, Live Scan,
  Report, Evidence Explorer, History. The report re-checks evidence integrity
  in the browser with `@igris/core/contracts` (bundle hash, content ids,
  finding-set digest, references); this is an independent check, the
  server's verification stays authoritative.
- **Dashboard aggregates** (`d53945d`): use the latest completed scan per
  dApp (re-scans never double-count); kits are reported per confidence
  level, so a low-confidence guess is never displayed as an identification.

### Bugs found by using the product on real dApps

1. **Redirect target scored as a third party** (`f66884f`, core engine).
   `app.spark.fi` redirects to `app.spark.finance`; the dApp's own API
   received the address and was scored as an unknown third party: 5/100,
   "critical". The engine now treats the captured main document's
   registrable domain as first party and says so in `scan.notes`. Re-scan:
   44/100, leaks to alchemy.com (RPC) and walletconnect.org (relay) only.
   The earlier 5/100 scan is kept in local history as produced; the
   dashboard uses the latest scan per dApp.
2. **DNS failures labelled as egress refusals** (`e0f4d93`, scanner).
   Through the proxy every refusal surfaces as
   `ERR_TUNNEL_CONNECTION_FAILED`; the proxy's own reason is now used, and
   failure details are one clean line (no ANSI codes, no call log).
3. UI: findings with identical titles are grouped into one row (each keeps
   its id and evidence links); per-row score points are shown only when
   whole ledger lines belong to that row (no apportioning); a page that
   never loaded renders a compact report instead of empty sections.

### MVP scan results (local node, scanner 0.2.0, egress public-only, 4 s dwell)

| dApp                | Score | Level    | Coverage         | Connect                       | Kit (confidence) | Address reached                |
| ------------------- | ----- | -------- | ---------------- | ----------------------------- | ---------------- | ------------------------------ |
| app.uniswap.org     | 77    | moderate | full             | connected                     | Privy (low)      | first party only               |
| matcha.xyz          | 61    | high     | full             | connected                     | Privy (high)     | quiknode.pro                   |
| app.spark.fi        | 44    | high     | full             | connected                     | AppKit (medium)  | alchemy.com, walletconnect.org |
| www.bungee.exchange | 73    | moderate | pre-connect-only | failed: request-not-issued    | Dynamic (low)    | not tested                     |
| app.aave.com        | 79    | moderate | pre-connect-only | failed: wallet-option-missing | ConnectKit (low) | not tested                     |
| app.gearbox.fi      | 85    | moderate | pre-connect-only | failed: wallet-option-missing | none             | not tested                     |

Connect success with the legacy heuristic: 3/6. That is the P1-2 problem
the kit recipes address; the three partial scores are labelled partial in
the UI and in `assess()`.

### Known limitations

- Scan history is local to the scanner node; nothing is published. The
  hosted deployment is still gated by ROADMAP P4-6 (Chromium sandbox).
- The raw capture is not retained; the evidence explorer shows the
  content-addressed extracts and says so.
- Not yet measured: Lighthouse accessibility, an e2e no-third-party-request
  check, a light theme (P5-2, P5-3).

## 2026-11-06 — Contract successors approved and frozen

The project owner approved Report 2.1.0 and `igris.evidence.v2` (ROADMAP
MVP-7). They are accepted exactly as proposed in `dd47f45`; the schemas
have not changed since (their canonical hashes were recomputed and match).

- The three successor schemas (`REPORT_SCHEMA_2_1_0`, `EVIDENCE_ITEM_SCHEMA`,
  `EVIDENCE_BUNDLE_SCHEMA`) are now pinned by canonical hash in
  `contracts.test.ts`, alongside the P0.5 pins. Changing them now means a
  new version.
- `docs/CONTRACTS.md` specifies both normatively and states the approval
  rule: a successor takes effect only after owner approval and is then
  frozen.
- Why they were needed (demonstrated before they were added): the frozen
  2.0.0 schema has `additionalProperties: false` on `scan`, so it cannot
  carry connect diagnostics or a structured failure reason, and the frozen
  v1 item `oneOf` cannot hold a classification item.

## 2026-11-06 — Connect engine, leak lens, CROPS hardening (scanner 0.3.0)

Trigger: a relay.link scan failed to connect. The legacy heuristic searched
the whole page for `/metamask/i` and clicked the marketing line "$20B+
settled across 85+ chains, powering Phantom, MetaMask,". The owner asked
that connecting work everywhere and that the product focus on the bounty's
idea 4 ("a tool that shows what an app leaks").

### What changed and why

- **Connect engine** (`packages/scanner/src/connect/{engine,choice}.ts`):
  strict control scoring → wallet choice **inside the dialog that appeared
  after the click** (our EIP-6963 rdns / exact name → at most two "reveal
  the list" steps → exact generic entries) → connected only when the dApp's
  **main frame** calls `eth_requestAccounts` → one in-dialog SIWE click.
  Origin change at any step aborts. No page-wide fallback. Evidence first:
  `scripts/connect-probe.ts` recorded what each kit's open modal contains
  before any rule was written.
- **RPC by behaviour** (`packages/core/src/engine.ts`): an unknown domain
  is `rpc-provider` only if every request (and sent WebSocket message) to
  any of its hosts is pure Ethereum JSON-RPC. First version was per host and
  "any request"; the review showed a tracker could soften its own leak by
  answering one RPC call, mixed batches qualified, and one vendor could be
  charged twice. All three are regression-tested now.
- **Third-party DB** 52 → 77 entries, each sourced (agent-researched,
  reviewed). `api.developer.coinbase.com` was added and then removed: the
  same host receives OnchainKit's address-bearing analytics.
- **"Who learned what"** report section: one row per (registrable domain,
  class), address column from the backend's scored canary-leak findings
  (a truncated match is only "possible"), honest wording when the wallet
  did not connect.
- **Zero third-party requests in the web app** is now an e2e test
  (`apps/app/e2e/no-third-party.e2e.ts`, 10 routes, delayed-request and
  static-bundle checks, negative controls).
- README CROPS rewritten against the code (it claimed the API stores no
  results and that keys live in `.env`; both false), plus "Where the
  blockchain is used".

### Review

A four-lens adversarial review (connect safety, detection integrity,
frontend truth, security/CROPS) produced 25 confirmed findings (0 high
after verification); all were fixed or documented in this change. Notable:
URLs > 500 chars could break the Report 2.1.0 schema; an engine exception
discarded a loaded page; iframe `eth_requestAccounts` counted as connected;
cookie banners counted as connect dialogs.

### Results (scanner 0.3.0, API, egress public-only, 4 s dwell)

| dApp                | Score | Connect      | Address reached                                                        |
| ------------------- | ----- | ------------ | ---------------------------------------------------------------------- |
| app.uniswap.org     | 77    | generic@1    | first party only                                                       |
| app.pendle.finance  | 66    | appkit@1     | walletconnect.org                                                      |
| matcha.xyz          | 61    | privy@1      | quiknode.pro                                                           |
| app.spark.fi        | 44    | appkit@1     | alchemy.com, walletconnect.org                                         |
| www.bungee.exchange | 35    | dynamic@1    | dynamicauth.com                                                        |
| relay.link          | 0     | dynamic@1    | abs.xyz (RPC), dynamicauth.com, ensideas.com                           |
| app.aave.com        | 0     | connectkit@1 | aavechan.com, browser-intake-datadoghq.com, tenderly.co                |
| app.gearbox.fi      | 0     | rainbowkit@1 | alchemy.com, etherlink.com, somnia.network (RPC), gearbox.foundation   |
| swap.cow.fi         | 0     | generic@1    | alchemy.com, google.com, hypelab.com, sentry.io, spindl.link, wc relay |

Connect: 9/9 (legacy heuristic: 3/6). Scores fell because post-connect
traffic is now observed; the leaks were checked by hand against evidence.

### Known limitations (stated, not hidden)

- `gearbox.foundation` is Gearbox's own domain but is scored as an unknown
  third party: same-organisation mapping (P1-3) is not built.
- Wallet-SDK backends (Dynamic, Privy, the AppKit API) have no recipient
  class in the frozen enum, so they appear as "Unidentified" and drive a
  "critical" headline on Bungee. A `wallet-sdk` class is a contract change
  (owner approval).
- Kit-specific local fixture tests and a full-corpus connect rate (P1-2)
  are still pending; the 9/9 is a live result on the MVP set.

## 2026-11-06 — One flow: no CLI, no scores, reports and history on Arkiv

Owner direction: delete everything outside one flow (search → scan or
retest → visual report → published on Arkiv with version history); no CLI;
no scores.

### What changed

- **Removed:** `packages/cli`, `packages/patcher`, `apps/web`, `extension/`,
  `scripts/`, `corpus/`, `examples/`, `recipes/`, the fixed-dApp fixture and
  stale docs; the scanner's recipe-file connect path and legacy heuristic.
  Git history keeps all of it.
- **Report 3.0.0** (`packages/core`, proposed): no score/ledger;
  `recipients[]` with deterministic verdicts (expected / avoidable /
  tracking / unidentified, rule + reason); `timeline` (milestones, first
  contact / first address per recipient, requests per second, from capture
  timestamps); `rpc` (per endpoint: JSON-RPC methods and counts, address
  seen). Migration from 2.x. Verified by an independent agent against the
  spec; four defects fixed (size caps could crash a scan; integrity did not
  recompute verdicts; Anon-RPC counted as exposure; contradictory reasons).
- **Registry** (`packages/registry`): `SiteRegistry` with Arkiv and local
  backends — `igris.scan.v2` (full gzip report, version, previous),
  `igris.evidence.v1` (gzip bundle), `igris.flow.v1` (per recipient); one
  atomic `executeBatch` per scan; strict row validation; owner trust;
  idempotent per scanId; never publishes history backwards.
- **API** (`apps/api`): only the flow's routes; auto-publish after a scan;
  verified reads with a cache fallback; changes vs the verified previous
  version (followed by `previous` key); duplicate-version protection on
  retries and restarts.
- **Website** (`apps/app`): search, site page with version history and
  Retest, live scan, report with SVG timeline / traffic / address-flow / RPC
  charts, evidence explorer, publish status; zero third-party requests.

### Live verification (Arkiv Rabdi, scanner 0x36Df…5Bbe)

- `app.uniswap.org` v1 (tx 0xce45a381…), v2 (0x96198c7a…), v3 (0x2d68c4ec…,
  started with the Retest button; the page moved to v3 by itself); each
  `previous` points to the version before; v2 and v3 'same finding set'.
- `swap.cow.fi` v1 (0xad0435ac…, 32 flows): address to spindl.link,
  google.com, sentry.io (tracking/unidentified), alchemy.com and the
  WalletConnect RPC (avoidable).
- Raw `arkiv_query` (outside our code) returned the scan entity with owner,
  version, previous and expiry (≈180 days).
- Arkiv's anonymous query budget is small (`ANON_COST_LIMITED` after the
  agents' read-only checks): the organisers' query needs an access key.

### Process

Built by parallel agents on disjoint packages against shared specs, each
followed by an independent verifier; confirmed defects fixed with regression
tests (duplicate versions on retry, history running backwards, IPv6
recipients blocking publish, unverified previous version in diffs, flowsTo
query explosion, cache label, red used for non-leak errors).
