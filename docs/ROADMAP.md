# IGRIS roadmap

IGRIS is a runtime privacy and wallet-interaction auditor for dapps, with a
decentralized, verifiable attestation registry. The aim is a product, not a
hackathon checklist. Every phase ends at a checkpoint that is **true in
everything it claims**, so whatever phase we have reached at a deadline can
be submitted as-is.

Ground rules (binding on every phase):

1. **No simulated decentralization.** Every Arkiv claim must be checkable by
   anyone. Every scanner has its own signing key and identity. Every report hash
   resolves to evidence that is actually published.
2. **Deterministic detection.** No LLM may create, change or score findings.
   AI is allowed only as a clearly labelled, opt-in explainer of findings that
   already exist (after P6, if ever).
3. **Evidence or nothing.** No detector emits a finding without structured
   evidence. No component says "verified" unless it was verified independently.
4. **Acceptance criteria are never weakened to pass a phase.** Anything that
   cannot be verified is marked **BLOCKED** (needs an external action) or
   **UNVERIFIED** (not yet demonstrated), with the reason.
5. **Every phase follows the same steps:** inspect → map affected components →
   implement → positive, negative and regression tests → full relevant suite
   → verify acceptance → record decisions and limitations in
   [ENGINEERING_LOG.md](./ENGINEERING_LOG.md).

Status legend: `TODO` · `IN PROGRESS` · `PASS` · `BLOCKED(reason)` ·
`UNVERIFIED(reason)`.

---

## Reconciliation: roadmap vs. the code at `b915636`

This table records what the code at commit `b915636` actually did, as
established by reading it, running it and probing it live (2026-11-06). Each
row says which phase fixes it.

| #   | Finding                                                                                                                                                                                                                            | Evidence                                                                               | Phase                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------- |
| R1  | API stamps every in-memory scan with a hardcoded scanner address. The viewer then shows it as "trusted" with an "Arkiv Entity" id, although nothing was ever written to Arkiv.                                                     | `apps/api/src/index.ts`; live: key balance `0x0`, `igris query` → no records           | P0                            |
| R2  | CSP/HSTS are read from **request** headers, so every scan reports them missing.                                                                                                                                                    | github.com sends both; IGRIS reported both absent                                      | P0                            |
| R3  | A scan whose page never loaded scores **100/100**.                                                                                                                                                                                 | `igris scan http://127.0.0.1:9` → `page-load-failed`, score 100                        | P0                            |
| R4  | The registry summary (anyone can write `igris.scan.v1` entities) is rendered into `innerHTML` without validation. Several numeric fields are not escaped, so a malicious entity can inject HTML/JS.                                | `apps/web/src/main.ts` (`l.points`, `t.requestCount`, telemetry), `extension/popup.js` | P0                            |
| R5  | One malformed entity throws in `rowToRecord` and breaks the whole registry query, so a single attacker can deny service to every viewer.                                                                                           | `packages/registry/src/arkiv.ts`                                                       | P0                            |
| R6  | `/api/scan` is an open SSRF: any URL, including cloud-metadata and private ranges, reachable through navigation, redirects, subresources and page JS.                                                                              | `apps/api/src/index.ts`                                                                | P0                            |
| R7  | `/api/scan-repo` accepts any URL ending in `.git` (including `file://`). There is no `--` before the URL, symlinks are checked out (they can disclose server files via the diff), and there are no size or time limits on parsing. | `apps/api/src/index.ts`                                                                | P0                            |
| R8  | No queue, no concurrency cap, no rate limit, CORS `*`, 10 MB body limit: each request launches a Chromium.                                                                                                                         | `apps/api/src/index.ts`                                                                | P0                            |
| R9  | The production API cannot start: `node apps/api/dist/index.js` fails with `ERR_MODULE_NOT_FOUND`, because workspace packages export `.ts` sources. The Docker image has never worked.                                              | reproduced locally                                                                     | P0                            |
| R10 | UI counts unscored findings (local storage, first-party) as "Canary Leaks… Identity compromised". `wsConnections` actually counts frames. The marketing copy claims things that are false.                                         | `apps/web/src/main.ts`, `report-builder.ts`                                            | P0                            |
| R11 | README "CROPS" says "no backend we operate", but the viewer defaults to calling an API.                                                                                                                                            | README, `apps/web/src/main.ts`                                                         | P0                            |
| R12 | `reportSha256` cannot be checked: the report it hashes is never published.                                                                                                                                                         | `packages/registry/src/from-report.ts`                                                 | P0.5/P2                       |
| R13 | Wallet connect fails on many real dapps (relay.link). The heuristic clicked GitHub's "Sign in".                                                                                                                                    | live scans                                                                             | P1                            |
| R14 | Infrastructure (e.g. `githubassets.com`) is charged as third-party IP exposure. The third-party DB has 52 entries, 5 of them test fixtures.                                                                                        | live github.com scan; `data/third-parties.json`                                        | P1                            |
| R15 | `Finding` is shaped only for canary leaks: no severity, confidence, impact, remediation or structured evidence. Privacy score and security observations are mixed in one report.                                                   | `packages/core/src/report.ts`                                                          | P0.5                          |
| R16 | Zero real Arkiv entities exist, so the Arkiv qualification ("writes to the current testnet") currently fails.                                                                                                                      | live query                                                                             | P2 (BLOCKED on human funding) |
| R17 | `AI_USAGE.md` human-review column is all `TODO(human)`.                                                                                                                                                                            | file                                                                                   | P0 (honest), P6 (human)       |

What is solid and kept: canary encodings, detector, dedup, determinism,
scoring ledger, patcher (verified against `@anon-rpc/browser-harness@0.4.0`,
spec v0.4.0), offline e2e harness, local registry, CLI exit codes. Also:
Arkiv's current testnet is still **Rabdi** (chain 7794095), and SDK 1.0.1 is
current (it has no `updateEntity`; it has `patchEntity`, `extendEntity`,
`executeBatch`, and the `readonly` / `permissionlessExtension` flags).

---

## Dependency graph

```
P0 Integrity ──▶ P0.5 Foundations ──┬─▶ P1 Reliability ──┐
                                    ├─▶ P2 Arkiv v2 ─────┼─▶ P4 CROPS gate ─▶ P6 Validation
                                    ├─▶ P3 Detectors ────┘          ▲
                                    └─▶ P5 Product (design system starts here;
                                         screens follow P2/P3 data)  │
P1 corpus harness ──────────────────────────────────────────────────┘ (P6 reruns it)
```

- P0.5 freezes the data contracts (Report v2, detector interface, evidence
  bundle, scanner identity). P1, P2, P3 and P5 all consume them, so none of
  them starts before P0.5 passes.
- P2 needs P0.5's evidence bundle (for the hash to resolve) and scanner identity.
- P4 is a verification gate over P0, P2 and P5 (hosted node hardening was
  already done in P0).
- P6 reruns the P1 corpus with two independent scanner nodes.

---

## P0 — Integrity

**Goal:** IGRIS claims nothing false, scores nothing it did not measure, and
its hosted surface cannot be turned against its host. Public deployment of
the hosted scanner stays **disabled** until every P0 criterion is `PASS`.

**Depends on:** nothing. **Blocks:** everything.

| ID    | Acceptance criterion (checkable)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P0-1  | A scan whose page did not load has **no score** (`null`). The CLI exits 2. `recordFromReport` refuses to build a publishable record from it. The HTML report, CLI and viewer render "not scored". Unit + e2e tests prove all of these.                                                                                                                                                                                                                                                                                                                                                          | TODO   |
| P0-2  | A scan where the wallet did not connect is marked as **partial coverage** (post-connect canary evidence untested) in report, CLI, HTML and viewer. Its score is labelled as covering the pre-connect phase only.                                                                                                                                                                                                                                                                                                                                                                                | TODO   |
| P0-3  | Security headers come from the **main document's final response** (after redirects). When no main-document response was observed they are reported as _unknown_, never as _missing_. Tested with a fixture that sends CSP + HSTS, one that sends neither, and a redirect chain.                                                                                                                                                                                                                                                                                                                 | TODO   |
| P0-4  | Registry data is treated as untrusted. Every Arkiv row is validated against a strict schema before use. Malformed rows are dropped and counted, never thrown. All rendered values are escaped. Tests: an XSS-payload entity renders inert, and a malformed entity does not break the query.                                                                                                                                                                                                                                                                                                     | TODO   |
| P0-5  | Egress isolation: when the scanner runs in `public-only` mode, all browser traffic goes through an in-process filtering proxy. The proxy resolves DNS once, rejects loopback/private/link-local/CGNAT/multicast/reserved/IPv4-mapped addresses and disallowed ports, and connects to the checked IP (no DNS-rebinding window). WebRTC non-proxied UDP is disabled. Tests: direct navigation, redirect, subresource, `fetch` from page JS, WebSocket, a hostname that resolves to a private IP, and `169.254.169.254` are all blocked, and the internal canary server records **zero** requests. | TODO   |
| P0-6  | `/api/scan-repo` accepts only `https://github.com/<owner>/<repo>[.git]`. It clones with `--` before the URL, `core.symlinks=false`, protocol allowlist `https` only, no tags, depth 1, a timeout, and enforces size/file-count limits before patching. Tests for each rejected input class.                                                                                                                                                                                                                                                                                                     | TODO   |
| P0-7  | API abuse controls: bounded job queue (concurrency and queue length configurable, 503 when full), per-client rate limit, hard per-scan timeout, configured CORS origins (no `*`), 16 KB body limit. Tests for each.                                                                                                                                                                                                                                                                                                                                                                             | TODO   |
| P0-8  | The API never attributes a scan to a scanner key it does not hold, and never labels a record "on Arkiv". API results carry `provenance: "unpublished"`. The viewer shows **"Unpublished — not on Arkiv"** for them, and "pinned" (never "trusted") only for live Arkiv rows whose owner the user pinned. There are no hardcoded scanner addresses in app code. Test: no record that did not come from a live Arkiv read can render as an Arkiv entity.                                                                                                                                          | TODO   |
| P0-9  | The production build starts: `node --conditions=igris-dist apps/api/dist/index.js` serves `/api/health`. The Docker image builds, runs as non-root, and passes the health check. (Docker build: `UNVERIFIED` if no Docker daemon is available, stated in the log.)                                                                                                                                                                                                                                                                                                                              | TODO   |
| P0-10 | Counts and copy are truthful: "address leaks" counts only scored findings, WebSocket connections and frames are counted separately, and every marketing statement in the UI is true or removed.                                                                                                                                                                                                                                                                                                                                                                                                 | TODO   |
| P0-11 | README CROPS, STATUS, SUBMISSION_CHECKLIST and AI_USAGE match the code. The hosted API is described as optional, local/Docker-only, and what it learns is stated. Human-review cells stay marked as needing human input, never filled in by AI.                                                                                                                                                                                                                                                                                                                                                 | TODO   |
| P0-12 | `pnpm lint`, `pnpm format:check`, `pnpm -r build`, `pnpm test`, `pnpm test:e2e` and `pnpm demo` all pass. New tests exist for every item above.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | TODO   |

Not in P0 (moved deliberately): publishing real Arkiv entities. Publishing
v1 entities now would be superseded by schema v2 within a phase, and a funded
key is a human action. It lives in P2 (P2-1), marked BLOCKED until the key is
funded.

---

## P0.5 — Foundations (data contracts)

**Goal:** freeze the versioned contracts every later phase builds on.

**Depends on:** P0. **Blocks:** P1, P2, P3, P5.

| ID    | Acceptance criterion                                                                                                                                                                                                                                                                                                                                                         | Status |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P05-1 | **Report v2** (`reportVersion: "2.0.0"`) is detector-agnostic. A finding has `id, detector, detectorVersion, kind, severity (critical/high/medium/low/info), confidence (confirmed/likely/possible), title, impact, remediation, evidence[] (≥1, typed), countsTowardPrivacyScore`. TypeScript types and a JSON Schema (draft 2020-12) are kept in lockstep by a test.       | TODO   |
| P05-2 | **Privacy score is separate from security observations.** `privacy.score` is computed only from findings of privacy detectors. `security.observations[]` never affect it. A test enforces this by type and at runtime.                                                                                                                                                       | TODO   |
| P05-3 | **Detector interface v1** (`Detector { id, version, kind, run(capture, ctx): Finding[] }`). The existing canary-leak, ip-exposure and security-headers logic becomes three detectors. Contract test: every finding from every detector carries ≥1 schema-valid evidence item. A detector that emits one without evidence fails the run.                                      | TODO   |
| P05-4 | **Evidence bundle v1**: a redacted, self-contained artifact of everything findings reference. **Deterministic serialization** (canonical JSON, RFC 8785-style key ordering, no `undefined`, normalized numbers). Hashes are `sha256` over the canonical bytes. The same capture produces byte-identical bundles across runs (tested). The report references the bundle hash. | TODO   |
| P05-5 | **v1 → v2 migration** (`migrateReportV1toV2`) with regression tests over every committed v1 report in `examples/`. Migrated reports validate against the v2 schema, preserve every v1 finding, and score identically wherever the v1 score was valid.                                                                                                                        | TODO   |
| P05-6 | **Scanner identity**: one key per scanner node, loaded from a file or env, never hardcoded and never shared. `igris scanner init` creates a key and a local profile. The profile shape is versioned (`igris.scanner.v1`). Two nodes never share credentials (the CLI refuses a key file that another profile on disk has already claimed).                                   | TODO   |

---

## P1 — Reliability

**Goal:** IGRIS works on real dapps, measured by a corpus rather than by anecdote.

**Depends on:** P0.5.

| ID   | Acceptance criterion                                                                                                                                                                                                                                                                                                                           | Status |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P1-1 | Corpus of 25–50 real dapps (`corpus/targets.json`, with the selection rationale written down) and a harness that records per target: load status, connect status, connect kit detected, duration. Results are committed as data.                                                                                                               | TODO   |
| P1-2 | Connect recipes and detection for RainbowKit, ConnectKit, Web3Modal/Reown AppKit, Dynamic and Privy. Each has a local fixture test. Connect success rate on the corpus is reported (target ≥70%, real number recorded even if below). Login buttons that are not wallet connects are never clicked (negative tests).                           | TODO   |
| P1-3 | Infrastructure classification: same-organization and asset-only hosts become `infrastructure` observations with **no privacy penalty**, using evidence (organization mapping, resource types, no cookies, no canary). Zero infrastructure penalties on the corpus after manual review. The DB is split into `data/` (production) and fixtures. | TODO   |
| P1-4 | Bot walls and challenge pages are detected and reported as `blocked-by-target`, never scored.                                                                                                                                                                                                                                                  | TODO   |

---

## P2 — Decentralized infrastructure (Arkiv v2)

**Depends on:** P0.5 (evidence bundle, scanner identity).

| ID   | Acceptance criterion                                                                                                                                                                                                                                 | Status                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| P2-1 | Real `igris.scan.v2` entities on Rabdi from the **primary** scanner key. Addresses, entity keys and tx hashes are in the README, plus one runnable query.                                                                                            | BLOCKED(human: fund key at faucet) |
| P2-2 | A **second independent scanner** (second Mac, its own key, its own `igris.scanner.v1` profile) publishes scans of the same targets. The viewer shows agreement and disagreement per finding class.                                                   | BLOCKED(human: second node)        |
| P2-3 | Scan entities are created `readonly`. The full redacted evidence bundle is stored in the entity (≤128 KiB) or chunked, so `evidenceSha256` resolves to published bytes. The viewer recomputes the hash in the browser before showing "hash matches". | TODO                               |
| P2-4 | History: a `prevScan` (key) attribute plus a per-host query → timeline and finding-class diff in the viewer.                                                                                                                                         | TODO                               |
| P2-5 | `extendEntity` when a re-scan reproduces the identical evidence hash ("still true at block N"), instead of a duplicate create.                                                                                                                       | TODO                               |
| P2-6 | One indexed bool attribute per finding class, so class filters run on the server (fixes friction #2).                                                                                                                                                | TODO                               |
| P2-7 | Updated `arkiv/*.md` (schema, friction, why, how, reach), each with links, numbers or a runnable query.                                                                                                                                              | TODO                               |

---

## P3 — Differentiation (new detectors)

**Depends on:** P0.5. Each detector ships with positive and negative fixtures and
at least one real-dapp finding confirmed by hand (or `UNVERIFIED` with the reason).

| ID   | Detector                                                                                                                                                                                                                                                                         | Status |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P3-1 | **wallet-interaction**: every request the dapp makes to the wallet is logged. Flags: Permit/Permit2/`setApprovalForAll`/unlimited `approve` requested at or before connect, `eth_sign` attempts, typed data whose domain chain ≠ connected chain. Evidence: the decoded request. | TODO   |
| P3-2 | **script-supply-chain**: third-party scripts that run in a page exposing `window.ethereum`, with SRI present or absent, origin and hash. Evidence: script URL, sha256, `integrity` attribute.                                                                                    | TODO   |
| P3-3 | **frontend-drift**: a manifest of first-party bundle hashes per scan. A change since the previous attestation is surfaced (an observation, not a penalty).                                                                                                                       | TODO   |

---

## P4 — CROPS gate

**Depends on:** P0, P2, P5.

| ID   | Acceptance criterion                                                                                                  | Status |
| ---- | --------------------------------------------------------------------------------------------------------------------- | ------ |
| P4-1 | Recorded proof: hosted API stopped, and the CLI + static viewer (from any static host) + Arkiv still work end to end. | TODO   |
| P4-2 | The hosted node's logs contain no client IPs or scan-requester identifiers (log review documented).                   | TODO   |
| P4-3 | A live Nym Anon-RPC round-trip from a patched fixture in a real browser on mainnet (recorded).                        | TODO   |
| P4-4 | The CROPS section is re-audited line by line against the code.                                                        | TODO   |
| P4-5 | The hosted scanner is deployed publicly only after P0 = PASS, behind the P0 controls, publishing under its own key.   | TODO   |

---

## P5 — Product quality

**Depends on:** P0.5 (data contracts). The design system can start in parallel with P1–P3.

| ID   | Acceptance criterion                                                                                                                                     | Status |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P5-1 | Viewer rebuilt in **Preact**: component architecture, explicit state store, hash-based routing (works from any static host and IPFS/Swarm, no rewrites). | TODO   |
| P5-2 | Documented design system: monochrome, self-hosted fonts (no font CDN), one semantic accent per severity, light/dark, tabular numerics.                   | TODO   |
| P5-3 | Lighthouse accessibility ≥95. Works at 360 px width with no horizontal scroll. Zero third-party requests (e2e-enforced).                                 | TODO   |
| P5-4 | Evidence-first report screen, timeline/diff, auditor pages, in-browser hash verification.                                                                | TODO   |
| P5-5 | CLI and docs pass: `igris --help` for every command, a quickstart that runs from a clean clone.                                                          | TODO   |

---

## P6 — Validation

| ID   | Acceptance criterion                                                                                                                            | Status              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| P6-1 | Corpus rerun by both scanner nodes. Results are published as Arkiv entities, not prose.                                                         | BLOCKED(P2-1, P2-2) |
| P6-2 | Independent reproducibility: for deterministic targets the second node reproduces the same evidence hashes. Divergence is explained per target. | BLOCKED(P2-2)       |
| P6-3 | Demo video ≤3 min showing the lead property end to end, including the moment the backend is switched off.                                       | TODO                |
| P6-4 | `AI_USAGE.md` human-review column completed by the humans.                                                                                      | BLOCKED(human)      |

---

## Explicitly out of scope

Smart-contract static analysis, active vulnerability probing of third-party
sites, custom contracts, tokens or auditor staking, EAS alongside Arkiv, TEE
attestation of scans, LLM-generated findings, centralized transaction
simulation services, hosted authenticated scanning (private apps are scanned
locally, with credentials that never leave the user's machine), and
full reproducible-build verification. The reasoning is in
[ENGINEERING_LOG.md](./ENGINEERING_LOG.md) (2026-11-06 assessment).
