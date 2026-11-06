# Reach: who is this for, and how does it spread?

## Users

- **People about to connect a wallet** search a site on the IGRIS website
  and read what it sends to whom: recipients with verdicts (expected,
  avoidable, tracking, unidentified), a timeline, RPC calls, security
  headers, the evidence. No score: what we observed, stated plainly.
- **dApp teams** retest after a fix. The new version is linked to the old
  one on Arkiv, and the report shows what changed (recipients removed,
  verdicts changed, same behaviour or not), as a public record that the fix
  happened.
- **Researchers and journalists** query Arkiv directly: every scanned site
  that sends data to a tracker is one `igris.flow.v1` query, and every
  scanned site that asks for an unlimited Permit2 approval is one
  `igris.walletreq.v1` query (schema.md has copy-pasteable curls, filtered
  on `$creator`). They need no account and no API from us.
- **Anyone who wants a site checked** can ask for it: an `igris.request.v1`
  on Arkiv (the website creates one per scan request). Any scanner node may
  pick it up, so a request does not depend on one operator.
- **Other operators** run IGRIS nodes with their own scanner key. They
  fulfil open requests and publish versions attributable to their address;
  each reader chooses which scanners it trusts and sees where independent
  nodes agree or differ.

## Why the registry grows

Anyone can scan any site from the website: one search, one click. Every
completed scan publishes automatically, so the registry grows with every
use, and retests add history instead of overwriting it. The flow and
wallet-request entities make each new scan more useful: a tracker's reach,
or a spender's unlimited approvals, across sites become visible as more
sites are scanned. Each open request a second node fulfils adds an
independent result for the same site.

## Honest limits

- Rabdi is a testnet; entities expire after at most ≈ 182 days, and the
  network may reset. A site that nobody retests eventually disappears.
- A browser scan sees what one visit with one throwaway wallet shows. It
  cannot see what a recipient does with the data afterwards.
- Publishing needs a funded scanner key. The operator publishes; no
  campaign numbers are claimed until a real scan run exists.
- Two nodes run by one person are not independent; live pages also vary
  between runs, so agreement is shown per recipient, not per scan.
- Real sites rarely ask for signatures during a visit; the wallet-request
  demo uses a fixture page and says so.
