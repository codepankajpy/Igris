# IGRIS data contracts

Normative specification of everything IGRIS produces or consumes across a
trust boundary. The code is authoritative where this document and the code
disagree. Such a disagreement is a bug: report it. The JSON Schemas are
exported from `@igris/core` (`REPORT_V3_SCHEMA`, `REPORT_V2_SCHEMA`,
`EVIDENCE_BUNDLE_SCHEMA`, `EVIDENCE_ITEM_SCHEMA`).

| Contract               | Identifier                                         | Where                                         |
| ---------------------- | -------------------------------------------------- | --------------------------------------------- |
| Canonical JSON         | RFC 8785                                           | `packages/core/src/contracts/canonical.ts`    |
| Content hash           | sha256 over canonical bytes, 64 lowercase hex      | `contracts/hash.ts`                           |
| Capture                | v1 (internal, unredacted — never published)        | `contracts/capture.ts`                        |
| Wallet requests        | shared types (proposed)                            | `contracts/wallet-request.ts`, `walletreq.ts` |
| Evidence bundle        | `igris.evidence.v4` (writes, proposed); v1–v3 read | `contracts/evidence.ts`                       |
| Report                 | `"3.0.0"` (writes, proposed); `"2.x"` read         | `contracts/report-v{2,3}.ts`                  |
| Detector API           | v1                                                 | `contracts/detector.ts`, `engine.ts`          |
| Scanner node / profile | `igris.node.v1` / `igris.scanner.v1`               | `packages/registry/src/identity.ts`           |
| Registry entity        | Arkiv schema `igris.scan.v1`, summary payload v2   | `packages/registry/src/{schema,record}.ts`    |

## Canonicalization and hashing

All published hashes are `sha256(canonicalize(value))`, rendered as 64
lowercase hex characters.

`canonicalize` implements RFC 8785:

- keys are sorted by UTF-16 code units;
- there is no whitespace;
- strings and numbers are serialized as by ECMAScript `JSON.stringify`, with `-0` written as `0`.

It is stricter than JSON in its rejections. Each of these is an error, never
silently coerced:

- non-finite numbers;
- lone surrogates;
- `undefined`, bigint, functions;
- non-plain objects;
- cycles.

The tests use RFC 8785 Appendix B number vectors and the §3.2.3 sorting
example.

On disk, `evidence.json` is written as the exact canonical bytes, so
`shasum -a 256 evidence.json` equals `report.evidence.sha256`. `report.json`
is pretty-printed; its content hash is `contentHash(report)` — the
`scanId` attribute of its Arkiv `igris.scan.v2` entity.

## Evidence bundle `igris.evidence.v1`

```jsonc
{ "bundleVersion": "igris.evidence.v1", "items": { "ev_<24 hex>": EvidenceItem, … } }
```

- **Content-addressed.** An item id is `"ev_" + contentHash(item)[0..24]`.
  Identical evidence has exactly one id. `verifyReportIntegrity` recomputes
  every id.
- **Canary-free.** The engine refuses to build a bundle in which any
  detectable form of the scan's canary appears. Snippets and URLs carry
  `<CANARY>`.
- **No scan identity and no volatile telemetry.** The bundle holds no
  timestamps, no canary, no scanner key and no request counts. Those live in
  the report.
- **Faithful, not normalized.** Snippets are what the page actually sent. A
  page that embeds a random value next to the address therefore produces a
  different bundle on every scan. This was measured on the leaky fixture:
  wagmi stores a random connection id in localStorage. To compare scans, use
  `findingSet`, below.

Item types: `canary-match`, `third-party-contact`, `document-headers`. The
JSON Schema is `EVIDENCE_ITEM_SCHEMA`, with `additionalProperties: false` on
every object.

## Evidence bundle `igris.evidence.v2`

Approved by the project owner on 2026-11-06 and frozen: its schemas are
pinned by canonical hash in `contracts.test.ts`, like v1's. v2 bundles remain valid input; new bundles are written as v4 (below).

v2 is v1 plus exactly one item type. The three v1 item schemas are
byte-for-byte identical in v2 (tested).

```jsonc
{
  "type": "contact-classification",
  "host": "api.example.org",
  "registrableDomain": "example.org",
  "relationship": "first-party" | "same-organisation" | "tenant-infrastructure"
                | "shared-cdn" | "wallet-sdk" | "rpc" | "walletconnect-relay"
                | "ipfs-gateway" | "analytics" | "advertising" | "error-monitoring"
                | "support-chat" | "security-service" | "anon-rpc" | "unknown",
  "confidence": "high" | "medium" | "low",
  "rule": "<rule-id>@<n>",                 // which rule, which version
  "basis": [{ "kind": BasisKind, "detail": "…" }]   // 1–16 entries
}
```

`BasisKind` is one of `registrable-domain-match`, `organisation-mapping`,
`third-party-db`, `tenant-hostname`, `resource-profile`, `no-cookies`,
`no-canary`, `no-match`. Every classification therefore names the rule that
made it and the evidence it rested on. `relationship` is descriptive; the
scoring class stays the frozen `recipientClass` on `third-party-contact`.

No detector produces `contact-classification` items yet (ROADMAP P1-3).

## Report v2 (`2.0.0`)

```
reportVersion  "2.0.0"
scan           target, hostname, scannedAt, chainId, status, scannerVersion,
               spoofMetaMask, canaryAddress, egress (unrestricted|public-only|unknown),
               connectionLog[], notes[]
detectors      [{ id, version, domain }]   — the detectors that ran
privacy        { score: 0–100 | null, coverage: full|pre-connect-only|none,
                 ledger: PenaltyLine[], findings: PrivacyFinding[] }
security       { observations: SecurityObservation[] }
contacts       third parties with request counts (telemetry, volatile)
wallet         { readsViaWallet[], usesAnonRpc }
telemetry      counts, or null when not recorded
evidence       { bundleVersion, canonicalization: "RFC8785", sha256, itemCount }
findingSet     { sha256, count }  — digest of the sorted finding fingerprints
migratedFrom?  "1.x.y" when produced by migration
```

### Findings

Every finding, privacy or security, has these fields:

- **`id`**: `"F-" + fingerprint[0..16]`.
- **`fingerprint`**: `contentHash({detector, ...identity})`. The identity
  excludes the canary, timestamps and snippets, so **the same behaviour has
  the same id across scans and scanner nodes**. This is verified in a real
  browser: two scans with different canaries give identical ids.
- **`detector`, `detectorVersion`**.
- **`domain`**: `privacy` | `security`.
- **`kind`**: `issue` (confirmed problem) | `risk` (enabling condition) |
  `observation` (informational).
- **`severity`**: `critical` | `high` | `medium` | `low` | `info`. How bad it is.
- **`confidence`**: `confirmed` | `likely` | `possible`. How sure we are that it is true.
- **`title`, `impact`, `remediation`**.
- **`evidence`**: at least one `{ id, type }` reference into the bundle.
- **`countsTowardPrivacyScore`**.

### Privacy score vs. security observations

- **The score is computed only from `privacy.findings`.** It uses a scoring
  rule registered per detector (`scoring-v2.ts`), which reads the typed
  evidence. A counted finding from a detector without a rule is an error.
- **Security observations are a separate type.** Their
  `countsTowardPrivacyScore` is the literal `false`. A
  `SecurityObservation` is not assignable to `PrivacyFinding`; this is
  checked at compile time in `lockstep.ts`. `scorePrivacy` rejects
  non-privacy findings at runtime. The schema enforces `const: false`.
- **`score` is `null` when coverage is `none`** (the page never loaded).
  Such a report cannot be published.

### Two digests, two purposes

| Digest              | Proves                         | Stable across scans of the same behaviour?    |
| ------------------- | ------------------------------ | --------------------------------------------- |
| `evidence.sha256`   | the exact observations (bytes) | only when the page embeds no nonces           |
| `findingSet.sha256` | which findings were observed   | yes (verified on the fixtures, repeated runs) |

Use `findingSet` for re-scan confirmation (ROADMAP P2-5) and independent
reproduction (P6-2). Use `evidence.sha256` to prove what was seen.

## Report `2.1.0`

Approved by the project owner on 2026-11-06 and frozen (hash-pinned).
2.0.0 and 2.1.0 reports remain valid input; new reports are written as
2.2.0 (below).

2.1.0 is 2.0.0 with additive changes only (a test asserts that nothing else
differs):

- `reportVersion` is `"2.1.0"`;
- `evidence.bundleVersion` is `"igris.evidence.v2"`, and finding evidence
  references may point at `contact-classification` items;
- `scan.connection` (optional): connect-phase diagnostics;
- `scan.failure` (optional): why nothing was measured.

Pairing is enforced by `verifyReportIntegrity`: a 2.0.0 report references a
v1 bundle, a 2.1.0 report a v2 bundle.

```
scan.connection {
  kit        { id: rainbowkit|connectkit|appkit|privy|dynamic|none,
               confidence: high|medium|low|none, signals: string[] }
  strategy   kit-recipe | generic | recipe-file | none
  recipe     "<id>@<n>" | null           e.g. "legacy-heuristic@0"
  outcome    connected | failed | not-attempted
  failure    { category, step, detail } | null
  steps      [{ step, result: ok|failed|skipped, detail, ms }]   ≤ 50
  navigation { urlChanges: string[] ≤ 20, aborted: boolean }
  requestAccountsCalls  integer ≥ 0
}
scan.failure { category, detail }
```

Failure categories: `site-unavailable`, `bot-blocked`,
`browser-incompatible`, `no-connect-control`, `modal-not-opened`,
`wallet-option-missing`, `request-not-issued`, `unexpected-navigation`,
`recipe-error`, `scanner-error`.

`scan.connection` is a diagnostic, not evidence. It is not part of the
evidence bundle or of `findingSet`, so it never changes a finding or the
score. Kit `confidence` is earned: `high` means the kit's own modal was
observed; a network host alone is `low`. Consumers must not present a `low`
kit as an identification.

## Report `2.2.0` and `igris.evidence.v3`

Approved by the project owner on 2026-11-06 and frozen (hash-pinned). New
reports are written as 2.2.0 with v3 bundles; 2.0.0 / 2.1.0 reports and
v1 / v2 bundles still validate and verify.

One addition: the recipient class **`wallet-sdk`** — the backend of a wallet
connection, login or embedded-wallet SDK the dApp chose (Privy, Dynamic, the
Reown AppKit API, …). It needs the address to authenticate the user but keeps
its own record (address, IP, device, sessions) outside the dApp. Before this
class existed such vendors could only be `unknown-third-party`.

- Report 2.2.0 = 2.1.0 with `reportVersion` `"2.2.0"`, `contacts[].class`
  also allowing `wallet-sdk`, and `evidence.bundleVersion`
  `"igris.evidence.v3"`. A test asserts nothing else differs.
- `igris.evidence.v3` = v2 with `recipientClass` (canary-match,
  third-party-contact) also allowing `wallet-sdk`. A test asserts nothing
  else differs.
- Pairing: 2.0.0 ↔ v1, 2.1.0 ↔ v2, 2.2.0 ↔ v3 (`verifyReportIntegrity`).
- The frozen class list of the older schemas is `RECIPIENT_CLASSES_V1`;
  `wallet-sdk` is rejected by 2.1.0 / v2 (tested).
- Scoring: a leak to a `wallet-sdk` recipient is severity medium and costs
  20 points (docs/SCORING.md); the `canary-leak` detector is 1.1.0.

## Evidence bundle `igris.evidence.v4` (proposed, pending approval)

Specified in [docs/design/WALLET-REQUESTS.md](design/WALLET-REQUESTS.md).
**Not yet frozen**: `EVIDENCE_ITEM_SCHEMA` / `EVIDENCE_BUNDLE_SCHEMA` (v4)
are hash-pinned only after the owner approves that document (a TODO marks
the pin's place in `contracts.test.ts`). The frozen v3 schemas are exported
as `EVIDENCE_ITEM_SCHEMA_V3` / `EVIDENCE_BUNDLE_SCHEMA_V3`; their pins are
unchanged. v1–v3 bundles still validate (`validateEvidenceBundle` dispatches
on `bundleVersion`).

v4 is v3 plus exactly one item type (a test asserts the v3 item schemas are
reused unchanged and that the bundle schemas differ only by name, version
label and item-schema reference):

```jsonc
{
  "type": "wallet-request",
  "phase": "pre-connect" | "post-connect",
  "method": RecordedWalletMethod,          // eth_requestAccounts … eth_sendRawTransaction (13)
  "kind": "connect" | "switch-chain" | "add-chain" | "watch-asset" | "siwe"
        | "personal-message" | "blind-hash" | "eth-sign" | "permit" | "permit2"
        | "typed-data" | "approve" | "set-approval-for-all" | "transaction",
  "frame": "main" | "iframe",              // main = the scan page's own main frame
  "origin": "https://app.example.org",     // calling frame, ≤ 512 chars, canary redacted
  "outcome": "answered" | "signed" | "rejected" | "error",
  "chainId": 137 | null,                   // typed-data domain, SIWE Chain ID, tx chainId, switch target
  "verifyingContract": "0x…" | null,       // EIP-55, ^0x[0-9a-fA-F]{40}$
  "spender": "0x…" | null,                 // permit spender / approve spender / operator
  "token": "0x…" | null,
  "amount": "1461…975" | null,             // decimal, ^[0-9]{1,78}$
  "deadline": "1767225600" | null,         // decimal unix seconds
  "siweDomain": "evil.example" | null,     // 1–255 chars, canary redacted
  "unlimited": true, "longDeadline": false, "chainIdMismatch": true,
  "domainMismatch": false, "preConnect": false,
  "paramsDigest": "<64 hex>"               // sha256 of the canonical params, canary → <CANARY>
}
```

- **Canary-free.** Raw params are never stored. Owner / holder fields are
  never read; an address field equal to the canary is `null`; free text
  (origin, SIWE domain) has every detectable canary form replaced by
  `<CANARY>`; `paramsDigest` redacts the canary before hashing (also inside
  hex-encoded message text), so the same request made to two scans'
  canaries has the same digest and the same item id. The engine's
  canary-free assertion covers the whole bundle, these items included.
- **No times.** The item holds no `t`; times are in the report summary.
- **Every request is evidence**, whether or not a finding references it
  (the report's `walletRequests` point at it). Identical requests share one
  content-addressed item.
- Decoding is pure and offline (`decodeWalletRequest(s)` in `walletreq.ts`);
  the rules are in the design document. Resolved details: `personal_sign`
  params are read in either order (the canary / an address is the address);
  a 0x-hex message is decoded as UTF-8, a bare 32-byte hash (with or without
  0x), invalid UTF-8, control characters or unparseable params are
  `blind-hash`; the SIWE domain and an http(s) URI must be the calling
  frame's host or a sub/parent domain of it within the same registrable
  domain (siblings and public suffixes do not match; an opaque frame origin
  falls back to the page origin); Permit2 AllowanceTransfer
  (PermitSingle / PermitBatch) reports `expiration` as the deadline,
  SignatureTransfer reports the message `deadline`; DAI-style permits
  (`allowed: true`) are `permit` + unlimited, expiry 0 is a long deadline;
  `setApprovalForAll(…, false)` (a revocation) is a plain transaction;
  `unlimited` = amount ≥ 2^160 − 1; `longDeadline` = deadline > scan time +
  30 days (permits only); a JSON number beyond 2^53 has `amount: null` but
  its magnitude still counts for `unlimited`. Wallet state is threaded per
  calling frame (frame + origin): its chain (changed by an answered
  `wallet_switchEthereumChain` with a string chain id, as the canary does)
  and whether it called `eth_requestAccounts` (`preConnect`).

## Report `3.0.0` (proposed, pending approval)

Specified in [docs/design/REPORT-3.0.0.md](design/REPORT-3.0.0.md), which is
normative for it. Implemented in `contracts/report-v3.ts`, `verdicts.ts`,
`timeline.ts`; **not yet frozen**: its schema is not hash-pinned until the
project owner approves the design document (a TODO marks the pin's place in
`contracts.test.ts`). The engine writes 3.0.0 with `igris.evidence.v4`
bundles; 2.0.0 / 2.1.0 / 2.2.0 reports still validate (`validateReport`,
which `validateReportV2` now aliases) and verify.

3.0.0 has **no score**. It is 2.2.0 with exactly these changes (a test
strips them and asserts that nothing else differs):

- removed: `privacy.score`, `privacy.ledger`, and every finding's
  `countsTowardPrivacyScore`. Findings are otherwise identical (same ids,
  fingerprints, evidence), so `findingSet` is comparable with 2.x reports;
- added `recipients[]`: one per (registrable domain, class), never first
  party, with `hosts`, `learned { address: exact|hashed|possible|none,
addressPhases, ip }`, a `verdict` (`unidentified` > `tracking` >
  `avoidable` > `expected`), the `rule` that gave it (`verdict.<name>@1`), a
  one-sentence `reason`, and the `findingIds` about it. Sorted by verdict,
  domain, class. The verdict table is in the design document and in
  `verdicts.ts`; `possible` (truncated display form only) counts as no
  address;
- added `timeline` (volatile, like `telemetry`; `null` when the capture
  recorded no times): `origin: "navigation-start"`, `milestones` (≤ 20),
  `recipients` (same keys and order as `recipients[]`, `firstContactMs`,
  `firstAddressMs`), `requestsPerSecond` (dense 1 s buckets, ≤ 600, first vs
  third party). All times are integer ms ≥ 0; the bundle never holds times;
- added `walletRequests` (required): `null` (not recorded — migrated
  reports) or one `WalletRequestSummary` per recorded request, in request
  order, at most 500 (proposed, pending pin; see below);
- finding evidence references may also point at `wallet-request` items, and
  `evidence.bundleVersion` is `igris.evidence.v4`;
- `migratedFrom` accepts `1.x.y` and `2.x.y`.

### `walletRequests` (proposed, pending pin)

```
{
  evidenceId: "ev_…",                      // a wallet-request item of the bundle
  t: integer ms since navigation start | null,
  kind, method, phase, outcome, frame, chainId, verifyingContract, spender,
  token, amount, deadline, siweDomain,     // exactly the item's values
  unlimited, longDeadline, chainIdMismatch, domainMismatch, preConnect,
  findingIds: string[]                     // findings referencing evidenceId (sorted)
}
```

One entry per request (identical requests share an `evidenceId`). Findings
come from the detector `wallet-requests` 1.0.0 (domain `security`, so they
never reach recipients, verdicts or any score); its table is in the design
document. A request that matches several rows gets one finding: the most
severe row gives severity and title, every matched row adds its impact and
remediation. Fingerprint identity: `{ method, kind, verifyingContract,
spender, token, flags }` (`flags` = the request's true flags, comma-joined),
never the canary. Nothing is reported for a page that did not load
(`walletRequests: []`).

Integrity (`verifyReportIntegrity`): 3.0.0 pairs with `igris.evidence.v4`;
ledger checks apply to 2.x only; for 3.0.0 every `recipients[].findingIds`
entry must exist, every recipient must appear in `contacts` or in a
canary-match item a finding references, and the timeline's recipient keys
must equal the report's; every `walletRequests` entry must point at a
`wallet-request` item, repeat its decoded fields exactly and list exactly the
findings that reference it; every `wallet-request` item must be summarised
(none may exist when `walletRequests` is null).

Migration `migrateReportV2toV3(report, bundle)` refuses an invalid or
unverifiable input, drops score / ledger / the score flag, computes
`recipients` with the engine's rules, sets `timeline`, `rpc` and
`walletRequests` to null, re-labels the bundle `igris.evidence.v4` (items
and their ids unchanged; `evidence.sha256` updated because the hash covers
the label) and sets `migratedFrom` to the
original version (a 1.x report keeps its 1.x origin). v1 reports reach
3.0.0 through 2.2.0 (`migrateReportV1toV3`); `migrateToCurrent(report,
bundle?)` reads any version and returns a verified 3.0.0 result. It also
upgrades a **draft 3.0.0** written before `walletRequests` existed (no
`walletRequests` key, an `igris.evidence.v3` bundle that hashes to the
report's `evidence.sha256`): bundle re-labelled v4, `walletRequests: null`,
a note in `scan.notes`; the result is validated and integrity-checked.

`summarise(report, bundle)` replaces `assess()`: a descriptive `state`
(`not-observed`, `address-to-trackers`, `address-to-services`,
`no-address-observed`), a headline and points, with no level and no score.

Nothing in a 3.0.0 report is scored. The scoring code (`scoring-v2.ts`,
`weights.ts`) is still used internally: to cross-check 1.x → 2.x migrations,
and by the detector API, where a draft's `countsTowardPrivacyScore` sets a
canary leak's severity (and must name a weight rule). The flag never reaches
a 3.0.0 report.

## Detector API v1

```ts
interface Detector {
  id: string;
  version: string;
  domain: 'privacy' | 'security';
  run(capture: Capture, ctx: DetectorContext): DraftFinding[];
}
```

The engine, not the detector, enforces these rules for every detector. A
violation throws `DetectorContractError` and fails the scan:

1. every draft has ≥ 1 evidence item, and each item validates against the schema;
2. security drafts never count toward the privacy score;
3. identities (fingerprints) are unique per detector, and detector ids are unique;
4. a counted privacy draft requires a registered scoring rule;
5. the finished bundle contains no form of the canary;
6. the engine validates its own output (report and bundle) against the schemas.

Built-in detectors: `canary-leak` 1.1.0 (privacy), `ip-exposure` 1.0.0
(privacy), `security-headers` 1.0.0 (security), `wallet-requests` 1.0.0
(security). `DetectorContext` also carries the scan's start `chainId` and
`scannedAt` (used by `wallet-requests`).

## Versioning policy

- **Report**: a new optional field is a minor bump. Anything else is a major
  bump and must ship with a migration function plus regression fixtures.
- **Evidence bundle, scanner profile, node file**: new name on any change
  (`igris.evidence.v2`, …).
- **Approval and freezing**: a successor contract takes effect only after
  the project owner approves it. Once approved it is frozen, and its schemas
  are pinned by canonical hash in `contracts.test.ts`. Frozen so far: report
  2.0.0, 2.1.0 and 2.2.0; `igris.evidence.v1`, `v2` and `v3`. Proposed and
  not yet pinned: report 3.0.0 and `igris.evidence.v4`.
- **Detectors**: bump `version` when logic changes. The `id` never changes,
  because it is part of every fingerprint.
- **Arkiv entity schema**: a new schema name on breaking change
  (`igris.scan.v2`).

## Migration v1 → v2

`migrateReportV1toV2` accepts 1.0.0 and 1.1.0 reports. It guarantees:

- the output is schema-valid;
- every v1 finding is preserved, field for field, as a `canary-leak` finding;
- every valid score is identical (also cross-checked by recomputing with the v1 scorer).

It does not invent data:

- egress becomes `unknown`;
- missing telemetry becomes `null`;
- 1.0.0's mislabelled `wsConnections` (actually a frame count) moves to `wsFrames`;
- security headers are not migrated: 1.0.0 values were wrong, and 1.1.0 kept
  only booleans. The report notes say so.

Exactly two v1 defects are corrected, each stated in `scan.notes`:

- **1.0.0 scored unloaded pages 100.** These become `null`.
- **Pre-`b915636` reports could contain a "third party" with an empty
  hostname, and charged for it.** The contact is removed, and the score
  change is recorded with its reason. In the real app.uniswap.org fixture,
  82 becomes 83.

Any other score difference throws `MigrationError`. The regression fixtures
are in `packages/core/test-fixtures/v1/`; their provenance is in its README.

## Scanner identity

- **`pnpm scanner:init <name>`** (the backend operator's one-time setup) generates a key at
  `$IGRIS_HOME/scanners/<address>/key` (mode 0600, directory 0700) and
  writes the profile `igris.scanner.v1`
  `{ address, name, nodeId, createdAt, origin }`.
- **`igris.node.v1` `{ nodeId }`** identifies the machine. A profile whose
  `nodeId` is not this node's is refused for signing: a copied `~/.igris`
  is not an independent scanner.
- **Importing a key** (`importScanner` in `packages/registry/src/identity.ts`)
  refuses a key that any local profile already claims.
- **Keys are never read from environment variables and never printed.**
  Group- or world-readable key files are refused.
- **Stated limitation:** two machines that each import the same key by hand
  cannot be told apart locally. On Arkiv they are one owner, that is, one
  scanner, which is the honest reading.
