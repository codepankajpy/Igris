/**
 * Detector API v1.
 *
 * A detector is a pure function from a Capture (plus scan context) to draft
 * findings. It never assigns ids, never builds the evidence bundle and never
 * scores — the engine does all three, uniformly, and enforces the contract:
 *
 *  1. every draft carries ≥ 1 evidence item, and every item is schema-valid;
 *  2. a security detector's drafts never count toward the privacy score;
 *  3. fingerprints are unique within a detector's output (detectors dedupe);
 *  4. no evidence item may contain the canary address (redaction);
 *  5. a privacy draft that counts toward the score must come from a detector
 *     that has a registered scoring rule (scoring-v2.ts).
 *
 * Violations throw DetectorContractError and fail the scan — a finding
 * without evidence is never silently emitted.
 */
import type { CanaryForms } from '../encodings.js';
import type { Classification } from '../classify.js';
import type { ScanCoverage, ScanStatus } from '../report.js';
import type { Capture } from './capture.js';
import type { EvidenceItem } from './evidence.js';
import type { Confidence, FindingDomain, FindingKind, Severity } from './report-v2.js';

export const DETECTOR_API_VERSION = 1 as const;

export interface DetectorContext {
  target: URL;
  targetRegistrableDomain: string;
  status: ScanStatus;
  coverage: ScanCoverage;
  /** Classify a hostname (first party, analytics, rpc-provider, …). */
  classify(host: string): Classification;
  /** The canary of this scan, in every detectable form. */
  canary: CanaryForms;
  /** True if this URL's request was refused by the egress proxy (never sent). */
  wasBlocked(url: URL): boolean;
}

/** Identity fields of a finding: what makes two findings "the same" across scans. */
export type FingerprintInput = Record<string, string | number | boolean>;

export interface DraftFinding {
  fingerprintInput: FingerprintInput;
  kind: FindingKind;
  severity: Severity;
  confidence: Confidence;
  title: string;
  impact: string;
  remediation: string;
  evidence: EvidenceItem[];
  countsTowardPrivacyScore: boolean;
}

export interface Detector {
  /** Lowercase kebab-case, stable forever (it is part of every fingerprint). */
  id: string;
  /** Semver of the detector's logic. */
  version: string;
  domain: FindingDomain;
  run(capture: Capture, ctx: DetectorContext): DraftFinding[];
}

export class DetectorContractError extends Error {
  constructor(
    public readonly detectorId: string,
    reason: string,
  ) {
    super(`detector "${detectorId}" violated the detector contract: ${reason}`);
    this.name = 'DetectorContractError';
  }
}
