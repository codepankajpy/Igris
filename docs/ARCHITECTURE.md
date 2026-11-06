# Architecture

```
        igris scan <url>                     igris fix <path>
              │                                    │
   ┌──────────▼──────────┐              ┌──────────▼──────────┐
   │ @igris/scanner      │              │ @igris/patcher      │
   │ Playwright Chromium │              │ ts-morph codemod    │
   │ + canary wallet     │              │ viem/ethers/wagmi → │
   │ (EIP-1193/6963)     │              │ Anon-RPC shim       │
   └──────────┬──────────┘              └─────────────────────┘
              │ capture (requests, WS, cookies, storage)
   ┌──────────▼──────────┐
   │ @igris/core         │  encodings → detector → classifier → scoring
   │ report schema v1    │  (all pure, heavily unit-tested)
   └──────────┬──────────┘
              │ report.json (+ report.html via @igris/cli)
   ┌──────────▼──────────┐     same interface      ┌───────────────────┐
   │ @igris/registry     │ ──────────────────────▶ │ LocalRegistry     │
   │ ArkivRegistry       │                         │ (JSON file)       │
   │ igris.scan.v1       │                         └───────────────────┘
   └──────────┬──────────┘
              │ arkiv_query (user-configured endpoint)
   ┌──────────▼──────────┐
   │ apps/web (static)   │  filters, detail pages, pinned scanners,
   │ + snapshot mode     │  "N scanners agree" — zero other requests
   └─────────────────────┘
```

## Packages

- **@igris/core** — pure logic, no I/O except reading third-parties.json:
  canary encoding catalogue (`encodings.ts`), detector with overlap rules
  (`detect.ts`), host classifier on tldts + data/third-parties.json
  (`classify.ts`), transparent scoring with a single weights file
  (`weights.ts`, `scoring.ts`), versioned report types + JSON Schema
  (`report.ts`), Anon-RPC bootstrap selectors (`anon-rpc.ts`).
- **@igris/scanner** — Playwright runner (`scan.ts`), injected wallet
  (`wallet-init.ts`, serialized into the page; signs Node-side), capture
  (`capture.ts`), connect heuristics (`connect.ts`), stubbed read handler
  (`stub-rpc.ts`), report assembly (`report-builder.ts`). The e2e suite
  (e2e/) runs fully offline via `--host-resolver-rules=MAP *.test 127.0.0.1`
  against fixtures/.
- **@igris/patcher** — ts-morph transforms matched by import bindings
  (`transforms.ts`), generated per-repo shim (`shim.ts`), dependency-free
  unified diff verified against `git apply` (`diff.ts`), orchestration
  (`index.ts`). Idempotent by construction (presence checks, content hashes).
- **@igris/registry** — `RegistryBackend` interface with two impls:
  `ArkivRegistry` (SDK, schema `igris.scan.v1`) and `LocalRegistry` (JSON
  file). `./browser` subpath keeps Node-only code (crypto/fs) out of the
  viewer bundle.
- **@igris/cli** — `igris` with stdlib `util.parseArgs` (no CLI framework),
  exit codes 0/1/2/3, terminal tables, self-contained HTML report.
- **apps/api** — OPTIONAL scanner node (local/Docker only for now): the same
  scanner behind a bounded job queue, hard timeouts, per-client rate limit
  and exact-origin CORS, always with `egress: public-only`. It holds no
  scanner key, stores nothing, and returns results with
  `provenance: "unpublished"`. `scan-repo` clones only
  `https://github.com/<owner>/<repo>` with a hardened git invocation and
  enforces size limits before the patcher parses anything.
- **apps/web** — vanilla-TS Vite static page; data via the registry's browser
  entry; endpoint + pinned scanners in localStorage; offline snapshot mode.
- **fixtures/** — leaky-dapp (three real RPC-library variants), its
  `igris fix --write` output (leaky-dapp-fixed, committed as proof), and the
  third-party sink (one HTTP server playing every third-party role by Host
  header).

## Production module resolution

Workspace packages export their TypeScript sources by default (vitest, tsx
and Vite consume them directly) and their compiled `dist/` under the custom
export condition `igris-dist`. Production starts with
`node --conditions=igris-dist apps/api/dist/index.js`. Before this, the
compiled API could not start at all.

## Non-obvious decisions

- **Mock wallet is serialized source** (`Function.prototype.toString`) with a
  `__name` shim, because esbuild-based runners inject helpers into transpiled
  functions; the page must run the script standalone.
- **Findings dedup before IDs** (phase/location/method/host/path/encoding) →
  deterministic reports; retrying trackers don't multiply findings.
- **Fixture hostnames use distinct registrable domains** (`igris-rpc.test`,
  `igris-analytics.test`, …) so per-domain dedup and contact caps are
  genuinely exercised.
- **e2e CLI invocations are async** — the fixture's servers live in the test
  process; a sync spawn would starve them (documented in cli.e2e.ts).
- **No CLI/arg/table/diff dependencies** — stdlib `parseArgs`, hand-rolled
  table and unified diff (the diff is validated against `git apply` in CI).
