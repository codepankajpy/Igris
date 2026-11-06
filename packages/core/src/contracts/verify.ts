/**
 * Integrity check of a report against its evidence bundle (browser-safe; no
 * schema validation here — see validate.ts for that). Answers: does this
 * bundle hash to what the report claims, and does every finding's evidence
 * resolve to an item of the claimed type whose id matches its content?
 */
import { bundleHash, evidenceId, type EvidenceBundleV1 } from './evidence.js';
import type { ReportV2 } from './report-v2.js';

export interface IntegrityResult {
  ok: boolean;
  problems: string[];
  /** Hash recomputed from the bundle. */
  bundleSha256: string;
}

export function verifyReportIntegrity(report: ReportV2, bundle: EvidenceBundleV1): IntegrityResult {
  const problems: string[] = [];
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
