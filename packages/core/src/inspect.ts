/**
 * Convenience views over a ScanResult for scripts, tests and tools.
 * Pure; they read the report and resolve evidence from the bundle.
 */
import type { CanaryMatchEvidence } from './contracts/evidence.js';
import type { PrivacyFinding } from './contracts/report-v2.js';
import { CANARY_LEAK_DETECTOR_ID } from './detectors/canary-leak.js';
import type { ScanResult } from './engine.js';

export interface CanaryLeak {
  finding: PrivacyFinding;
  evidence: CanaryMatchEvidence;
}

/** Every canary-leak finding with its (single) canary-match evidence item. */
export function canaryLeaks(result: ScanResult): CanaryLeak[] {
  return result.report.privacy.findings
    .filter((f) => f.detector === CANARY_LEAK_DETECTOR_ID)
    .map((finding) => ({
      finding,
      evidence: result.bundle.items[finding.evidence[0]!.id] as CanaryMatchEvidence,
    }));
}

/** Canary leaks that count toward the privacy score. */
export function countedLeaks(result: ScanResult): CanaryLeak[] {
  return canaryLeaks(result).filter((l) => l.finding.countsTowardPrivacyScore);
}
