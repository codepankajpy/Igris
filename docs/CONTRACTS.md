# IGRIS data contracts

Normative specification of everything IGRIS produces or consumes across a
trust boundary. The code is authoritative where this document and the code
disagree. Such a disagreement is a bug: report it. The JSON Schemas are
exported from `@igris/core` (`REPORT_V2_SCHEMA`, `EVIDENCE_BUNDLE_SCHEMA`,
`EVIDENCE_ITEM_SCHEMA`).

| Contract               | Identifier                                       | Where                                      |
| ---------------------- | ------------------------------------------------ | ------------------------------------------ |
| Canonical JSON         | RFC 8785                                         | `packages/core/src/contracts/canonical.ts` |
| Content hash           | sha256 over canonical bytes, 64 lowercase hex    | `contracts/hash.ts`                        |
| Capture                | v1 (internal, unredacted — never published)      | `contracts/capture.ts`                     |
| Evidence bundle        | `igris.evidence.v1`                              | `contracts/evidence.ts`                    |
| Report                 | `reportVersion: "2.0.0"`                         | `contracts/report-v2.ts`                   |
| Detector API           | v1                                               | `contracts/detector.ts`, `engine.ts`       |
| Scanner node / profile | `igris.node.v1` / `igris.scanner.v1`             | `packages/registry/src/identity.ts`        |
| Registry entity        | Arkiv schema `igris.scan.v1`, summary payload v2 | `packages/registry/src/{schema,record}.ts` |

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
is pretty-printed; its content hash is `contentHash(report)`, which
`igris verify` prints.

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

Built-in detectors: `canary-leak` 1.0.0 (privacy), `ip-exposure` 1.0.0
(privacy), `security-headers` 1.0.0 (security).

## Versioning policy

- **Report**: a new optional field is a minor bump. Anything else is a major
  bump and must ship with a migration function plus regression fixtures.
- **Evidence bundle, scanner profile, node file**: new name on any change
  (`igris.evidence.v2`, …).
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

- **`igris scanner init --name <n>`** generates a key at
  `$IGRIS_HOME/scanners/<address>/key` (mode 0600, directory 0700) and
  writes the profile `igris.scanner.v1`
  `{ address, name, nodeId, createdAt, origin }`.
- **`igris.node.v1` `{ nodeId }`** identifies the machine. A profile whose
  `nodeId` is not this node's is refused for signing: a copied `~/.igris`
  is not an independent scanner.
- **`igris scanner import`** refuses a key that any local profile already
  claims.
- **Keys are never read from environment variables and never printed.**
  Group- or world-readable key files are refused.
- **Stated limitation:** two machines that each import the same key by hand
  cannot be told apart locally. On Arkiv they are one owner, that is, one
  scanner, which is the honest reading.
