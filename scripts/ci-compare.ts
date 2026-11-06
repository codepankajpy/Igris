/**
 * CI gate: compare a new scan report against a baseline. Fails (exit 1) when
 * the new report adds a leak class that the baseline did not have, or when
 * the score dropped. Intended for the PR workflow in
 * .github/workflows/privacy-gate.yml.example.
 *
 * Usage: pnpm exec tsx scripts/ci-compare.ts <baseline-report.json> <new-report.json>
 */
import { loadScanArtifacts } from '@igris/cli';
import { countedLeaks, type ScanResult } from '@igris/core';

const [baselinePath, newPath] = process.argv.slice(2);
if (!baselinePath || !newPath) {
  console.error('usage: ci-compare.ts <baseline-report.json> <new-report.json>');
  process.exit(3);
}

// Both artifacts are schema-validated and integrity-checked (v1 migrated).
const baselineResult: ScanResult = loadScanArtifacts(baselinePath);
const nextResult: ScanResult = loadScanArtifacts(newPath);
const baseline = {
  score: baselineResult.report.privacy.score,
  status: baselineResult.report.scan.status,
};
const next = { score: nextResult.report.privacy.score, status: nextResult.report.scan.status };

const classesOf = (r: ScanResult) => new Set(countedLeaks(r).map((l) => l.evidence.recipientClass));

const before = classesOf(baselineResult);
const after = classesOf(nextResult);
const newClasses = [...after].filter((c) => !before.has(c));

let failed = false;
// An unscored report (page never loaded) proves nothing either way: fail
// closed rather than letting a broken scan pass the gate.
if (baseline.score === null || next.score === null) {
  console.error(
    `FAIL: cannot compare: ${baseline.score === null ? 'baseline' : 'new'} report is not scored (status ${
      baseline.score === null ? baseline.status : next.status
    })`,
  );
  process.exit(1);
}
if (newClasses.length > 0) {
  console.error(`FAIL: new leak class(es) introduced: ${newClasses.join(', ')}`);
  failed = true;
}
if (next.score < baseline.score) {
  console.error(`FAIL: privacy score dropped ${baseline.score} → ${next.score}`);
  failed = true;
}
if (!failed) {
  console.log(
    `OK: score ${baseline.score} → ${next.score}, leak classes ${[...after].sort().join(', ') || 'none'} (no new ones)`,
  );
}
process.exit(failed ? 1 : 0);
