# IGRIS

**Open privacy reports for dApps — who learns your wallet address, and when.**

Search a site. If it has been scanned, IGRIS shows its latest report and its
version history; if not, one click scans it. A scan opens the site in an
isolated browser, connects a throwaway wallet the way a user would, and
records every request. The report shows — with charts and evidence, never a
score:

- **who received the wallet address** (in any of 14+ encodings, hashed forms
  flagged separately) and when;
- **who learned the visitor's IP** before and after connecting;
- **which RPC endpoints were called**, with every JSON-RPC method and count,
  and whether the address travelled with the calls;
- **trackers, cookies, storage and security headers** of the page;
- a **verdict for every third party** — _expected_ (the app needs it),
  _avoidable_ (the app works without it), _tracking_ (not needed, profiles
  visitors) or _unidentified_ — each with its rule and reason, each backed by
  content-addressed evidence.

Every report is **published on Arkiv**. A retest publishes the next version,
linked to the previous one, so a site's privacy history lives on Arkiv — not
on our server.

## Run it

Requirements: Node ≥ 20, pnpm 9.

```bash
pnpm install
pnpm exec playwright install chromium chromium-headless-shell
```

To publish on Arkiv (Rabdi testnet), once per machine:

```bash
pnpm scanner:init primary        # creates this node's publishing key in ~/.igris (0600)
```

Fund the printed address at https://hub.arkiv.network/faucet, and put your
Arkiv access key in a file `.env.arkiv` (gitignored):

```
ARKIV_ACCESS_KEY=<your key from hub.arkiv.network>
```

Then start the backend and the website:

```bash
pnpm --filter @igris/api dev     # scanner + Arkiv publisher on :3001
pnpm --filter @igris/app dev     # website on http://localhost:5180
```

Without a scanner key the backend uses a local registry file
(`.igris-data/registry.json`) with the same behaviour, so everything works
offline. Tests: `pnpm test` (unit) and `pnpm test:e2e` (browser, offline
fixtures).

## How it works

```
website (apps/app) ──► backend (apps/api) ──► scanner (packages/scanner)  isolated Chromium,
        │                     │                                          canary wallet, egress
        │                     │                                          public-only
        │                     ├──► core (packages/core)    detectors, verdicts, timeline,
        │                     │                            RPC inventory, Report 3.0.0
        │                     └──► registry (packages/registry) ──► Arkiv: igris.scan.v2,
        │                                                            igris.evidence.v1,
        └── same-origin only; never talks to Arkiv or any third party   igris.flow.v1
```

Formats: [docs/CONTRACTS.md](docs/CONTRACTS.md) ·
[docs/design/REPORT-3.0.0.md](docs/design/REPORT-3.0.0.md) ·
[docs/design/FLOW.md](docs/design/FLOW.md) · method:
[docs/METHODOLOGY.md](docs/METHODOLOGY.md) · Arkiv: [arkiv/](arkiv/).

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
  third party (`igris.flow.v1`). Any IGRIS instance can render and re-verify
  any report from Arkiv alone, and flows answer "which other sites send data
  to this tracker?".

### Live on Arkiv (Rabdi, chain 7794095)

- Publishing scanner: **`0x36DfF990206FfF8e8BA91f38A0b111418C985Bbe`**
- `app.uniswap.org` v1 → v2 → v3, each `previous` pointing to the version
  before: transactions `0xce45a3811bc4eeb47600ec69d44299df96f358a8443cdf456c0b18b250e21343`,
  `0x96198c7a1cefd357713ca4ae65d6a07430d46c603b9ab464d662f5f39d6d9f79`,
  `0x2d68c4ec115958d491fd42cb3ec04d8173efe3d2478fc078d9e1480edc819919`.

A query anyone can run (an access key from hub.arkiv.network is needed; the
anonymous budget is small) — every version of a site:

```bash
curl -s "https://rpc.rabdi.db-chain.testnet.arkiv.network/$ARKIV_ACCESS_KEY" \
  -H 'content-type: application/json' --data \
  '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('"'"'igris.scan.v2'"'"') AND hostname = str('"'"'app.uniswap.org'"'"') AND $creator = addr(0x36DfF990206FfF8e8BA91f38A0b111418C985Bbe)",{"select":{"key":true,"owner":true,"attributes":true},"limit":"0x10"}]}'
```

## CROPS

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
    address), redacted evidence (the canary is never in it) and flows.
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
  is invisible). Open gaps: Chromium runs without its own sandbox in the
  container image (ROADMAP P4-6), and the backend has no authentication
  (anyone who can reach it can start scans, within its rate limits).

## Limitations

A site whose page never loads is not published (nothing was observed). A
scan whose wallet never connected is labelled partial: address leaks after
connecting were not tested. "No address leak observed" means nothing
detectable, not nothing wrong: server-side forwarding, encrypted
exfiltration, WalletConnect-relayed flows and deep interaction paths are out
of scope ([docs/METHODOLOGY.md](docs/METHODOLOGY.md)). Arkiv entities expire
after 180 days; a site's history older than that disappears unless retested.

## License

MIT — [LICENSE](LICENSE).
