# STATUS

Last updated: 2026-11-06. The authoritative plan, with acceptance criteria
and per-item status, is [docs/ROADMAP.md](docs/ROADMAP.md). Decisions and
verification notes are in [docs/ENGINEERING_LOG.md](docs/ENGINEERING_LOG.md).

## Where we are

- **M0–M7 (original build):** scanner, core, patcher, CLI, registry, viewer,
  demo. Done at commit `b915636`.
- **P0 Integrity:** PASS on branch `p0-integrity` (all 12 criteria; see
  ROADMAP.md).
- **P0.5 Foundations:** next.

## How to verify (clean clone, Node ≥ 20, pnpm 9)

```bash
pnpm install && pnpm exec playwright install chromium chromium-headless-shell
pnpm lint && pnpm format:check && pnpm -r build
pnpm test        # unit: core, patcher, scanner, registry, cli, api
pnpm test:e2e    # offline browser e2e (fixtures on *.test via host-resolver rules)
pnpm demo        # offline end-to-end story, regenerates examples/
```

## BLOCKED (needs a human action)

1. **Real Arkiv publish** (ROADMAP P2-1): fund a scanner key at
   https://hub.arkiv.network/faucet. A key was generated into the gitignored
   `.env` by an earlier AI session. It has never been funded or used. Per-node
   keys with scanner profiles arrive in P0.5 (P05-6), so prefer generating a
   fresh key per node then rather than reusing that one.
2. **Second independent scanner node** (P2-2): the second Mac, with its own key.

## Docker (verified 2026-11-06)

```bash
docker build -f apps/api/Dockerfile -t igris-api .
docker run --rm -p 3001:3001 igris-api
curl localhost:3001/api/health
```

## UNVERIFIED (not yet demonstrated)

1. **Live Anon-RPC round-trip** in a real browser (P4-3).
2. **Extension loaded as an MV3 extension** in a real browser. The popup's
   rendering logic is e2e-tested with a stubbed `chrome` API; loading it is not.
3. **GitHub Actions green.** There is no remote, so CI has never run on GitHub.

## Environment notes

- Node v26, pnpm 9.15.9, macOS.
- `.trash-node_modules/` is a dead partial install from an earlier network
  share checkout (gitignored). It is safe for a human to delete.
