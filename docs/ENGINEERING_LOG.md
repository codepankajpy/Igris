# Engineering log

Newest entries at the bottom. Each entry records what changed, why, how it
was verified, and what remains unverified. Statuses follow
[ROADMAP.md](./ROADMAP.md).

---

## 2026-11-06 — Assessment and roadmap

**Inspected:** every source file, doc and config. Ran build, lint, format,
94 unit tests and 22 e2e tests (all green). Ran live scans of github.com and
a dead URL. Probed the Arkiv Rabdi RPC live. Researched the bounty pages,
Arkiv SDK 1.0.1 source, anon-rpc spec v0.4.0, Kohaku, WalletBeat and EAS.

**Decisions (approved by the project owner):**

- Execution order P0 → P0.5 → {P1, P2, P3, P5} → P4 gate → P6.
- The hosted scanner stays local/Docker-only until P0 passes.
- Viewer rewrite in Preact with hash routing (P5).
- Arkiv scanner keys funded by a human at the Rabdi faucet. Paid Swarm
  postage is deferred until after validation.
- A second Mac runs an independent scanner node with its own key and profile.
- EF target: **Best CROPS App**, with Privacy as the lead property.
  Anon-RPC is the remediation story. The Anon-RPC prize requires the app's
  _own_ reads to go through Anon-RPC, and IGRIS's reads go to Arkiv.

**Why these are out of scope:** smart-contract analysis (Slither and
similar exist, false-positive risk, no differentiation); active probing of
third-party sites (ethics, legality); contracts, tokens or staking (no
security benefit over signed, attributable entities); EAS (duplicates Arkiv,
no CROPS gain); TEE proofs (out of reach, and "verifiable" here means
attributable + content-addressed + reproducible + corroborated); LLM findings
(violates determinism); hosted authenticated scanning (credentials would
reach our server, which breaks P).

Reconciliation findings R1–R17 are in ROADMAP.md.
