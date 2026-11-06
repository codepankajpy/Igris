# For judges: verify every claim in under 5 minutes

Setup once (from a clean clone, needs Node ≥20 and pnpm ≥9):

```bash
pnpm install && pnpm exec playwright install chromium chromium-headless-shell
```

| # | Claim | One command | Expect |
| --- | --- | --- | --- |
| 1 | The whole story works offline | `pnpm demo` | before/after table: leaky score 0 with 1 RPC leak → fixed score 17, 0 RPC leaks, `usesAnonRpc: true`; exits non-zero if any invariant breaks |
| 2 | Every planted leak is found with the right encoding and class, deterministically | `pnpm --filter @igris/scanner test:e2e` | 22 e2e tests pass (two identical scan runs, all three library variants, CLI exit codes, viewer zero-network) |
| 3 | Unit coverage of encodings/classifier/scoring/registry | `pnpm test` | 94 unit tests pass |
| 4 | CLI contract for CI | `pnpm igris scan http://x --fail-under 90` on the fixtures (see cli.e2e.ts) or read exit codes in `packages/cli/src/exit-codes.ts` | 0/1/2/3 |
| 5 | `igris fix` is real and idempotent | `pnpm igris fix fixtures/leaky-dapp` then compare with `examples/diff.patch`; `git diff --stat fixtures/leaky-dapp..` nothing — and `pnpm igris fix fixtures/leaky-dapp-fixed` | prints the viem/ethers/wagmi diff; the second command says "nothing to change" |
| 6 | The patched fixture is the committed output of the patcher | `diff -r fixtures/leaky-dapp/src fixtures/leaky-dapp-fixed/src` | only the `igris fix` changes (fetchFn, anonJsonRpcProvider, shim) |
| 7 | Arkiv integration (reads drive the viewer) | `pnpm igris query --registry local --local-file examples/registry.json --min-score 50` | returns the fixed-dapp record |
| 8 | Live Arkiv read path | `pnpm igris query --min-score 0 --limit 5` | queries the real Rabdi RPC (empty until a funded publish; errors only if the testnet is down — the local path above is the fallback) |
| 9 | Viewer phones home to nothing | `pnpm --filter @igris/scanner exec vitest run --config vitest.e2e.config.ts e2e/viewer.e2e.ts` | zero off-origin requests in snapshot mode |
| 10 | We scan ourselves | open `examples/viewer-scan/report.html` | score 98; the only third party is the (user-configurable) Arkiv RPC |
| 11 | Secrets hygiene | `git log -p \| grep -c PRIVATE_KEY` and read `.env.example` | no committed keys; canary key never logged |
| 12 | Anon-RPC claims match its docs | read `docs/ANON_RPC_NOTES.md` against https://ethereum.github.io/anon-rpc/spec/ | API quotes are verbatim from spec v0.4.0 |

To see the viewer live: `pnpm --filter @igris/web dev`, open the printed URL,
switch data source to "local snapshot" after
`cp examples/snapshot.json apps/web/public/snapshot.json` — or point it at
the Arkiv endpoint.
