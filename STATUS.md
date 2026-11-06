# STATUS

Last updated: 2026-11-06. Plan and history: [docs/ROADMAP.md](docs/ROADMAP.md),
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

## How to run and verify

See README → "Run it". Checks:

```bash
pnpm lint && pnpm format:check && pnpm build
pnpm test        # unit: core, scanner, registry, api, app
pnpm test:e2e    # browser: scanner fixtures + website zero-third-party test
```

## Not done / unverified

1. Owner approval of Report 3.0.0 and the Arkiv entity schemas (then pin).
2. Chromium sandbox in the container image (ROADMAP P4-6) — required before
   a public deployment; the backend has no authentication yet.
3. Second independent scanner node (P2-2) and a demo video (P6-3).
4. Arkiv's anonymous query budget is small: the organisers' query in the
   README needs an access key.
