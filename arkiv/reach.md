# Reach: who is this for, and how does it spread?

## Users

- **Dapp developers** run `igris scan` in CI (`--fail-under`, exit codes
  designed for it) and `igris fix` to adopt Anon-RPC. Their incentive:
  a public, queryable privacy score they control by actually fixing leaks.
- **Dapp users** check a dapp on the registry viewer before connecting, or
  install the extension stub which matches the current site against a local
  registry snapshot (no per-site queries — their browsing history never
  leaves the machine).
- **Other scanners/auditors** publish their own attestations with the same
  schema from their own wallets; viewers pin whom they trust, and agreement
  between independent scanners ("N scanners agree") is visible.

## Why the registry grows

Every scan is cheap (one CLI run), every publish is one small entity, and
disagreement is productive: a dapp team that disputes a finding re-runs the
scan themselves — the report embeds everything needed to reproduce it
(scanner version, methodology docs, deterministic findings) and
`reportSha256` ties each claim to exact evidence.

## Honest limits

- Rabdi is a testnet; entities expire (by design) and the network may reset.
  The snapshot path keeps any dataset usable offline.
- Reach beyond the hackathon needs a funded scanner wallet and periodic
  re-scans — a cron job away, but still an operational commitment.
- TODO(human): real-world scan campaign numbers (we refuse to invent a
  "scanned N top dapps" headline without running it).
