# Methodology

## What a scan is

`igris scan <url>` loads the page in headless Chromium with a mock wallet
("Igris Canary Wallet") injected before any page script runs. The wallet
exposes a **canary**: a fresh throwaway address generated for this scan only
(its private key lives in the scanner process, signs `personal_sign`/typed
data on request, and is never logged or written anywhere).

Because the canary never existed before the scan, **any captured request that
contains it — in any decodable form — is a provable leak**: there is no other
way the destination could know that string.

## Two phases, one timeline

- **Phase A (pre-connect)**: load the page, settle, record everything. This
  is the _IP-exposure baseline_: what every visitor leaks to third parties
  before touching a wallet (the third party learns IP + "visits this dapp").
- **Phase B (post-connect)**: click a connect control (heuristics below),
  select our provider, settle, scroll once for lazy loads. Everything is
  tagged with its phase; "third parties contacted" is reported per phase even
  when no address is seen.

## When a scan is (not) scored

- **Page never loaded** (network error, timeout, an HTTP ≥ 400 main
  document such as a 404 or a bot wall, or an aborted scan): status
  `page-load-failed`, coverage `none`, **score `null`**, empty ledger. The
  CLI exits 2 and `igris publish` refuses the report. Before report 1.1.0
  such scans scored 100 — a claim about a page nobody saw.
- **Wallet never connected**: status `wallet-connect-failed`, coverage
  `pre-connect-only`. The score is real but covers only phase A; post-connect
  address leaks were **not tested**, and every surface says so.
- **Both phases ran**: status `completed`, coverage `full`.

## Security headers

CSP, CSP-Report-Only, HSTS and X-Frame-Options are read from the **main
document's final response** (after redirects) during phase A. They are
response headers; reading them from request headers (as versions before
1.1.0 did) reported them missing on every site. If no main-document
response was observed, the report omits them ("unknown"), never "missing".
They are informational and do not affect the privacy score.

## Network egress (hosted scans)

The local CLI reaches whatever the scanning machine can (needed to scan
localhost and dev builds). A hosted scanner must not: its scans run with
`egress: public-only`, which forces **all** Chromium traffic through an
in-process proxy that resolves each hostname once, refuses non-public
addresses (loopback, RFC 1918, link-local/cloud metadata, CGNAT, multicast,
reserved, IPv4-embedded IPv6 forms) and ports other than 80/443, and then
connects to the checked IP, so there is no DNS-rebinding window. Loopback is
not bypassed, QUIC is disabled, and WebRTC may not use non-proxied UDP.
Refused requests never left the scanner, so they are neither leaks nor
third-party contacts; they are listed in the report's notes.

## From capture to findings (Report v2)

Captured traffic is never published. Three detectors turn it into findings,
each backed by redacted, content-addressed evidence
([CONTRACTS.md](./CONTRACTS.md)):

- **canary-leak** (privacy): one finding per (phase, location, method, host,
  path, encoding). Severity depends on the recipient class: analytics,
  error-monitoring, support-chat and unknown third parties are high; RPC,
  relay, CDN and gateway recipients are medium; hashed forms rank one level
  lower; partial forms are low and `possible`; storage and first-party
  observations are info.
- **ip-exposure** (privacy): one finding per third-party registrable domain
  (low; Anon-RPC contacts are info and never counted).
- **security-headers** (security, never scored): CSP missing (medium) or
  report-only (low); framing allowed (medium); HSTS missing on https (low);
  plain HTTP on a non-local host (high). It always records a summary
  observation with the document-headers evidence.

Finding ids derive from what was observed, not from the canary or timing,
so the same behaviour has the same id on every scan and every scanner node.

## What we capture

All HTTP requests (failed/aborted and `keepalive`/sendBeacon included: URL,
method, headers, body up to 512 KiB), response `Set-Cookie` headers,
WebSocket frames, cookies at each phase end, and localStorage/sessionStorage
entries containing the canary (reported as "persisted locally", unscored).
**Service workers are disabled** (`serviceWorkers: 'block'`) so their
requests cannot bypass capture — at the cost of scanning the non-SW code
path of apps that require one.

## Canary encodings we detect

One module owns the list
([packages/core/src/encodings.ts](../packages/core/src/encodings.ts)):
checksummed / lower / upper / arbitrary mixed case, with and without `0x`,
URL-encoded, ABI 32-byte left-padded (calldata and event topics, with/without
`0x`), base64 and base64url (padded and unpadded) of the textual forms and of
the raw 20/32 bytes, inside JSON-RPC batch bodies, keccak256 and sha256 of
the lowercase and checksummed forms (hex and base64) flagged separately as
**"hashed, still linkable"**, and truncated display forms (first 6 + last 4)
flagged **"partial, low confidence"** and excluded from the score. Only
exact, decoded matches count as leaks.

## Wallet behaviour

EIP-1193 + EIP-6963 (name "Igris Canary Wallet", rdns `network.igris.canary`).
Supports accounts/chain methods, permissions, `personal_sign` and
`eth_signTypedData_v4`: **it signs any such request with the scan's
throwaway key** (generated per scan, never funded, discarded afterwards), so
sign-in flows complete and their traffic is observed. A signature can only
ever authorise something for an empty address. It **rejects
`eth_sendTransaction`, `eth_signTransaction`, `eth_sendRawTransaction` and
`eth_sign` with code 4001** — a scanner never moves funds or signs raw
hashes. Read
calls the dapp routes through the wallet go to a Node-side stub (zero
balance, fixed block) and **nothing is sent to any network** — a scan cannot
leak the canary from the scanner's own IP. `--live-reads <url>` opts into
real forwarding. Wallet-routed reads are reported as "reads via wallet": the
best case (the wallet chooses the RPC), no penalty.

### The `isMetaMask` spoof (trade-off, default ON)

Many dapps only offer "MetaMask" as an injected option. With
`--spoof-metamask` (default) the canary wallet also claims `isMetaMask =
true` so those dapps connect. Trade-off: a dapp could behave differently for
MetaMask than for unknown wallets, so what we measure is the MetaMask code
path. `--no-spoof-metamask` scans as an honest unknown wallet.

## Connecting the wallet (connect engine, scanner 0.3.0)

1. **Open the connect UI.** Interactive controls are scored strictly by
   whole accessible name ("Connect Wallet", "Connect", "Log in" / "Sign in",
   …); navigating links are never eligible. After one click the engine waits
   for a known kit modal (RainbowKit, ConnectKit, AppKit, Privy, Dynamic —
   markers verified live) or for a dialog that appeared after the click and
   offers a wallet choice (custom modals such as Uniswap's). Dialogs that
   were already open before the click (cookie or consent banners) are never
   searched.
2. **Choose the wallet inside that dialog only**, never page-wide: our
   EIP-6963 entry by rdns test id or exact name "Igris Canary Wallet"; else
   at most two "reveal the list" steps ("Continue with a wallet", "Other
   wallets", …); else an exact generic entry ("Browser Wallet", "Injected",
   "MetaMask"). Rules and live evidence:
   [packages/scanner/src/connect/choice.ts](../packages/scanner/src/connect/choice.ts).
3. **Connected means the dApp's main frame called `eth_requestAccounts`**
   (calls from iframes or popups do not count).
4. **Sign-in confirmation.** If the dialog then shows an exact "Sign" /
   "Sign message" / "Verify" button (SIWE), the engine clicks it once, as a
   user would; the canary key signs the message (see Wallet behaviour).
5. A change of origin at any step aborts with `unexpected-navigation`. Every
   step, its result and its duration is recorded in `scan.connection`
   (Report 2.1.0), with a failure category when it did not connect. There is
   no fallback to page-wide clicking: the legacy heuristic clicked marketing
   text on relay.link ("…powering Phantom, MetaMask…").

Recipe files (recipes/README.md) remain supported for flows the engine
cannot handle (terms gates, multi-step onboarding).

## Recipient classification

1. First party: the target's registrable domain, the domain the target
   redirected to (stated in `scan.notes`), and `--first-party` entries.
2. `data/third-parties.json`: exact host or registrable domain, then suffix
   rules. Every entry cites a source. Wallet connection / login SDK backends
   (Privy, Dynamic, the Reown AppKit API, …) are `wallet-sdk` (report
   2.2.0).
3. **RPC by behaviour**: an unknown registrable domain becomes
   `rpc-provider` only if **every** request the page sent to any of its
   hosts is a pure Ethereum JSON-RPC 2.0 call (`eth_` / `net_` / `web3_`
   methods; batches must contain nothing else; WebSocket messages count;
   body-less OPTIONS/HEAD are ignored). One GET, tracking POST or mixed batch
   disqualifies the whole domain, so a tracker cannot soften its own leak by
   also answering an RPC call. The report notes each such domain and the
   methods that qualified it.
4. Otherwise `unknown-third-party`.

## `usesAnonRpc` detection

Anon-RPC's anonymized traffic deliberately has no stable wire signature
(KPS peers are raw ip:port:certhash over WebRTC). The documented, reliable
signal is the harness's single **bootstrap read**: an `eth_call` through the
page's EIP-1193 provider — our wallet during a scan — whose calldata starts
with the `workerHash()`/`workerResolvers()` selectors (anon-rpc spec v0.4.0
§4). We match those selectors on wallet-routed calls. We do not claim to see
the anonymized traffic itself. See [ANON_RPC_NOTES.md](./ANON_RPC_NOTES.md).

## False-negative risks (what a 100 does NOT prove)

- **Server-side forwarding**: the first party can share the address with
  anyone invisibly. We only see the browser's traffic.
- **Obfuscated or encrypted exfiltration**: a custom encoding, XOR, or E2E
  encryption of the payload defeats substring detection (we detect the
  catalogued encodings only). Base64 of a _larger_ document containing the
  address is alignment-dependent and generally missed.
- **WalletConnect-relayed flows**: pairing with a remote wallet routes data
  through the relay; we scan the injected-wallet path.
- **Interaction depth**: we click one connect flow and scroll once. Leaks
  behind deeper flows (trading, bridging, KYC forms) need recipes.
- **Timing**: anything sent after our dwell window is missed.
- **Fingerprinting**: IP-exposure counts contacts; we do not detect
  fingerprinting scripts' behaviour.

## Determinism

Findings are deduplicated by (phase, location, method, host, path, encoding)
and sorted before IDs are assigned; the e2e suite scans the fixture twice and
asserts identical finding sets. Timestamps are the only nondeterministic
report field.

## Ethics

Scan only public pages. One scan = one page load + one connect attempt — no
crawling, no load generation (be mindful with `--dwell` loops). The mock
wallet never signs transactions, never holds funds, and the canary is
worthless by construction. Igris finds what a dapp _sends_, it never probes
or exploits the dapp itself. Scan results are attestations tied to our
scanner address; anyone can reproduce a scan to dispute us.
