# STATUS

Last updated: 2026-11-07. Plan and history: [docs/ROADMAP.md](docs/ROADMAP.md),
[docs/ENGINEERING_LOG.md](docs/ENGINEERING_LOG.md).

## Where we are

- **One product, one flow** (owner direction, 2026-11-06): search a site →
  latest report + version history + Retest, or "Scan this site" → live scan →
  visual report (no score) → published on Arkiv; a retest publishes the next
  version linked to the previous one. The CLI, patcher, old viewer,
  extension and scripts were removed.
- **Report 3.0.0** (no score; verdicts, timeline, RPC inventory) and the
  **Arkiv entities** `igris.scan.v2` / `igris.evidence.v1` /
  `igris.flow.v1` are implemented and **live on Rabdi**, but still
  **proposed** — waiting on the owner's approval of
  [docs/design/REPORT-3.0.0.md](docs/design/REPORT-3.0.0.md) and
  [docs/design/FLOW.md](docs/design/FLOW.md) before they are hash-pinned.
- **Live on Arkiv:** scanner `0x36DfF990206FfF8e8BA91f38A0b111418C985Bbe`
  published `app.uniswap.org` v1 → v2 → v3 (version chain verified) and
  `swap.cow.fi` v1; reads verify every report against its entity.
- **Open scan requests and two scanner nodes** (owner direction "Options
  1 + 2", 2026-11-07; [docs/design/SCAN-NETWORK.md](docs/design/SCAN-NETWORK.md)):
  "Scan this site" creates an `igris.request.v1` on Arkiv; every node's
  worker answers open requests; the site page groups scans of one request
  into a round and shows per-third-party agreement. **Live:** two requests
  for `app.ens.domains`, each answered by Scanner 1
  (`0x36DfF990206FfF8e8BA91f38A0b111418C985Bbe`) and Scanner 2
  (`0xc11870c95Ffc869872e4CBB9d9F6FBC71aF7b869`) — 7/7 and 9/9 agree. Both
  nodes run on the author's machine.
- **Wallet-request audit** ([docs/design/WALLET-REQUESTS.md](docs/design/WALLET-REQUESTS.md)):
  what a site asks the wallet to sign (SIWE for another domain, unlimited
  Permit/Permit2, `eth_sign`, approvals, wrong chain, pre-connect), decoded
  into the report and published as `igris.walletreq.v1`. Verified offline
  (fixture e2e); no live write yet, because no scanned real site has asked
  for a signature.
- **Scanner 0.4.1**: connect controls are named without icon-font text;
  app.ens.domains' "Connect" button was missed by 0.4.0 ("CONNECT login").

## How to run and verify

See README → "Run it". Checks:

```bash
pnpm lint && pnpm format:check && pnpm build
pnpm test        # unit: core, scanner, registry, api, app
pnpm test:e2e    # browser: scanner fixtures + website zero-third-party test
```

## Not done / unverified

1. Owner approval of Report 3.0.0, evidence v4 and the Arkiv entity
   schemas, including `igris.request.v1` and `igris.walletreq.v1` (then pin).
2. Chromium sandbox in the container image (ROADMAP P4-6) — required before
   a public deployment; the backend has no authentication yet.
3. A second scanner on another machine, run by someone else (both nodes
   run on one machine today), and a demo video (P6-3).
4. A live `igris.walletreq.v1` write: needs the wallet-requests fixture
   hosted publicly, or a real site that asks for a signature.
5. Arkiv's anonymous query budget is small: the organisers' query in the
   README needs an access key.
