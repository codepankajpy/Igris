# Igris: Complete Project Guide & Architectural Documentation

> **Lighthouse for Web3 Dapp Privacy**: Scan, explain, fix, and publish.

---

## 1. Executive Summary & Why We Are Building This

### The Illusion of Web3 Privacy

Most Web3 users believe that interacting with decentralized applications (dapps) protects their real-world identity because they connect with a pseudonymous crypto wallet (like MetaMask or Rabby) rather than an email or phone number.

In reality, **almost every major dapp de-anonymizes its users the instant they connect**:

1. **RPC Provider Surveillance:**
   When a dapp reads on-chain data (e.g., fetching ERC-20 balances, checking allowances, or querying smart contract state), it makes JSON-RPC calls (`eth_call`, `eth_getBalance`) to centralized node providers like Infura, Alchemy, or QuickNode. These RPC providers log the user's **real IP address and physical location** alongside their **Ethereum wallet address**.
2. **Third-Party Analytics & Error Trackers:**
   Dapps frequently bundle standard Web2 tracking SDKs—Google Analytics, Mixpanel, Datadog, Sentry, or customer support widgets (Intercom, Zendesk). When the user connects their wallet, scripts routinely transmit the wallet address in request bodies, URL query parameters, or base64-encoded payloads to these analytics servers.
3. **Data Aggregation & Profiling:**
   Once an IP address is linked to an on-chain address, data brokers, surveillance firms, and state actors can associate every past and future blockchain transaction with that specific device and home or office internet connection.

### What Igris Does

Igris gives developers and users a way to measure, understand, and eliminate privacy leaks:

- **Evidence-Based Scanning:** Rather than relying on static code assumptions, Igris runs a real browser, connects a fresh, never-before-seen **Canary wallet address**, and records every outgoing network packet across 14+ data encodings.
- **Automatic Code Repair:** With `pnpm igris fix`, it uses an automated TypeScript AST codemod to rewrite `viem`, `ethers`, or `wagmi` configurations to route read traffic through the Ethereum Foundation's **Anon-RPC** (which relays queries through privacy mixnets like Nym or Tor).
- **Decentralized, Expiring Registry (Arkiv):** Scan results are published as verifiable entities onto **Arkiv** (on the Ethereum Rabdi testnet). Audits expire in 30 days so dapps that fix their issues are not permanently penalized.
- **Zero-Tracking Registry Viewer:** A lightweight web application where users can search dapps, inspect privacy scores, and check which third parties receive their data.

---

## 2. How Everything Works Under the Hood

```
+-----------------------------------------------------------------------------------+
|                                     IGRIS SCAN                                    |
+-----------------------------------------------------------------------------------+
|  1. Generate Canary Address (0x...)                                               |
|  2. Launch Chromium (Playwright)                                                  |
|  3. Phase A (Pre-connect): Record initial CDN, analytics, and cookie requests     |
|  4. Inject Mock Wallet via EIP-1193 / EIP-6963                                    |
|  5. Trigger Wallet Connection (Auto-click or custom recipe)                       |
|  6. Phase B (Post-connect): Record all traffic, JSON-RPC bodies, and storage      |
+-----------------------------------------------------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
|                           DETECTION & SCORING (@igris/core)                       |
+-----------------------------------------------------------------------------------+
|  * Search for Canary Address across 14+ encodings (plain, hex, base64, URL, etc.) |
|  * Classify endpoints: RPC Provider, Analytics, Error Tracker, CDN, Relay         |
|  * Deduct score points (Base: 100) and build the Itemized Penalty Ledger          |
+-----------------------------------------------------------------------------------+
                                          |
                  +-----------------------+-----------------------+
                  |                                               |
                  v                                               v
+------------------------------------+          +-----------------------------------+
|             IGRIS FIX              |          |           IGRIS PUBLISH           |
+------------------------------------+          +-----------------------------------+
|  * AST codemod (ts-morph)          |          |  * Sign payload with scanner key  |
|  * Injects Anon-RPC Shim           |          |  * Publish to Arkiv L2 (Rabdi)    |
|  * Reroutes reads via Nym/Tor mix  |          |  * 30-Day TTL (Auto-expiry)       |
+------------------------------------+          +-----------------------------------+
                                                                  |
                                                                  v
                                                +-----------------------------------+
                                                |      WEB VIEWER (apps/web)        |
                                                |  * Live Arkiv queries             |
                                                |  * Offline snapshot.json mode     |
                                                |  * Pinned scanner trust model     |
                                                +-----------------------------------+
```

### The Canary Wallet Technique

To avoid false positives and heuristic guesswork, Igris uses an empirical canary method:

1. Every scan creates a cryptographically valid, random throwaway Ethereum address (the canary).
2. The mock wallet injects itself into the page via the standard `window.ethereum` (EIP-1193) and the multi-wallet discovery provider (EIP-6963).
3. The browser engine monitors all network requests during two distinct phases:
   - **Phase A (Pre-Connect):** Tracks third-party domains contacted before any user interaction (tracking cookies, fonts, CDN trackers).
   - **Phase B (Post-Connect):** Initiates wallet connection and monitors all subsequent traffic for appearances of the canary address.
4. **Encoding Multi-Search:** Dapps often obscure addresses. Igris inspects bodies, headers, and query parameters for:
   - Checksummed address (`0x8ba1f1...`)
   - Lowercase and uppercase bare hex (`8ba1f1...`)
   - URL-encoded (`%30%78...`)
   - Base64-encoded strings
   - Hex-encoded byte arrays

### Scoring Methodology & Penalty Ledger

Scoring starts at **100 points** and subtracts penalties based on severity:

- **RPC Provider Leak (-40 to -50 pts):** Direct address transmission to a known RPC provider.
- **Analytics Leak (-25 pts):** Address transmitted to tracking services (Google Analytics, Mixpanel, etc.).
- **Error Tracker Leak (-20 pts):** Address transmitted to exception trackers (Sentry, Datadog).
- **Pre-Connect Tracking (-5 pts each):** Contacting unshielded third parties before user consent.
- **Anon-RPC Detection:** Dapps that route reads through the Ethereum Foundation's Anon-RPC receive explicit recognition (`usesAnonRpc: true`) and avoid RPC penalties.

---

## 3. How Anyone Can Use It

### Option A: The Full-Stack Web Platform (Frontend on Vercel + Backend on Railway/Render)

We provide a turnkey cloud setup where anyone can visit a web interface and either **audit a live dapp URL** or **inspect and patch a GitHub repository**:

- **Frontend (`apps/web`):** Deployable with 1-click to **Vercel** or **Netlify**. A modern, responsive dark-mode portal displaying the on-chain Arkiv registry, privacy leaderboards, real-time audit triggers, and penalty breakdowns.
- **Backend Worker (`apps/api`):** Deployable with 1-click to **Railway** or **Render** using the provided `apps/api/Dockerfile`, `railway.json`, and `render.yaml`. It manages Playwright headless Chromium instances to execute live scans on demand without compromising browser security.

```bash
# Start backend API locally
pnpm --filter @igris/api dev    # Running on http://localhost:3001

# Start frontend locally
pnpm --filter @igris/web dev    # Running on http://localhost:5173
```

### Option B: Local Installation & CLI (For Developers & Auditors)

Anyone can clone the repository, run scans, or patch their dapps locally without any paid API keys or cloud infrastructure:

```bash
# 1. Clone & install dependencies
git clone https://github.com/<your-username>/Igris.git
cd Igris
pnpm install

# 2. Install Playwright browser binaries
pnpm exec playwright install chromium chromium-headless-shell

# 3. Run the automated end-to-end demo (verifies the entire flow in ~20s)
pnpm demo

# 4. Scan any live dapp URL
pnpm igris scan https://app.example.com --fail-under 80

# 5. Automatically patch a dapp repository to route reads through Anon-RPC
pnpm igris fix /path/to/my-dapp --write
```

---

## 4. Auditing Closed-Source Dapps & Wallets

A common question is: _"Can Igris audit a dapp or wallet if neither is open source (e.g. MetaMask, proprietary dapps)?"_

### 1. Auditing Closed-Source Dapps

**Yes, 100%! Igris requires zero source code to audit any dapp on the internet.**

- Because Igris uses **runtime packet and telemetry inspection** (via Playwright and Chromium network listeners), it evaluates the live compiled website just like a real user's browser does.
- It injects the mock Canary wallet into the DOM, auto-clicks "Connect", and captures all outgoing HTTP requests, WebSockets, beacons, and RPC calls. Whether Uniswap, a proprietary gaming dapp, or a closed financial portal, Igris detects any wallet or IP leak empirically.

### 2. Auditing Closed-Source Wallets (e.g., MetaMask, Phantom, Coinbase Wallet)

Igris audits closed-source and proprietary wallets through three techniques:

1. **Wallet Extension Sandbox Loading:** Playwright can load any packed or unpacked `.crx` Chrome extension via `--load-extension`. The scanner can execute automated transactions while intercepting all extension background worker network requests to see what telemetry or IP addresses the wallet vendor transmits to Infura or central logging servers.
2. **EIP-1193 & EIP-6963 Spoofing:** When a dapp interacts with the wallet, Igris's mock provider intercepts the exact methods the dapp requests (`eth_requestAccounts`, `personal_sign`, `eth_sendTransaction`). It inspects whether the wallet's injected provider leaks metadata or allows silent de-anonymization.
3. **Wallet-Routed Read Auditing:** When dapps execute reads _through_ the wallet's provider rather than their own public RPC, Igris tags these as `readsViaWallet`. This isolates dapp surveillance from wallet surveillance.

### 1. Auditing Closed-Source Dapps

**Yes, 100%! Igris requires zero source code to audit any dapp on the internet.**

- Because Igris uses **runtime packet and telemetry inspection** (via Playwright and Chromium network listeners), it evaluates the live compiled website just like a real user's browser does.
- It injects the mock Canary wallet into the DOM, auto-clicks "Connect", and captures all outgoing HTTP requests, WebSockets, beacons, and RPC calls. Whether Uniswap, a proprietary gaming dapp, or a closed financial portal, Igris detects any wallet or IP leak empirically.

### 2. Auditing Closed-Source Wallets (e.g., MetaMask, Phantom, Coinbase Wallet)

Igris audits closed-source and proprietary wallets through three techniques:

1. **Wallet Extension Sandbox Loading:** Playwright can load any packed or unpacked `.crx` Chrome extension via `--load-extension`. The scanner can execute automated transactions while intercepting all extension background worker network requests to see what telemetry or IP addresses the wallet vendor transmits to Infura or central logging servers.
2. **EIP-1193 & EIP-6963 Spoofing:** When a dapp interacts with the wallet, Igris's mock provider intercepts the exact methods the dapp requests (`eth_requestAccounts`, `personal_sign`, `eth_sendTransaction`). It inspects whether the wallet's injected provider leaks metadata or allows silent de-anonymization.
3. **Wallet-Routed Read Auditing:** When dapps execute reads _through_ the wallet's provider rather than their own public RPC, Igris tags these as `readsViaWallet`. This isolates dapp surveillance from wallet surveillance.

---

## 5. Expanding Igris into the Central Privacy & Security Oracle

To serve as the comprehensive privacy & security oracle for Web3, Igris includes:

- **RPC Surveillance Detection:** Flags queries to Infura, Alchemy, and unshielded endpoints.
- **Analytics & Telemetry Sniffing:** Tracks Google Analytics, Mixpanel, Datadog, Sentry, and CDN beacons.
- **Anon-RPC Verification:** Detects if the dapp utilizes Nym or Tor mixnet relays.
- **Storage Leaks:** Audits `localStorage`, `sessionStorage`, and tracking cookies that persist wallet addresses.
- **Verifiable On-Chain Attestations:** Every report is hashed and published to Arkiv with a 30-day TTL, giving the ecosystem a dynamic, decentralized rating oracle.

---

## 6. CI/CD Architecture & The `.github` Directory

To serve as the comprehensive privacy & security oracle for Web3, Igris includes:

- **RPC Surveillance Detection:** Flags queries to Infura, Alchemy, and unshielded endpoints.
- **Analytics & Telemetry Sniffing:** Tracks Google Analytics, Mixpanel, Datadog, Sentry, and CDN beacons.
- **Anon-RPC Verification:** Detects if the dapp utilizes Nym or Tor mixnet relays.
- **Storage Leaks:** Audits `localStorage`, `sessionStorage`, and tracking cookies that persist wallet addresses.
- **Verifiable On-Chain Attestations:** Every report is hashed and published to Arkiv with a 30-day TTL, giving the ecosystem a dynamic, decentralized rating oracle.

---

## 6. CI/CD Architecture & The `.github` Directory

The [`.github/workflows/`](file:///Users/pankajyadav/programming/ethGlobal/Igris/.github/workflows) folder contains two critical automation workflows:

### 1. Repository CI (`.github/workflows/ci.yml`)

Runs on every `push` to `main` and every `pull_request` to ensure the integrity of Igris itself:

- **Linting & Code Style:** Enforces ESLint and Prettier formatting (`pnpm lint`, `pnpm format:check`).
- **Unit Test Suite:** Executes 94 Vitest unit tests covering encoding detection, classification, scoring, and patcher AST transforms.
- **Browser Integration Tests:** Sets up Playwright with `--with-deps` and executes the 22 end-to-end integration tests in `packages/scanner/e2e/`.

### 2. Dapp Developer Privacy Gate (`.github/workflows/privacy-gate.yml.example`)

This is a reusable GitHub Action template for **external dapp repositories**:

- Dapp teams drop this file into their own GitHub repository.
- On every Pull Request, the workflow builds a preview of the dapp, spins it up locally, runs `igris scan`, and compares the result against a committed baseline (`privacy-baseline.json`).
- **If a developer introduces a new tracker or leaks user wallet addresses to an RPC provider, CI automatically fails and blocks the PR from merging.**

---

## 5. Live Project Submission Guide

For hackathon submissions requiring a live link, follow these instructions to deploy the web viewer and publish real records:

### Step 1: Deploy `apps/web` (Takes ~2 minutes)

Because `apps/web` is a static frontend with zero backend dependencies, it can be deployed to any static host:

#### Deploy to Vercel

```bash
# Build the production bundle
pnpm --filter @igris/web build

# Deploy directly via Vercel CLI
npx vercel apps/web/dist --prod
```

_(Or import the repository into the Vercel dashboard: set **Root Directory** to `apps/web`, **Build Command** to `pnpm build`, and **Output Directory** to `dist`)_.

#### Deploy to Netlify

```bash
npx netlify deploy --dir=apps/web/dist --prod
```

### Step 2: Fund the Scanner Key & Publish Live Attestations

1. Get free Rabdi testnet tokens for the pre-configured scanner address:
   - **Scanner Address:** `0xDbd0309b80f71E12d45Ac8321DBA637156a4198B`
   - **Faucet:** [https://hub.arkiv.network/faucet](https://hub.arkiv.network/faucet)
2. Publish sample audit reports to the live Arkiv blockchain:
   ```bash
   pnpm igris publish examples/leaky/report.json
   pnpm igris publish examples/fixed/report.json
   ```
3. Open your deployed live URL. The viewer will automatically query the Arkiv network and display the live published attestations pinned to your scanner key.
