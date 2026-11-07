# IGRIS

**Open privacy reports for dApps — who learns your wallet address, and when.**

Paste a dApp's URL. IGRIS opens it in an isolated browser, connects a
throwaway wallet the way a real user would, records every request, and
shows — with charts and evidence, never a score — which third parties
received your wallet address, your IP, your RPC calls, and what the site
asked your wallet to sign. Every report is published on **Arkiv**, versioned,
and re-verifiable by anyone.

> Built at ETHGlobal for the **Ethereum Foundation CROPS** track (lead
> property: _Privacy_ — "a tool that shows what an app leaks: RPC calls,
> trackers, metadata") and **Arkiv — Build on Arkiv**.

## What a report shows

- **Who received the wallet address** (exact, or in any of 14+ encodings;
  hashed forms flagged separately) and **when**, on a timeline of the visit.
- **Who learned the visitor's IP** before and after connecting the wallet.
- **Every RPC endpoint** the page called, with each JSON-RPC method, its
  count, and whether the address travelled with it.
- **What the site asked the wallet to sign**: sign-in messages (and whether
  they name another site), unlimited Permit / Permit2 approvals, `eth_sign`
  blind signatures, `approve` / `setApprovalForAll`, requests naming the
  wrong chain or arriving before connecting.
- **Trackers, cookies, storage and security headers** of the page.
- A **verdict for every third party** — _expected_ (the app needs it),
  _avoidable_ (the app works without it), _tracking_ (profiles visitors) or
  _unidentified_ — each with its rule, its reason and content-addressed
  evidence.

## The flow

1. **Search a site.** If it was scanned before, IGRIS shows its latest
   report and full version history, with a **Retest** button; otherwise
   **Scan this site**.
2. **Watch the scan live**: isolated Chromium, egress limited to public
   addresses, a fresh throwaway wallet per scan.
3. **Read the report**: timeline, traffic chart, address flow, RPC
   inventory, wallet requests, findings and evidence.
4. **It is on Arkiv**: one atomic, signed batch per scan. A retest publishes
   version _n + 1_ linked to version _n_, so a site's privacy history lives
   on-chain, not on our server. Every version links to the Arkiv explorer.

## How it works

```
website (apps/app) ──► backend (apps/api) ──► scanner (packages/scanner)  isolated Chromium,
   Preact, same-origin      │                                             canary wallet,
   only, zero third-party   │                                             egress public-only
   requests                 ├──► core (packages/core)      detectors, verdicts, timeline,
                            │                              RPC inventory, Report 3.0.0
                            └──► registry (packages/registry) ──► Arkiv: igris.scan.v2
                                                                         igris.evidence.v1
                                                                         igris.flow.v1
                                                                         igris.walletreq.v1
```

| Path                | What it is                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/app`          | The website (Preact + Vite). Talks only to its own backend; makes zero third-party requests (enforced by e2e). |
| `apps/api`          | Backend: validates the URL, runs scan jobs, publishes to Arkiv, verifies reads; can also serve the website.    |
| `packages/scanner`  | Playwright scanner: canary EIP-1193/6963 wallet, connect engine, traffic capture, egress-filtering proxy.      |
| `packages/core`     | Detectors, verdicts, timeline, RPC inventory, wallet-request decoder, report and evidence contracts.           |
| `packages/registry` | Site registry on Arkiv (and an offline local registry with the same behaviour); scanner identity.              |
| `fixtures/`         | Offline test dApps used by the end-to-end tests.                                                               |
| `data/`             | Third-party database (domain → class) used for verdicts.                                                       |
| `arkiv/`            | Arkiv bounty docs: why Arkiv, how we use it, schema, reach, friction log.                                      |
| `docs/`             | Methodology, contracts and design specs (Report 3.0.0, flow, wallet requests).                                 |

## Where the blockchain is used

- **Ethereum, inside every scan.** The throwaway wallet is a real
  EIP-1193 / EIP-6963 provider backed by a fresh secp256k1 key. dApps
  discover it like MetaMask, request its accounts, read chain state through
  it (answered by a local stub, so the scanner itself leaks nothing) and ask
  it to sign sign-in messages. Every request is searched for that address;
  JSON-RPC traffic is inventoried per endpoint; hosts that only answer
  Ethereum JSON-RPC are recognised as RPC providers by their traffic; Anon-RPC
  usage is detected.
- **Arkiv, as the registry nobody operates.** Each completed scan is
  published as one atomic batch signed by the scanner's key: the full report
  (`igris.scan.v2`, with `version` and a `previous` pointer to the prior
  version), the evidence bundle (`igris.evidence.v1`) and one entity per
  third party (`igris.flow.v1`) and one per decoded wallet request
  (`igris.walletreq.v1`). Any IGRIS instance can render and re-verify any
  report from Arkiv alone; flows answer "which other sites send data to this
  tracker?" and wallet requests answer "which sites ask for unlimited
  Permit2 approvals?".
- **Why entities, not a smart contract.** Arkiv has no EVM contracts
  ("contract creation is disabled" on its executor), and a browser scan
  cannot run on-chain anyway: a contract could only store what an off-chain
  scanner tells it. What the chain gives IGRIS is a public, signed,
  `readonly` record — attributed to the scanner's immutable `$creator` —
  that nobody, including IGRIS, can edit or withhold, queryable by anyone
  without an indexer.

## Live on Arkiv (Rabdi, chain 7794095)

- Publishing scanner: **`0x36DfF990206FfF8e8BA91f38A0b111418C985Bbe`**
- `app.uniswap.org` v1 → v2 → v3, each `previous` pointing to the version
  before: transactions `0xce45a3811bc4eeb47600ec69d44299df96f358a8443cdf456c0b18b250e21343`,
  `0x96198c7a1cefd357713ca4ae65d6a07430d46c603b9ab464d662f5f39d6d9f79`,
  `0x2d68c4ec115958d491fd42cb3ec04d8173efe3d2478fc078d9e1480edc819919`.
- `swap.cow.fi` v1 (tx `0xad0435ac…`, 32 flow entities).
- `app.ens.domains` v1 (tx `0xbe59fd6c7d7529a896a8d3ae6075c9012b10c628356e58abc89756f5aa1eeb32`)
  and v3 (tx `0x6f99a814d588321e4e90196fb4edebb6f3c9b5673081c2a86a56fab54765c4a9`).
  Versions 2 and 4 were published by a second test key during an experiment
  that was later removed; IGRIS trusts one scanner, so they are not shown.

### Why these sites

They are real, popular dApps where a user connects a wallet — exactly where
an address leak matters — and each one demonstrates something different:

- **Uniswap** (`app.uniswap.org`) — the most used DEX front-end. Scanned
  three times to show **version history on Arkiv**: each retest is a new
  entity whose `previous` points at the last, and the report shows what
  changed (here: the same finding set each time).
- **CoW Swap** (`swap.cow.fi`) — a DEX aggregator with many third parties.
  It shows the **leak picture**: after connecting, the wallet address reached
  spindl.link, google.com and sentry.io (tracking / unidentified) and
  alchemy.com plus the WalletConnect RPC (avoidable); 32 `igris.flow.v1`
  entities make "who else sends data to sentry.io?" one query.
- **ENS** (`app.ens.domains`) — the name service. v1 could not connect (our
  scanner misread its icon-font "Connect" button); the fix (scanner 0.4.1)
  made v3 connect, and it found the **full wallet address sent to
  `bigname.sh` (unidentified) and `drpc.live` (an RPC provider)**, plus
  cloudflareinsights.com (tracking) and intercom.io (avoidable) loaded on
  every visit.

A query anyone can run (an access key from hub.arkiv.network is needed; the
anonymous budget is small) — every version of a site:

```bash
curl -s "https://rpc.rabdi.db-chain.testnet.arkiv.network/$ARKIV_ACCESS_KEY" \
  -H 'content-type: application/json' --data \
  '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('"'"'igris.scan.v2'"'"') AND hostname = str('"'"'app.uniswap.org'"'"') AND $creator = addr(0x36DfF990206FfF8e8BA91f38A0b111418C985Bbe)",{"select":{"key":true,"owner":true,"attributes":true},"limit":"0x10"}]}'
```

Other queries (same call, different first parameter):

- every site that sent data to one recipient:
  `arkiv.schema = str('igris.flow.v1') AND recipient = str('sentry.io') AND $creator = addr(0x36DfF990206FfF8e8BA91f38A0b111418C985Bbe)`
- sites that asked for an unlimited token approval:
  `arkiv.schema = str('igris.walletreq.v1') AND unlimited = i32(1) AND $creator = addr(0x36DfF990206FfF8e8BA91f38A0b111418C985Bbe)`

Always filter or check `$creator`: anyone can create entities with these
attributes, and IGRIS trusts only the scanners it is configured with.

## CROPS — how IGRIS meets each property

Lead property: **Privacy** — IGRIS exists to show, with evidence, what a
dApp leaks about its users. Each line was checked against the code on branch
`mvp-web-app`.

- **C — Censorship resistance.** Reports live on Arkiv, signed by the
  scanner that measured them, not on a server we run. Anyone can run this
  repository (website + backend) and read every published report and its
  history; if our instance disappears or refuses a site, another instance
  shows the same data and can scan and publish under its own key. Readers
  choose which publishers to trust (`IGRIS_TRUSTED_SCANNERS`). Arkiv's
  testnet itself is outside our control: if it is down or reset, the local
  registry mode keeps the flow working offline.
- **O — Open source.** MIT ([LICENSE](LICENSE)). Builds and runs from this
  repository alone (`pnpm install`, plus a Chromium download from
  Playwright's CDN); no secrets are needed to run it locally.
- **P — Privacy.** What each party learns:
  - _the website's visitor_ talks only to the backend that served the page:
    the website makes **zero third-party requests** (self-hosted fonts, no
    analytics), enforced by `apps/app/e2e/no-third-party.e2e.ts`;
  - _the backend_ learns which sites a visitor searches and scans (and their
    IP); it stores scan jobs and a cache of reports in `.igris-data/`, logs
    no client IPs, and keeps rate-limit keys as salted hashes in memory;
  - _the scanned site and its third parties_ learn a throwaway address
    (never a real user's), the backend machine's IP and a headless-Chromium
    fingerprint — scanning is a visit;
  - _RPC providers_ learn nothing from the scanner: wallet reads are
    answered locally;
  - _Arkiv_ learns the backend's IP on reads and writes, and everything
    published is public by design: reports (with the scan's throwaway
    address), redacted evidence (the canary is never in it), flows and
    decoded wallet requests — never anything about the visitor.
- **S — Security.** The canary key is generated per scan, never funded and
  discarded; the canary wallet signs `personal_sign` / typed-data requests
  (so sign-in flows complete) and rejects every transaction and `eth_sign`.
  The publishing key lives only in `~/.igris` on the backend machine (0600,
  node-bound, never read from environment variables); the Arkiv access key
  lives in the gitignored `.env.arkiv`. Scans are egress-filtered to public
  addresses (no SSRF into the operator's network), one scan per site at a
  time, rate-limited. Every report and evidence bundle is re-verified on
  every read (hashes against the Arkiv entity, schema, integrity — verdicts
  are recomputed), and once more in the visitor's browser. Trust
  assumptions: a published report is an attestation by the address that
  created it (`$creator`, which never changes — not `$owner`, which anyone
  can set to any address by transferring an entity they created); a report covers what a browser can observe (server-side sharing
  is invisible). Chromium's own OS sandbox is opt-in
  (`IGRIS_CHROMIUM_SANDBOX=1`, for hosts that allow it — not
  Railway/Render), and the backend has no login by design (anyone may scan,
  within its rate limits).

## Run it locally

Requirements: Node ≥ 20, pnpm 9, ~2 GB free RAM for Chromium.

```bash
pnpm install
pnpm exec playwright install chromium chromium-headless-shell
pnpm --filter @igris/api dev     # backend + scanner on :3001
pnpm --filter @igris/app dev     # website on http://localhost:5180
```

Without a scanner key the backend uses a **local registry**
(`.igris-data/registry.json`) with the same behaviour, so everything works
offline.

### Publish to Arkiv (Rabdi testnet)

```bash
pnpm scanner:init primary        # creates this node's key in ~/.igris (0600); prints its address
```

Fund the printed address at https://hub.arkiv.network/faucet, then put your
Arkiv access key in `.env.arkiv` at the repository root (gitignored — never
commit it):

```
ARKIV_ACCESS_KEY=<your key from hub.arkiv.network>
```

Restart the backend: it now publishes every scan to Arkiv.

### Tests

```bash
pnpm lint && pnpm format:check && pnpm build
pnpm test        # unit: core, scanner, registry, api, app
pnpm test:e2e    # browser: scanner fixtures + the website's zero-third-party test
```

## Deploy: website on Vercel, backend on Railway

The website is a static Vite build; the backend (scanner + Arkiv publisher)
needs a long-running container with Chromium. The website calls the backend
directly at a URL fixed at build time (`VITE_IGRIS_API_URL`); the backend
allows that origin with CORS (`IGRIS_ALLOWED_ORIGINS`). Visitors' browsers
talk to exactly two origins, both IGRIS's: the website and its backend.

### 1. Backend on Railway

1. **New project → Deploy from GitHub repo** (this repository). Railway
   reads `railway.json` and builds `apps/api/Dockerfile` from the repository
   root (health check `/api/health`).
2. **Add a volume** mounted at **`/data`** (keeps the scanner key, node
   identity and job cache across deploys).
3. **Variables:**

   | Variable                 | Value                                                                                    |
   | ------------------------ | ---------------------------------------------------------------------------------------- |
   | `ARKIV_ACCESS_KEY`       | your key from hub.arkiv.network (secret)                                                 |
   | `IGRIS_ALLOWED_ORIGINS`  | your Vercel URL, e.g. `https://igris.vercel.app` (comma-separate several)                |
   | `IGRIS_TRUST_PROXY`      | `1` (Railway's proxy; rate limits then see the real client)                              |
   | `IGRIS_STATIC_DIR`       | `off` (the website is on Vercel)                                                         |
   | `IGRIS_TRUSTED_SCANNERS` | optional: `0x36DfF990206FfF8e8BA91f38A0b111418C985Bbe` to also show the existing history |

4. **Settings → Networking → Generate Domain** → e.g.
   `https://igris-api.up.railway.app`. Check `…/api/health` → `{"ok":true}`.
5. **Create the scanner key on the server** (it never leaves that machine):

   ```bash
   railway ssh
   node --conditions=igris-dist packages/registry/dist/bin/init-scanner.js primary
   ```

   Fund the printed address at https://hub.arkiv.network/faucet and
   redeploy. `…/api/registry` now shows `"mode":"arkiv","ready":true`.
   Without a key the backend still works with a local registry on the
   volume.

### 2. Website on Vercel

1. **Add New → Project → import this repository.**
2. **Root Directory: `apps/app`** (Vercel reads `apps/app/vercel.json`:
   Vite, `pnpm install` from the workspace, `pnpm build`, output `dist`).
3. **Environment variable:** `VITE_IGRIS_API_URL` = your Railway URL from
   step 1.4 (no trailing slash). It is baked in at build time: redeploy
   after changing it.
4. Deploy, then put the Vercel URL into Railway's `IGRIS_ALLOWED_ORIGINS`
   (step 1.3) if you had not yet.
5. **Wallet-request demo:** the build also publishes a test page at
   `/demo/wallet-requests/` that asks a wallet for a sign-in to another
   site, an unlimited Permit2 approval on the wrong chain and an unlimited
   `approve` (synthetic, keyless token and spender — nothing real can be
   approved). Scan it through the API (the search box scans a site's home
   page, so pass the page URL):

   ```bash
   curl -X POST https://<railway-domain>/api/sites/<vercel-domain>/scans \
     -H 'content-type: application/json' \
     -d '{"url":"https://<vercel-domain>/demo/wallet-requests/"}'
   ```

   Then open `<vercel-domain>` on IGRIS: the report's "What the site asked
   your wallet to do" section is filled in, and the scan published
   `igris.walletreq.v1` entities to Arkiv.

### One container instead

The same image can also serve the website itself (same origin, no CORS,
no Vercel):

```bash
docker build -f apps/api/Dockerfile -t igris .
docker run -d --name igris -p 3001:3001 -v igris-data:/data igris   # http://localhost:3001
docker exec -it igris node --conditions=igris-dist packages/registry/dist/bin/init-scanner.js primary
docker restart igris   # after funding the address; pass -e ARKIV_ACCESS_KEY=… on docker run
```

`render.yaml` deploys this variant on Render (disk at `/data`).

### Hardening options

- **Chromium OS sandbox**: `IGRIS_CHROMIUM_SANDBOX=1` runs each scan's
  browser inside Chromium's own sandbox. It needs a host that allows it
  (`docker run --cap-add=SYS_ADMIN …` or a Chrome seccomp profile); on
  Railway/Render it cannot start, and the scan then fails instead of running
  unsandboxed. Without it, scans are still isolated by the container,
  public-only egress filtering and a fresh browser profile per scan.
- The backend has **no login by design** — anyone may scan any site — and
  is protected by per-client rate limits, a bounded queue, a per-scan
  timeout and SSRF-safe URL validation. Every setting is in
  [`.env.example`](.env.example).

## Limitations

A site whose page never loads is not published (nothing was observed). A
scan whose wallet never connected is labelled partial: address leaks after
connecting were not tested. "No address leak observed" means nothing
detectable, not nothing wrong: server-side forwarding, encrypted
exfiltration, WalletConnect-relayed flows and deep interaction paths are out
of scope ([docs/METHODOLOGY.md](docs/METHODOLOGY.md)). Arkiv entities expire
after 180 days; a site's history older than that disappears unless retested.

## Docs

- Arkiv: [why Arkiv](arkiv/why-arkiv.md) · [how we use it](arkiv/how-you-use-arkiv.md) ·
  [schema and organiser queries](arkiv/schema.md) · [reach](arkiv/reach.md) ·
  [friction log](arkiv/friction.md)
- Design: [the flow](docs/design/FLOW.md) · [Report 3.0.0](docs/design/REPORT-3.0.0.md) ·
  [wallet requests](docs/design/WALLET-REQUESTS.md)
- [Methodology](docs/METHODOLOGY.md) · [contracts](docs/CONTRACTS.md)

## License

MIT — [LICENSE](LICENSE).
