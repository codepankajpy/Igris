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
  is the *IP-exposure baseline*: what every visitor leaks to third parties
  before touching a wallet (the third party learns IP + "visits this dapp").
- **Phase B (post-connect)**: click a connect control (heuristics below),
  select our provider, settle, scroll once for lazy loads. Everything is
  tagged with its phase; "third parties contacted" is reported per phase even
  when no address is seen.

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
Supports accounts/chain methods, permissions, `personal_sign`,
`eth_signTypedData_v4`; **rejects `eth_sendTransaction` and `eth_sign` with
code 4001** — a scanner must never move funds or sign reusable blobs. Read
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

## Connect heuristics

Buttons/links matching `/connect( wallet)?|sign in|log ?in|launch app|get
started/i`, then a wallet-picker entry matching our name, "Injected",
"Browser Wallet", "Detected" or "MetaMask" — all magic strings live in
[packages/scanner/src/connect.ts](../packages/scanner/src/connect.ts) with
reasons. Harder sites use a recipe (recipes/README.md). The report
distinguishes `completed` / `wallet-connect-failed` / `page-load-failed`.

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
  catalogued encodings only). Base64 of a *larger* document containing the
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
worthless by construction. Igris finds what a dapp *sends*, it never probes
or exploits the dapp itself. Scan results are attestations tied to our
scanner address; anyone can reproduce a scan to dispute us.
