/**
 * Integrity check of a report against its evidence bundle (browser-safe; no
 * schema validation here — see validate.ts for that). Answers: does this
 * bundle hash to what the report claims, and does every finding's evidence
 * resolve to an item of the claimed type whose id matches its content?
 */
import {
  EVIDENCE_BUNDLE_VERSION,
  EVIDENCE_BUNDLE_VERSION_V2,
  EVIDENCE_BUNDLE_VERSION_V1,
  bundleHash,
  evidenceId,
  type EvidenceBundleV1,
} from './evidence.js';
import type { FindingSetDigest, FindingV2, ReportV2 } from './report-v2.js';
import { contentHash } from './hash.js';

/** Which bundle version each report version must reference. */
const BUNDLE_FOR_REPORT: Record<string, string> = {
  '2.0.0': EVIDENCE_BUNDLE_VERSION_V1,
  '2.1.0': EVIDENCE_BUNDLE_VERSION_V2,
  '2.2.0': EVIDENCE_BUNDLE_VERSION,
};

export interface IntegrityResult {
  ok: boolean;
  problems: string[];
  /** Hash recomputed from the bundle. */
  bundleSha256: string;
}

/** The finding-set digest of a list of findings (order-independent). */
export function findingSetDigest(
  findings: readonly Pick<FindingV2, 'fingerprint'>[],
): FindingSetDigest {
  const fps = findings.map((f) => f.fingerprint).sort();
  return { sha256: contentHash(fps), count: fps.length };
}

export function verifyReportIntegrity(report: ReportV2, bundle: EvidenceBundleV1): IntegrityResult {
  const problems: string[] = [];
  // Version pairing: report 2.0.0 ↔ bundle v1, 2.1.0 ↔ v2, 2.2.0 ↔ v3.
  const expected = BUNDLE_FOR_REPORT[report.reportVersion];
  if (expected !== bundle.bundleVersion) {
    problems.push(
      `report ${report.reportVersion} cannot reference a ${bundle.bundleVersion} bundle`,
    );
  }
  if (report.evidence.bundleVersion !== bundle.bundleVersion) {
    problems.push(
      `report claims ${report.evidence.bundleVersion}, bundle is ${bundle.bundleVersion}`,
    );
  }
  const recomputed = bundleHash(bundle);
  if (recomputed !== report.evidence.sha256) {
    problems.push(`bundle hash ${recomputed} != report.evidence.sha256 ${report.evidence.sha256}`);
  }
  const ids = Object.keys(bundle.items);
  if (ids.length !== report.evidence.itemCount) {
    problems.push(`bundle has ${ids.length} items, report claims ${report.evidence.itemCount}`);
  }
  for (const id of ids) {
    const item = bundle.items[id]!;
    if (evidenceId(item) !== id) problems.push(`item ${id} does not match its content id`);
  }
  const all = [...report.privacy.findings, ...report.security.observations];
  for (const f of all) {
    if (f.evidence.length === 0) problems.push(`${f.id} has no evidence`);
    for (const ref of f.evidence) {
      const item = bundle.items[ref.id];
      if (!item) problems.push(`${f.id} references missing evidence ${ref.id}`);
      else if (item.type !== ref.type)
        problems.push(`${f.id} references ${ref.id} as ${ref.type} but it is ${item.type}`);
    }
  }
  const digest = findingSetDigest(all);
  if (digest.sha256 !== report.findingSet.sha256 || digest.count !== report.findingSet.count) {
    problems.push(
      `findingSet digest ${digest.sha256}/${digest.count} != report ${report.findingSet.sha256}/${report.findingSet.count}`,
    );
  }
  const findingIds = new Set(all.map((f) => f.id));
  for (const line of report.privacy.ledger) {
    for (const id of line.findingIds) {
      if (!findingIds.has(id)) problems.push(`ledger ${line.id} references unknown finding ${id}`);
    }
  }
  for (const o of report.security.observations) {
    if (o.countsTowardPrivacyScore)
      problems.push(`security observation ${o.id} counts toward the privacy score`);
  }
  return { ok: problems.length === 0, problems, bundleSha256: recomputed };
}
