/**
 * CI gate: compare a new scan report against a baseline. Fails (exit 1) when
 * the new report adds a leak class that the baseline did not have, or when
 * the score dropped. Intended for the PR workflow in
 * .github/workflows/privacy-gate.yml.example.
 *
 * Usage: pnpm exec tsx scripts/ci-compare.ts <baseline-report.json> <new-report.json>
 */
import { readFileSync } from 'node:fs';
import type { Report } from '@igris/core';

const [baselinePath, newPath] = process.argv.slice(2);
if (!baselinePath || !newPath) {
  console.error('usage: ci-compare.ts <baseline-report.json> <new-report.json>');
  process.exit(3);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Report;
const next = JSON.parse(readFileSync(newPath, 'utf8')) as Report;

const classesOf = (r: Report) =>
  new Set(r.findings.filter((f) => f.countsTowardScore).map((f) => f.class));

const before = classesOf(baseline);
const after = classesOf(next);
const newClasses = [...after].filter((c) => !before.has(c));

let failed = false;
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
