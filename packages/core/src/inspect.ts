/**
 * Convenience views over a ScanResult for scripts, tests and tools.
 * Pure; they read the report and resolve evidence from the bundle.
 */
import type { CanaryMatchEvidence, EvidenceBundle } from './contracts/evidence.js';
import type { PrivacyFindingV3, ReportAny } from './contracts/report-v3.js';
import { CANARY_LEAK_DETECTOR_ID } from './detectors/canary-leak.js';

export interface CanaryLeak {
  finding: PrivacyFindingV3;
  evidence: CanaryMatchEvidence;
}

/** Every canary-leak finding with its (single) canary-match evidence item. */
export function canaryLeaks(result: { report: ReportAny; bundle: EvidenceBundle }): CanaryLeak[] {
  return result.report.privacy.findings
    .filter((f) => f.detector === CANARY_LEAK_DETECTOR_ID)
    .map((finding) => ({
      finding,
      evidence: result.bundle.items[finding.evidence[0]!.id] as CanaryMatchEvidence,
    }));
}

/**
 * Canary leaks that are issues: the address (exact or hashed) provably
 * reached a third party. Storage / first-party / Anon-RPC matches are
 * observations and truncated forms are risks, so neither is included.
 */
export function addressLeaks(result: { report: ReportAny; bundle: EvidenceBundle }): CanaryLeak[] {
  return canaryLeaks(result).filter((l) => l.finding.kind === 'issue');
}

/** @deprecated 3.0.0 has no score; use addressLeaks (same set: the 2.x counted leaks). */
export const countedLeaks = addressLeaks;
