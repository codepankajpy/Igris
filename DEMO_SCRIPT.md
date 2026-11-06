# 3-minute demo script

Prep (before going on stage): `pnpm install`, `pnpm exec playwright install
chromium chromium-headless-shell`, run `pnpm demo` once (warms the fixture
builds), keep two terminals and a browser tab on `apps/web` (`pnpm --filter
@igris/web dev`) with `examples/snapshot.json` copied to
`apps/web/public/snapshot.json`.

## 0:00 — the problem (talk over a terminal)

"When you open a dapp, who learns your wallet address? Not on-chain — in the
browser. Igris proves it: our scanner's wallet exposes a throwaway canary
address; anything that ships it to a third party is a provable leak."

## 0:20 — live leak list

```bash
pnpm demo
```

Narrate while it runs (~30–60s): "Headless Chromium, mock wallet, two phases:
before connect — that's pure IP exposure — and after. Watch the leaky
fixture: the address goes to an RPC provider, an analytics beacon — plain AND
base64 — an error monitor's breadcrumb, and a tracking pixel URL."

Point at the printed table the moment it appears.

## 1:20 — the fix

```bash
head -40 examples/diff.patch
```

"`igris fix` rewrites viem, ethers and wagmi transports to the Ethereum
Foundation's Anon-RPC — hash-pinned worker, sandboxed, the RPC provider now
sees an exit node instead of your users. Same RPC URL, one dependency, and
the rescan you just saw: zero RPC leaks, `usesAnonRpc: true`. The leftover
score is the analytics junk we deliberately planted — Igris doesn't pretend
to fix what it didn't."

## 2:00 — the registry (browser)

Open the viewer: filters (min score, leak class, Anon-RPC), click the leaky
dapp → detail page with every finding and the score ledger. "Every entity is
an Arkiv attestation signed by a scanner wallet with a 30-day expiry — stale
privacy claims die by construction. You pin scanners you trust; independent
scanners agreeing is visible. No backend of ours anywhere: this page is
static and talks only to the Arkiv endpoint YOU configure — or to a local
snapshot, which is what you're seeing."

## 2:40 — close

"Scan in CI with `--fail-under`, fail PRs that add a leak class, fix with one
command, publish proof. Lighthouse for dapp privacy. Igris."

## Fallback if the Rabdi testnet is down

Nothing on the critical path touches it: `pnpm demo`, the viewer (snapshot
mode) and all tests are fully offline. If asked about live Arkiv, show
`arkiv/how-you-use-arkiv.md` + the `igris query` table from the local
registry, and say plainly that the testnet was down.

## Fallback if `pnpm demo` won't run on stage

`examples/` holds the committed outputs of the last run: open
`examples/leaky/report.html` and `examples/fixed/report.html` side by side,
then `examples/diff.patch`.
