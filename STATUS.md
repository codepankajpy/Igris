# STATUS

Last updated: 2026-11-06 (M0–M7 done; polish/review pass in progress)

## Environment

- Network access: **YES** — verified 2026-11-06: `https://docs.arkiv.network`
  → HTTP 200, `https://ethereum.github.io/anon-rpc/` → HTTP 200. Live Arkiv
  reads against the public Rabdi RPC also verified (empty result set — no
  entities published yet).
- Node v25.8.2 (>=20 OK), pnpm 9.15.9 (installed via npm; corepack
  unavailable on this host).
- **The checkout at /Volumes/Igris is an SMB network share** and far too slow
  for node_modules (an install didn't finish in 20+ minutes there; 7s on
  local disk). Development used a fast local clone pushing back to
  /Volumes/Igris after every commit (`receive.denyCurrentBranch=
  updateInstead`). To resume: clone to a local directory and work there.
  Leftover: `/Volumes/Igris/.trash-node_modules` (a dead partial install) is
  gitignored and should be deleted by a human — automated deletion at the
  drive root is blocked on this machine.

## Milestones

| Milestone | Status | Definition-of-done |
| --- | --- | --- |
| M0 scaffold | **done** | `pnpm install && pnpm lint && pnpm test` ✅ |
| M1 core | **done** | 70 core unit tests incl. per-encoding, false-positive, dedup, ledger ✅ |
| M2 scanner | **done** | `pnpm --filter @igris/scanner test:e2e` offline, 22 tests incl. determinism ✅ |
| M3 CLI | **done** | leaky scan `--fail-under 90` exits 1; fixed exits 0 (cli.e2e.ts + demo) ✅ |
| M4 patcher | **done** | fix prints expected diff; `--write` ×2 → empty diff; rescan proof on viem+ethers+wagmi ✅ |
| M5 Arkiv+viewer | **done** (publish 🟡) | local publish/query round-trip ✅; viewer renders + zero-network e2e ✅; live Arkiv READ verified ✅; live publish needs funded key 🟡 |
| M6 stretch | **done** | batch scan ✅ verified; CI gate ✅ verified; extension stub 🟡 untested in a real browser (honest README) |
| M7 docs+demo | **done** | `pnpm demo` offline in ~21s warm / <2 min cold, regenerates examples/ ✅ |

## Assumptions (all documented in the named files)

- `.test`-TLD fixture hosts resolved via `--host-resolver-rules`; tldts
  fallback for non-ICANN TLDs (classify.ts).
- `usesAnonRpc` = harness bootstrap `eth_call` selectors via the mock wallet
  (docs/ANON_RPC_NOTES.md) — anonymized traffic itself is signature-free.
- Patcher defaults to the Nym specifier; tor-js needs user gateways;
  passthrough anonymizes nothing (shim comments).
- Scoring weights are heuristics (docs/SCORING.md, weights.ts).
- 30-day Arkiv expiry (arkiv/schema.md).
- Wallet hands dapps a checksummed address; case variants all count as exact.

## UNVERIFIED (exact repro for a human)

1. **Real Arkiv publish** — a scanner key is ALREADY GENERATED in the
   gitignored `.env` at the repo root (address
   `0xDbd0309b80f71E12d45Ac8321DBA637156a4198B`, unfunded, never used).
   Human steps (~2 min): fund that address at
   https://hub.arkiv.network/faucet, then run
   `pnpm igris publish examples/leaky/report.json && pnpm igris publish examples/fixed/report.json`
   and `pnpm igris query --scanner 0xDbd0309b80f71E12d45Ac8321DBA637156a4198B`.
   Then paste the address into README ("Registry" section) and into
   `DEFAULT_PINNED` in apps/web/src/main.ts.
2. **Live Anon-RPC round-trip** — browser-only harness: serve a patched dapp
   (`fixtures/leaky-dapp-fixed` via `pnpm --filter
   @igris/fixture-leaky-dapp-fixed dev`) in a real browser with a real wallet
   on mainnet and watch the Nym worker bootstrap (18 MB bundle, seconds).
3. **Extension in a real browser** — extension/README.md steps.
4. **GitHub Actions green** — .github/workflows/ci.yml is written but this
   repo hasn't been pushed to GitHub from here.

## Time spent (wall clock, approx.)

M0+research 1.5h · M1 1.5h · M2 2h · M3 1h · M4 1h · M5 1.5h · M6+M7 1.5h —
well inside budget; remaining time goes to adversarial review + polish.

## How to resume

1. Clone /Volumes/Igris to a local directory; `pnpm install && pnpm exec
   playwright install chromium chromium-headless-shell`.
2. `pnpm lint && pnpm test && pnpm --filter @igris/scanner test:e2e && pnpm
   demo` — all should pass (they did at the last commit here).
3. Read this table + SUBMISSION_CHECKLIST.md for what's left (mostly
   TODO(human) items above); docs/PLAN.md has the design.
4. Push commits back with `git push origin main`.
