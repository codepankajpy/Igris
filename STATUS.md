# STATUS

Last updated: 2026-11-06 (M1 done, M2 in progress)

## Environment

- Network access: **YES** — verified 2026-11-06: `https://docs.arkiv.network` → HTTP 200, `https://ethereum.github.io/anon-rpc/` → HTTP 200.
- Node v25.8.2 (>=20 OK), pnpm 9.15.9 (installed via npm; corepack unavailable on this host).
- **The repo checkout at /Volumes/Igris is an SMB network share** and far too slow for
  node_modules (a pnpm install did not finish in 20+ minutes; locally it takes 7s). Development
  happens in a fast local clone that pushes back to /Volumes/Igris (configured with
  `receive.denyCurrentBranch=updateInstead`) after every commit. To resume: clone /Volumes/Igris
  to any local directory and work there.

## Milestones

| Milestone | Status | Time spent |
| --- | --- | --- |
| M0 scaffold | **done** — `pnpm install && pnpm lint && pnpm test` passes | ~1.5h |
| M1 core | **done** — 70 unit tests over encodings/detect/classify/scoring/db | ~1.5h |
| M2 scanner | in progress | |
| M3 CLI | not started | |
| M4 patcher | not started | |
| M5 Arkiv + viewer | not started | |
| M6 stretch | not started | |
| M7 docs + demo | not started | |

## Assumptions

- Offline fixture hostnames use the RFC 6761-reserved `.test` TLD, resolved to 127.0.0.1 via a
  Chromium `--host-resolver-rules` flag; tldts returns null for `.test`, so the classifier falls
  back to "last two labels" as the registrable domain for such hosts.
- `usesAnonRpc` is detected from the harness's bootstrap `eth_call` (workerHash()/
  workerResolvers() selectors) routed through our mock wallet — per anon-rpc spec v0.4.0 the
  anonymized traffic itself has no stable wire signature (see docs/ANON_RPC_NOTES.md).
- Scoring weights are heuristics; rationale documented in packages/core/src/weights.ts and
  docs/SCORING.md (M3).
- The patcher will default to the Nym specifier (real anonymization, no required config);
  tor-js needs a user-supplied gateway, passthrough anonymizes nothing.

## UNVERIFIED

- Real Arkiv testnet publish (needs a funded key — TODO(human); offline/local registry is the
  tested path).
- Live Anon-RPC round-trip in a real browser (harness is browser-only; offline e2e proves
  absence-of-RPC-leak + bootstrap detection instead).

## How to resume

1. Clone /Volumes/Igris to a local directory (`git clone /Volumes/Igris igris && cd igris`).
2. `pnpm install && pnpm lint && pnpm test` — should pass.
3. Read docs/PLAN.md for the design; this table for where work stopped; the milestone's
   definition-of-done command is in docs/PLAN.md.
4. Push commits back with `git push origin main` (the share accepts pushes to the checked-out
   branch via updateInstead).
