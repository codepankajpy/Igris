# Discovery report

Source: `corpus/discovery/discovery-2026-11-06.json, corpus/discovery/diagnose-2026-11-06.json` (scripts/corpus-discover.ts). 57 candidates, one page load and one strictly-scored click each, canary wallet injected, nothing signed. Observed 2026-11-06T14:28:59.618Z – 2026-11-06T14:42:01.641Z.

A kit is **confirmed** only when its own connect modal was observed live (fingerprint confidence `high`). SDK presence without an observed modal is listed separately as **unconfirmed** and is never counted as identification.

## Primary classification

| class | count |
| --- | --- |
| kit unidentified | 21 |
| kit identified (confirmed live) | 14 |
| connect UI unavailable | 12 |
| bot-blocked | 6 |
| unavailable (HTTP error) | 3 |
| unavailable (DNS/network) | 1 |

| candidate | class | detail |
| --- | --- | --- |
| https://www.rainbowkit.com/ | kit identified (confirmed live) | modal-opened; clicked "Connect Wallet"; rainbowkit/high |
| https://demo.privy.io/ | kit identified (confirmed live) | no-connect-control; privy/high |
| https://lab.reown.com/appkit?name=ethers | kit identified (confirmed live) | modal-opened; clicked "Connect Wallet"; appkit/high |
| https://app.aave.com/ | kit identified (confirmed live) | modal-opened; clicked "Connect Wallet"; connectkit/high |
| https://app.spark.fi/ | kit identified (confirmed live) | modal-opened; clicked "Connect Wallet"; appkit/high |
| https://app.morpho.org/ | connect UI unavailable | click-failed; clicked "Connect"; appkit/medium |
| https://app.compound.finance/ | connect UI unavailable | no-connect-control; appkit/medium |
| https://app.sky.money/ | kit unidentified | modal-not-opened; clicked "Connect Wallet" |
| https://app.ethena.fi/ | kit identified (confirmed live) | modal-opened; clicked "Connect Wallet"; appkit/high |
| https://app.pendle.finance/ | kit identified (confirmed live) | modal-opened; clicked "Connect Wallet"; appkit/high |
| https://stake.lido.fi/ | kit unidentified | modal-not-opened; clicked "Connect wallet" |
| https://app.ether.fi/ | unavailable (HTTP error) | main document returned HTTP 500 |
| https://app.renzoprotocol.com/ | kit unidentified | modal-not-opened; clicked "Connect Wallet" |
| https://app.gearbox.fi/ | kit identified (confirmed live) | modal-opened; clicked "Connect Wallet"; rainbowkit/high |
| https://summer.fi/ | kit unidentified | modal-not-opened; clicked "Connect wallet" |
| https://app.defisaver.com/ | kit unidentified | modal-not-opened; clicked "Connect" |
| https://yearn.fi/ | connect UI unavailable | no-connect-control |
| https://app.euler.finance/ | bot-blocked | bot-protection interstitial (cf-mitigated: challenge, HTTP 403) |
| https://app.eigenlayer.xyz/ | unavailable (HTTP error) | main document returned HTTP 500 |
| https://balancer.fi/ | unavailable (HTTP error) | main document returned HTTP 403 |
| https://app.uniswap.org/ | kit unidentified | modal-not-opened; clicked "Connect"; privy/low |
| https://swap.cow.fi/ | kit identified (confirmed live) | modal-opened; clicked "Connect wallet"; appkit/high |
| https://curve.fi/ | kit unidentified | modal-not-opened; clicked "CONNECT WALLET" |
| https://velodrome.finance/ | kit unidentified | modal-not-opened; clicked "Connect" |
| https://aerodrome.finance/ | kit unidentified | modal-not-opened; clicked "Connect" |
| https://app.1inch.io/ | kit unidentified | modal-not-opened; clicked "Connect wallet" |
| https://matcha.xyz/ | kit identified (confirmed live) | modal-opened; clicked "Connect Wallet"; privy/high |
| https://app.hyperliquid.xyz/ | kit unidentified | modal-not-opened; clicked "Connect"; privy/low |
| https://jumper.exchange/ | connect UI unavailable | click-failed; clicked "Connect wallet"; privy/low |
| https://app.across.to/ | kit unidentified | modal-not-opened; clicked "CONNECT WALLET" |
| https://superbridge.app/ | kit unidentified | modal-not-opened; clicked "Connect wallet" |
| https://www.bungee.exchange/ | kit identified (confirmed live) | modal-opened; clicked "Sign in"; dynamic/high |
| https://portal.zksync.io/ | connect UI unavailable | click-failed; clicked "Connect wallet"; appkit/medium |
| https://bridge.arbitrum.io/ | bot-blocked | bot-protection interstitial (cf-mitigated: challenge, HTTP 403) |
| https://stargate.finance/ | kit unidentified | modal-not-opened; clicked "Connect Wallet"; privy/low |
| https://zora.co/ | kit identified (confirmed live) | modal-opened; clicked "Login"; privy/high |
| https://opensea.io/ | kit unidentified | modal-not-opened; clicked "Sign in"; privy/low |
| https://rarible.com/ | kit identified (confirmed live) | modal-opened; clicked "Login"; privy/high |
| https://manifold.xyz/ | connect UI unavailable | no-connect-control; appkit/medium |
| https://highlight.xyz/ | kit unidentified | modal-not-opened; clicked "Sign in" |
| https://magiceden.io/ | bot-blocked | bot-protection interstitial (cf-mitigated: challenge, HTTP 403) |
| https://app.ens.domains/ | connect UI unavailable | no-connect-control |
| https://guild.xyz/ | kit unidentified | modal-not-opened; clicked "Sign in" |
| https://layer3.xyz/ | bot-blocked | bot-protection interstitial (title "Attention Required! \| Cloudflare", HTTP 403) |
| https://snapshot.box/ | kit unidentified | modal-not-opened; clicked "Log in" |
| https://www.tally.xyz/ | connect UI unavailable | no-connect-control |
| https://nouns.wtf/ | connect UI unavailable | no-connect-control |
| https://hey.xyz/ | kit unidentified | modal-not-opened; clicked "Login" |
| https://app.galxe.com/ | connect UI unavailable | no-connect-control |
| https://app.zerion.io/ | bot-blocked | bot-protection interstitial (title "Just a moment...", HTTP 200) |
| https://portfolio.metamask.io/ | connect UI unavailable | click-failed; clicked "CONNECT" |
| https://debank.com/ | kit unidentified | modal-not-opened; clicked "Connect Wallet"; appkit/medium |
| https://zapper.xyz/ | bot-blocked | bot-protection interstitial (cf-mitigated: challenge, HTTP 403) |
| https://polymarket.com/ | kit unidentified | modal-not-opened; clicked "Log in" |
| https://app.virtuals.io/ | kit identified (confirmed live) | modal-opened; clicked "Login"; privy/high |
| https://linea.build/ | connect UI unavailable | no-connect-control |
| https://app.safe.global/ | unavailable (DNS/network) | navigation timeout: TimeoutError: page.goto: Timeout 30000ms exceeded.
Call log:
  - navigating to "https://app.safe.global/", waiting until "domcontentloaded"
 |

## Confirmed kits (verified live)

| kit | URL | connect control (strategy) | static signals | modal signals | confidence | observed |
| --- | --- | --- | --- | --- | --- | --- |
| rainbowkit | https://www.rainbowkit.com/ | "Connect Wallet" (strict scoring: Connect Wallet (100)) | rainbowkit:modal:#rk_connect_title<br>rainbowkit:modal:[data-testid^="rk-wallet-option-"]<br>rainbowkit:static:[data-testid="rk-connect-button"] | rainbowkit:modal:#rk_connect_title<br>rainbowkit:modal:[data-testid^="rk-wallet-option-"] | high | 2026-11-06T14:28:59.618Z |
| privy | https://demo.privy.io/ | "null" (strict scoring: ) | privy:modal:#privy-modal-content<br>privy:network:host:*.privy.io<br>privy:static:iframe[src*="auth.privy.io"] | privy:modal:#privy-modal-content | high | 2026-11-06T14:29:06.116Z |
| appkit | https://lab.reown.com/appkit?name=ethers | "Connect Wallet" (strict scoring: Connect Wallet (100)) | appkit:static:customElements:appkit-modal,w3m-modal,appkit-button,w3m-button | appkit:modal:wui-list-wallet (visible) | high | 2026-11-06T14:29:19.361Z |
| connectkit | https://app.aave.com/ | "Connect Wallet" (strict scoring: Connect Wallet (100)) | connectkit:network:host:app.family.co | connectkit:modal:#__CONNECTKIT__ [role="dialog"]<br>connectkit:modal:[data-connectkit] | high | 2026-11-06T14:29:30.711Z |
| appkit | https://app.spark.fi/ | "Connect Wallet" (strict scoring: Connect Wallet (100)) | appkit:static:customElements:appkit-modal,w3m-modal,appkit-button,w3m-button | appkit:modal:wui-list-wallet (visible) | high | 2026-11-06T14:29:36.274Z |
| appkit | https://app.ethena.fi/ | "Connect Wallet" (strict scoring: Connect Wallet (100)) | appkit:static:customElements:appkit-modal,w3m-modal,appkit-button,w3m-button | appkit:modal:wui-list-wallet (visible) | high | 2026-11-06T14:30:35.634Z |
| appkit | https://app.pendle.finance/ | "Connect Wallet" (strict scoring: Connect Wallet (100)) | appkit:static:customElements:appkit-modal,w3m-modal,appkit-button,w3m-button | appkit:modal:wui-list-wallet (visible) | high | 2026-11-06T14:30:42.793Z |
| rainbowkit | https://app.gearbox.fi/ | "Connect Wallet" (strict scoring: Connect Wallet (100)) | — | rainbowkit:modal:#rk_connect_title<br>rainbowkit:modal:[data-testid^="rk-wallet-option-"] | high | 2026-11-06T14:31:35.413Z |
| appkit | https://swap.cow.fi/ | "Connect wallet" (strict scoring: Connect wallet (100)) | appkit:static:customElements:appkit-modal,w3m-modal,appkit-button,w3m-button | appkit:modal:wui-list-wallet (visible) | high | 2026-11-06T14:33:16.781Z |
| privy | https://matcha.xyz/ | "Connect Wallet" (strict scoring: Connect Wallet (100)) | privy:network:host:*.privy.io<br>privy:static:iframe[src*="auth.privy.io"] | privy:modal:#privy-modal-content | high | 2026-11-06T14:34:54.828Z |
| dynamic | https://www.bungee.exchange/ | "Sign in" (strict scoring: Sign in (80)) | dynamic:network:host:*.dynamicauth.com<br>dynamic:static:div.dynamic-shadow-dom | dynamic:modal:[data-testid="dynamic-auth-modal-heading"] | high | 2026-11-06T14:36:07.609Z |
| privy | https://zora.co/ | "Login" (strict scoring: Login (80)) | appkit:static:customElements:appkit-modal,w3m-modal,appkit-button,w3m-button | privy:modal:#privy-modal-content | high | 2026-11-06T14:37:06.105Z |
| privy | https://rarible.com/ | "Login" (strict scoring: Login (80)) | privy:network:host:*.privy.io<br>privy:static:iframe[src*="auth.privy.io"] | privy:modal:#privy-modal-content | high | 2026-11-06T14:37:43.384Z |
| privy | https://app.virtuals.io/ | "Login" (strict scoring: Login (80)) | privy:network:host:*.privy.io<br>privy:static:iframe[src*="auth.privy.io"] | privy:modal:#privy-modal-content | high | 2026-11-06T14:41:46.528Z |

## Unconfirmed: kit SDK signals without an observed kit modal

These are assumptions, not identifications. Typical causes: the connect control is not a strict-scoring match, the site uses its own modal on top of an SDK, or a multi-step flow.

| URL | static fingerprint | after click | why unconfirmed |
| --- | --- | --- | --- |
| https://app.morpho.org/ | appkit/medium | click-failed → appkit/medium | click failed: TimeoutError: elementHandle.click: Timeout 5000ms exceeded.
Call log:
  - attempting click action
    2 ×  |
| https://app.compound.finance/ | appkit/medium | no-connect-control → appkit/medium | no eligible connect control (strict scoring) |
| https://app.uniswap.org/ | privy/low | modal-not-opened → privy/low | no wallet-kit modal within 10000 ms after clicking "Connect" |
| https://app.hyperliquid.xyz/ | privy/low | modal-not-opened → privy/low | no wallet-kit modal within 10000 ms after clicking "Connect" |
| https://jumper.exchange/ | privy/low | click-failed → privy/low | click failed: TimeoutError: elementHandle.click: Timeout 5000ms exceeded.
Call log:
  - attempting click action
    - wa |
| https://portal.zksync.io/ | appkit/medium | click-failed → appkit/medium | click failed: TimeoutError: elementHandle.click: Timeout 5000ms exceeded.
Call log:
  - attempting click action
    2 ×  |
| https://stargate.finance/ | privy/low | modal-not-opened → privy/low | no wallet-kit modal within 10000 ms after clicking "Connect Wallet" |
| https://opensea.io/ | none/none | modal-not-opened → privy/low | no wallet-kit modal within 10000 ms after clicking "Sign in" |
| https://manifold.xyz/ | appkit/medium | no-connect-control → appkit/medium | no eligible connect control (strict scoring) |
| https://debank.com/ | appkit/medium | modal-not-opened → appkit/medium | no wallet-kit modal within 10000 ms after clicking "Connect Wallet" |

## Why not identified (from the recorded inventory)

Reasons are derived mechanically from what discovery recorded before and after its single click; they are diagnoses to verify, not conclusions.

| URL | class | derived reason | modal attribution (ancestry signature) | visible after click (dialogs / wallet labels / custom tags / iframes) |
| --- | --- | --- | --- | --- |
| https://app.morpho.org/ | connect UI unavailable | a dialog without a wallet list is open: "Before you continue"; click not actionable: click failed: TimeoutError: elementHandle.click: Timeout 5000ms exceeded. | — | Before you continue / — / — / — |
| https://app.compound.finance/ | connect UI unavailable | no visible control named connect / log in / sign in | — | — / — / — / — |
| https://app.sky.money/ | kit unidentified | wallet list visible but no known-kit marker (custom or unrecognised modal): MetaMask, Igris Canary Wallet, WalletConnect | app modal built on Radix UI | Connect a wallet / MetaMask, Igris Canary Wallet, WalletConnect / — / — |
| https://stake.lido.fi/ | kit unidentified | wallet list visible but no known-kit marker (custom or unrecognised modal): MetaMask, WalletConnect | — | Connect walletI certify that I have read and accept the upda / MetaMask, WalletConnect / — / — |
| https://app.renzoprotocol.com/ | kit unidentified | a dialog without a wallet list is open: "EVM WalletSolana Wallet" | — | EVM WalletSolana Wallet / — / — / — |
| https://summer.fi/ | kit unidentified | no dialog or wallet list appeared within the bound after the click | — | — / — / — / — |
| https://app.defisaver.com/ | kit unidentified | wallet list visible but no known-kit marker (custom or unrecognised modal): MetaMask, WalletConnect, Coinbase | — | — / MetaMask, WalletConnect, Coinbase / — / — |
| https://yearn.fi/ | connect UI unavailable | no visible control named connect / log in / sign in | — | — / — / — / — |
| https://app.uniswap.org/ | kit unidentified | wallet list visible but no known-kit marker (custom or unrecognised modal): MetaMask, Igris Canary Wallet, WalletConnect, Coinbase Wallet | app-specific modal (Uniswap) | — / MetaMask, Igris Canary Wallet, WalletConnect, Coinbase Wallet / — / privy.app.uniswap.org |
| https://curve.fi/ | kit unidentified | wallet list visible but no known-kit marker (custom or unrecognised modal): Browser Wallet, Igris Canary Wallet, WalletConnect, MetaMask, Coinbase Wallet | app modal built on MUI | Connect WalletBrowser WalletIgris Canary WalletWalletConnect / Browser Wallet, Igris Canary Wallet, WalletConnect, MetaMask, Coinbase Wallet / — / — |
| https://velodrome.finance/ | kit unidentified | no dialog or wallet list appeared within the bound after the click | — | — / — / — / — |
| https://aerodrome.finance/ | kit unidentified | no dialog or wallet list appeared within the bound after the click | — | — / — / — / — |
| https://app.1inch.io/ | kit unidentified | wallet list visible but no known-kit marker (custom or unrecognised modal): Igris Canary Wallet, MetaMask | app modal built on Angular CDK | — / Igris Canary Wallet, MetaMask / app-root, app-shell, app-header, oi-header-dropdown, oi-svg-icon, oi-account-box-button-slot, oi-notification-bell, oi-overlay-menu, oi-content-panel, oi-page-swap, |
| https://app.hyperliquid.xyz/ | kit unidentified | wallet list visible but no known-kit marker (custom or unrecognised modal): Igris Canary Wallet, MetaMask, WalletConnect, Coinbase Wallet | app modal built with styled-components | — / Igris Canary Wallet, MetaMask, WalletConnect, Coinbase Wallet / — / auth.privy.io, h20qtjygwppc.statuspage.io |
| https://jumper.exchange/ | connect UI unavailable | click not actionable: click failed: TimeoutError: elementHandle.click: Timeout 5000ms exceeded. | — | — / — / — / — |
| https://app.across.to/ | kit unidentified | wallet list visible but no known-kit marker (custom or unrecognised modal): Igris Canary Wallet, MetaMask, Coinbase Wallet, WalletConnect, Phantom, Coinbase | app-specific dropdown (Across) | — / Igris Canary Wallet, MetaMask, Coinbase Wallet, WalletConnect, Phantom, Coinbase / — / — |
| https://superbridge.app/ | kit unidentified | wallet list visible but no known-kit marker (custom or unrecognised modal): WalletConnect, MetaMask, Igris Canary Wallet | app-specific modal (Superbridge widget) | Connect a wallet / WalletConnect, MetaMask, Igris Canary Wallet / number-flow-react / — |
| https://portal.zksync.io/ | connect UI unavailable | a dialog without a wallet list is open: "ZKsync Bridge is live on beta Nothing on this website should"; click not actionable: click failed: TimeoutError: elementHandle.click: Timeout 5000ms exceeded. | — | ZKsync Bridge is live on beta Nothing on this website should / — / — / verify.walletconnect.com |
| https://stargate.finance/ | kit unidentified | wallet list visible but no known-kit marker (custom or unrecognised modal): Coinbase Smart Wallet, MetaMask, Igris Canary Wallet, WalletConnect, Phantom | app modal built on Radix UI | Account / Coinbase Smart Wallet, MetaMask, Igris Canary Wallet, WalletConnect, Phantom / — / — |
| https://opensea.io/ | kit unidentified | wallet list visible but no known-kit marker (custom or unrecognised modal): MetaMask, Igris Canary Wallet | app modal built on Radix UI | Connect with OpenSeaMetaMaskInstalledIgris Canary WalletInst / MetaMask, Igris Canary Wallet / number-flow-react / wallet.opensea.io |
| https://manifold.xyz/ | connect UI unavailable | no visible control named connect / log in / sign in | — | — / — / — / — |
| https://highlight.xyz/ | kit unidentified | wallet list visible but no known-kit marker (custom or unrecognised modal): Coinbase Wallet, Igris Canary Wallet, MetaMask | app modal built on Radix UI | Log in or sign up / Coinbase Wallet, Igris Canary Wallet, MetaMask / — / — |
| https://app.ens.domains/ | connect UI unavailable | scorer rejected plausible control(s): "CONNECT login" | — | — / Phantom, MetaMask, Rainbow / — / — |
| https://guild.xyz/ | kit unidentified | wallet list visible but no known-kit marker (custom or unrecognised modal): Igris Canary Wallet | app modal built on Radix UI | First time? / Igris Canary Wallet / — / — |
| https://snapshot.box/ | kit unidentified | wallet list visible but no known-kit marker (custom or unrecognised modal): Igris Canary Wallet, MetaMask, WalletConnect, Coinbase | app modal built with Vue | — / Igris Canary Wallet, MetaMask, WalletConnect, Coinbase / — / — |
| https://www.tally.xyz/ | connect UI unavailable | no visible control named connect / log in / sign in | — | — / — / — / — |
| https://nouns.wtf/ | connect UI unavailable | no visible control named connect / log in / sign in | — | — / — / — / www.youtube.com, nounspot.com |
| https://hey.xyz/ | kit unidentified | wallet list visible but no known-kit marker (custom or unrecognised modal): Igris Canary Wallet, MetaMask | app modal built on Headless UI | Login / Igris Canary Wallet, MetaMask / — / www.youtube-nocookie.com |
| https://app.galxe.com/ | connect UI unavailable | no visible control named connect / log in / sign in | — | — / — / — / — |
| https://portfolio.metamask.io/ | connect UI unavailable | a dialog without a wallet list is open: "Help us improve MetaMaskWe'd like to gather basic usage and "; click not actionable: click failed: TimeoutError: elementHandle.click: Timeout 5000ms exceeded. | — | Help us improve MetaMaskWe'd like to gather basic usage and  / — / — / — |
| https://debank.com/ | kit unidentified | wallet list visible but no known-kit marker (custom or unrecognised modal): Igris Canary Wallet, MetaMask, Coinbase Wallet, Phantom, Rabby Wallet, Rainbow, Trust Wallet | RabbyKit (a different wallet kit, out of P1 scope) | We use cookies to improve your experience.Privacy PolicyReje / Igris Canary Wallet, MetaMask, Coinbase Wallet, Phantom, Rabby Wallet, Rainbow, Trust Wallet / — / — |
| https://polymarket.com/ | kit unidentified | a dialog without a wallet list is open: "Authentication" | — | Authentication / — / — / auth.magic.link |
| https://linea.build/ | connect UI unavailable | no visible control named connect / log in / sign in; a dialog without a wallet list is open: "Cookie Consent Banner" | — | Cookie Consent Banner / — / — / — |
