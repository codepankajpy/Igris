# Wallet-request audit (design)

Status: approved direction (owner, 2026-11-07: "Options 1 + 2"); schemas
pinned after review. Shared types: `packages/core/src/contracts/wallet-request.ts`.

## Why

A devtools session shows raw traffic. It does not show **what a dApp asks
your wallet to sign** — the moment real users lose funds or identity:
unlimited Permit/Permit2 approvals, sign-in messages for another site, raw
`eth_sign` blind signatures, approvals hidden in transactions. IGRIS's canary
wallet sees every request; until now it signed or rejected them silently.

## Capture (packages/scanner)

- `wallet-init.ts` reports every call of a `RECORDED_WALLET_METHODS` method to
  a new binding `__igrisWalletRequest(method, paramsJSON, outcome, id, nonce)`
  **before and after** it acts (outcome after: `answered` | `signed` |
  `rejected` | `error`). The binding records `frame` (`main` when
  `source.frame === page.mainFrame()` of the scan page, else `iframe`) and
  the frame's origin.
- `TrafficRecorder` stores `Capture.walletRequests` (`CapturedWalletRequest`,
  with phase and `t`), capped at 500. Params are capped at 64 KiB each.
- Behaviour of the canary wallet is unchanged (it still signs
  `personal_sign` / typed data and rejects transactions and `eth_sign`).
- **Reports are page-controlled, so the recorder trusts as little as it can:**
  - `nonce`: a per-scan secret generated Node-side (`TrafficRecorder.walletNonce`,
    16 random bytes) and injected into the init script's config. It lives
    only in the wallet's closure (never on `window`); the bindings are
    captured when the wallet is installed (Playwright installs bindings
    before init scripts), so a page that replaces them later never receives
    it. Reports without it are ignored.
  - Outcomes: only what the canary can produce per method is accepted —
    transactions / `eth_sign` → `rejected`; `personal_sign` /
    `eth_signTypedData*` → `signed` | `error`; everything else → `answered` |
    `error`. Anything else is ignored (a page-forged `signed` for a rejected
    `eth_sendTransaction` is never recorded). `signed` is never taken from
    the page: the Node-side signer records it.
  - Signing: `__igrisSign(kind, params, id, nonce)` signs only when the
    calling frame has a pending request `id` of exactly that method, recorded
    with the nonce and not completed or signed yet; otherwise it refuses and
    nothing is signed. The init script waits until the `pending` report is
    recorded before asking for the signature. So no canary signature exists
    that is not in `walletRequests` (requests past the 500 cap are still
    tracked for this, just not stored).

## Decode (packages/core, pure, offline)

`decodeWalletRequest(captured, ctx) → WalletRequestEvidence` where ctx = {
canary forms, page origin / hostname, connected chain id, scan time,
whether accounts were requested before this request }.

- `eth_requestAccounts`, `wallet_requestPermissions` → `connect`;
  `wallet_switchEthereumChain` → `switch-chain` (chainId = target);
  `wallet_addEthereumChain` → `add-chain`; `wallet_watchAsset` → `watch-asset`.
- `personal_sign` (`[message, address]`, either order tolerated): decode hex
  to UTF-8; EIP-4361 (`<domain> wants you to sign in with your Ethereum
account:` …, `URI:`, `Chain ID:`) → `siwe` with `siweDomain`, `chainId`,
  `domainMismatch` (see _SIWE domain / URI rule_ below); readable text →
  `personal-message`; non-printable bytes → `blind-hash`. Hex of any length
  is decoded as UTF-8: a 32-byte payload is a blind hash only when it does
  not decode to printable text (`0x` + hex of "Please sign this message
  today!!" is a readable 32-byte message → `personal-message`). 64 hex
  characters without `0x` are treated as a hash.
- **SIWE domain / URI rule** (as implemented, `siweDomainMismatch`): the
  page is the calling frame's origin (the scanned page's origin when the
  frame is opaque, e.g. `about:blank`). Hosts are related when equal, or
  when one is a subdomain of the other within the same registrable domain
  (`www.x.org` ~ `x.org` ~ `app.x.org`; siblings `a.x.org` / `b.x.org` are
  not related; a public suffix such as `co.uk` never matches). Mismatch when
  the SIWE `domain`'s host (userinfo, port and IPv6 brackets stripped) is
  not related to the page host, **or** the `URI:` is an http(s) URL whose
  host is not related to the page host. Scheme and port are ignored on both
  sides (`http://x.org:8080` vs `https://x.org` is no mismatch); a non-http(s)
  or unparsable URI is not compared.
- `eth_sign` → `eth-sign`.
- `eth_signTypedData*` (`[address, json]` or `[json, address]`): parse the
  typed data. Permit2 (`verifyingContract` = `PERMIT2_ADDRESS`, or
  `primaryType` ∈ PermitSingle / PermitBatch / PermitTransferFrom /
  PermitBatchTransferFrom / PermitWitnessTransferFrom) → `permit2` with token,
  amount, spender, deadline/expiration. **PermitBatch rule:** batches report
  `token`, `amount` and `deadline` (the allowance `expiration`) of the FIRST
  entry only; the flags look at every entry — `unlimited` if ANY entry's
  amount is unlimited, `longDeadline` if ANY entry's expiration is long
  (PermitBatch `details[]`). SignatureTransfer batches have one message
  `deadline`. EIP-2612 (`primaryType` = Permit with
  owner/spender/value/nonce/deadline) → `permit` (token = verifyingContract).
  Anything else → `typed-data`. `chainId` = domain.chainId;
  `chainIdMismatch` = chainId ≠ the wallet's chain at that moment.
- Transactions (`eth_sendTransaction` / `eth_signTransaction`): selector
  `0x095ea7b3` approve(spender, amount) → `approve` (token = `to`);
  `0xa22cb465` setApprovalForAll(operator, true) → `set-approval-for-all`
  (spender = operator, token = `to`, `unlimited` = true); else
  `transaction`. `eth_sendRawTransaction` → `transaction`.
- `unlimited`: amount ≥ 2^160 − 1 or ≥ 2^255 (covers MAX_UINT256 / MAX_UINT160).
  `longDeadline`: deadline > scan time + 30 days.
- Every address is checksummed; the canary never appears in an evidence
  item (owner fields are dropped; `paramsDigest` hashes params with the
  canary replaced by `<CANARY>`). The engine's canary-free assertion covers
  the new item type.

## Findings (detector `wallet-requests` 1.0.0, domain **security**)

Never part of recipients/verdicts. One finding per request that matches:

| when                                              | kind        | severity | title (example)                                                |
| ------------------------------------------------- | ----------- | -------- | -------------------------------------------------------------- |
| `eth-sign`                                        | risk        | high     | Asked the wallet to eth_sign raw data (a blind signature)      |
| `blind-hash`                                      | risk        | medium   | Asked to sign an unreadable hash with personal_sign            |
| `permit`/`permit2` + unlimited                    | risk        | high     | Asked for an unlimited token permit to 0xSpend…er              |
| `permit`/`permit2` + longDeadline (not unlimited) | risk        | medium   | Token permit valid for more than 30 days                       |
| `approve` unlimited / `set-approval-for-all`      | risk        | high     | Asked to approve unlimited spending / all NFTs                 |
| `siwe` + domainMismatch                           | risk        | high     | Sign-in message is for a different site (evil.example)         |
| any + chainIdMismatch                             | risk        | medium   | Signature request names chain N while the wallet is on chain M |
| permit/permit2/approve/typed-data **preConnect**  | risk        | medium   | Asked for a signature before connecting                        |
| `siwe` (clean) / `personal-message`               | observation | info     | Asked to sign in with Ethereum / sign a message                |

Fingerprint identity: `{ method, kind, verifyingContract, spender, token,
flags }` (stable across scans of the same behaviour; never the canary).
Remediation text explains the risk in plain words.

## Contracts

- Evidence bundle **igris.evidence.v4** = v3 + item type `wallet-request`
  (`WalletRequestEvidence`, additionalProperties false, every field typed,
  addresses `^0x[0-9a-fA-F]{40}$`, decimal strings `^[0-9]{1,78}$`). v1–v3
  pins untouched.
- Report **3.0.0** (still proposed) gains required `walletRequests:
WalletRequestSummary[] | null` (null for migrated reports) and pairs with
  evidence v4. Integrity: every summary's `evidenceId` resolves to a
  `wallet-request` item; findingIds exist.
- **Draft 3.0.0 reports** (published before `walletRequests` existed: no
  `walletRequests` key, `evidence.bundleVersion` = `igris.evidence.v3`):
  `@igris/core` exports `isDraftReportV3(report, bundle?)` (shape check; the
  bundle is optional so a reader can decide before fetching it) and
  `upgradeDraftReportV3(report, bundle)`. The registry and API call them only
  AFTER the stored bytes were verified against their published hashes; the
  upgrade re-checks the bundle against the report's own `evidence.sha256`,
  re-labels it `igris.evidence.v4` (items and ids unchanged), sets
  `walletRequests: null`, appends a note, and schema-validates and
  integrity-verifies the result (throws `MigrationError` otherwise).
  `migrateToCurrent` does the same.

## Arkiv: `igris.walletreq.v1` (one per request except `connect`, same batch)

`hostname`, `kind`, `method`, `outcome` (str, indexed), `unlimited`,
`chainIdMismatch`, `domainMismatch`, `preConnect` (i32 0/1 indexed — booleans
as integers so they can be filtered), `verifyingContract`, `spender` (str
indexed, "" when none), `version` (i32), `scanId` (str indexed), `scannedAt`
(u64 indexed). Readonly, same expiry as the scan. Organiser query:
`arkiv.schema = str('igris.walletreq.v1') AND unlimited = i32(1) AND $creator = addr(<scanner>)`.

## Website

Report section **"What the site asked your wallet to do"**: a timeline row
per request (when, before/after connect), decoded card per request (what it
would allow, to whom, for how long, on which chain), risk flags, evidence
link. A wallet request also appears as a marker on the visit timeline.

## Fixture and demo

`fixtures/wallet-requests/` (static page, served on `*.test` in e2e): after
connect it asks for a SIWE message for another domain, an unlimited Permit2
signature naming the wrong chain, and an `approve(spender, MAX)` transaction.
Its token (`0x…bEEF`) and spender (`0x…dEaD`) are synthetic addresses with 18
leading zero bytes — never deployed, nobody holds a key — so a publicly
hosted copy can never request a real approval (only Permit2's own address,
the EIP-712 verifying contract, is real).
Real sites rarely ask for signatures during a visit; the demo uses this
fixture (hosted publicly by the owner) and says so.
