# Anon-RPC integration notes

Verified against the live docs on 2026-11-06: https://ethereum.github.io/anon-rpc/ (spec
Draft v0.4.0, dated 2026-10-23), the wallet guide at /wallets/, the npm registry record for
`@anon-rpc/browser-harness` (latest **0.4.0**, published 2026-10-28), and
`adopters.json5` in github.com/ethereum/anon-rpc. Quotes below are verbatim from those sources.

## What Anon-RPC actually is

Anon-RPC is **not** a relay service or an endpoint you point requests at. It is a plugin
standard plus a browser harness: an anonymizing network (Tor, Nym, …) ships its client as a
single-file "worker" bundle identified by the keccak256 hash of its bytes; an on-chain
**specifier contract** (`IWorkerSpecifier`) publishes `workerHash()` (the trust anchor) and
advisory `workerResolvers()` (fetch locations). The harness verifies the bytes against the
pinned hash and runs them in a Web Worker inside a sandboxed null-origin iframe, then hands the
app an anonymized `fetch`. You keep using **your own RPC endpoint URLs**; the worker anonymizes
the transport.

## The exact integration API we code against

Package: `@anon-rpc/browser-harness@0.4.0` (ESM, browser-only; deps `@anon-rpc/harness-core`,
`@kpstreams/webrtc-client`, `@noble/hashes`; no peer deps). Exports `AnonRpcWorker`, `RpcError`.

```ts
import { AnonRpcWorker } from '@anon-rpc/browser-harness';

const worker = new AnonRpcWorker({
  address: '0x…', // the network's IWorkerSpecifier contract address
  config: undefined, // network-defined, opaque to the harness
  preExisting: {
    // Used ONCE, to read the specifier contract (workerHash()/workerResolvers()).
    // Any EIP-1193-style provider works. This single read is NOT anonymized.
    rpcProvider: { request: ({ method, params }) => provider.request({ method, params }) },
  },
});

// worker.fetch is this-bound and standard-fetch-shaped; calls made before
// readiness are buffered, not dropped.
const res = await worker.fetch('https://rpc.example/', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
});
```

- `worker.ready: Promise<void>` — rejects if no resolver yields bytes matching the pinned hash,
  the worker crashes, or it calls `signalFailed({ code })` (branch on `RpcError.code`, e.g.
  `"unsupported-chain"`; never parse message text).
- `worker.close()` — tears down the sandbox; construct a fresh instance to reconnect.
- Per-call: `worker.fetch(url, { …, anonOptions: { isolationKey: accountId } })` — asks that
  calls under different keys be unlinkable; support varies by network.
- One long-lived `AnonRpcWorker` per network; never construct per request.
- Strict CSP (no `'unsafe-inline'` in script-src): self-host `dist/iframe-boot.js` and pass
  `iframeUrl` (must be same-origin), or `ready` never settles.

There is **no official viem/ethers/wagmi glue**; the docs say `worker.fetch` plugs into "a viem
custom transport, an ethers FetchRequest getUrl hook, your own JSON-RPC wrapper". Our patcher
ships that glue (see packages/patcher): viem `http(url, { fetchFn: worker.fetch })`, ethers via a
`FetchRequest` whose `getUrlFunc` delegates to `worker.fetch`, wagmi through its viem transports.

## Chain support

Anonymization is **chain-agnostic transport**: `worker.fetch` takes any URL, so it can serve any
chain your RPC URL serves. The chain-specific part is where the **specifier contract** lives —
the bootstrap `rpcProvider` must answer for that chain. Deployed networks (adopters.json5):

| Network     | Specifier address                            | Specifier chain    | Notes                                                       |
| ----------- | -------------------------------------------- | ------------------ | ----------------------------------------------------------- |
| passthrough | `0x4fd77be300f31c5fe6ab266d35d27750a3478d27` | mainnet (1)        | reference only — **no anonymization**                       |
| tor-js      | `0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e` | mainnet (1)        | needs `config.gateways`; published gateway is demo-capacity |
| nym         | `0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0` | mainnet (1)        | ~18 MB bundle, seconds to bootstrap                         |
| nox         | `0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A` | Sepolia (11155111) | Sphinx mixnet demo                                          |

Our patcher defaults to **nym** (real anonymization, no required config) and makes the specifier
address configurable; this choice and its trade-offs are repeated in the generated shim's
comments.

## Threat model (what the patcher may honestly claim)

- With tor-js/nym/nox, **the RPC endpoint sees the exit/router address instead of the user's
  IP**. With passthrough, nothing is anonymized.
- The worker sits in the same position as any RPC endpoint: it "can observe, censor, or lie"
  about the RPC path. The sandbox denies it keys, cookies and the DOM; trust is pinned to the
  on-chain `workerHash()` — "the hash is the identity"; resolvers/CDNs are untrusted.
- The one bootstrap read (`workerHash()`/`workerResolvers()`) goes through the dapp's existing
  provider, is NOT anonymized, and "reveals only that you're reading a specifier contract".
- So the honest claim after `igris fix` is: _RPC reads no longer reveal the user's IP or address
  to the RPC provider; the chosen anonymizing network's exit sees the requests; the wallet (and
  anything the dapp sends elsewhere) is unchanged._ Transactions still go through the wallet.

## How we detect "already uses Anon-RPC" in a scan

Anonymized traffic deliberately has **no stable wire signature**: no fixed host, no user-agent —
KPS peers are raw `ip:port:certhash` over WebRTC. The reliable, documented signal is the
bootstrap read: one `eth_call` through the page's EIP-1193 provider (our mock wallet during a
scan) whose calldata starts with the 4-byte selector of `workerHash()` or `workerResolvers()`.
The scanner matches those selectors on wallet-routed `eth_call`s and sets `usesAnonRpc`. We do
not claim to see the anonymized traffic itself; METHODOLOGY.md lists this as a known limit.

## Friction encountered

- npmjs.com returns 403 to plain fetchers; package metadata had to come from the registry API.
- The harness is browser-only ("A native harness would be a separate package"), so the scanner
  cannot exercise an Anon-RPC round-trip offline in Node; our e2e asserts the _absence_ of RPC
  leaks in the patched fixture plus the bootstrap-selector detection, and we mark live Anon-RPC
  round-trips as requiring a manual browser run.
- Self-described "prototype-grade reference implementation of a draft spec; interfaces track the
  spec and may change" — we pin 0.4.0 exactly.
