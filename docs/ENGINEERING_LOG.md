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
