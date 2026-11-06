/**
 * Scan artifacts on disk:
 *   report.json    Report v2, pretty-printed for humans
 *   evidence.json  the evidence bundle as EXACT RFC 8785 canonical bytes,
 *                  so `shasum -a 256 evidence.json` equals report.evidence.sha256
 *
 * Reading accepts v2 (report + evidence) and v1 reports (migrated on the fly,
 * with the migration's notes). Everything read is schema-validated and
 * integrity-checked — a CLI command never acts on an unverified artifact.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  canonicalize,
  isReportV1,
  migrateReportV1toV2,
  validateEvidenceBundle,
  validateReportV2,
  verifyReportIntegrity,
  type ScanResult,
} from '@igris/core';

export const REPORT_FILE = 'report.json';
export const EVIDENCE_FILE = 'evidence.json';

export function writeScanArtifacts(
  dir: string,
  result: ScanResult,
): { report: string; evidence: string } {
  mkdirSync(dir, { recursive: true });
  const report = join(dir, REPORT_FILE);
  const evidence = join(dir, EVIDENCE_FILE);
  writeFileSync(report, JSON.stringify(result.report, null, 2) + '\n');
  writeFileSync(evidence, canonicalize(result.bundle));
  return { report, evidence };
}

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactError';
  }
}

export interface LoadedArtifacts extends ScanResult {
  /** Set when the input was a v1 report migrated on the fly. */
  migratedFrom?: string;
  evidencePath?: string;
}

/**
 * Load report (+ evidence). For v2 the evidence file defaults to
 * `evidence.json` next to the report. Throws ArtifactError with a precise
 * reason on schema or integrity failure.
 */
export function loadScanArtifacts(reportPath: string, evidencePath?: string): LoadedArtifacts {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (err) {
    throw new ArtifactError(`cannot read ${reportPath}: ${(err as Error).message}`);
  }
  if (isReportV1(raw)) {
    const migrated = migrateReportV1toV2(raw);
    return { ...migrated, migratedFrom: (raw as { reportVersion: string }).reportVersion };
  }
  const report = validateReportV2(raw);
  const evPath = evidencePath ?? join(dirname(reportPath), EVIDENCE_FILE);
  if (!existsSync(evPath)) {
    throw new ArtifactError(`evidence bundle not found at ${evPath} (pass --evidence <file>)`);
  }
  let bundleRaw: unknown;
  try {
    bundleRaw = JSON.parse(readFileSync(evPath, 'utf8'));
  } catch (err) {
    throw new ArtifactError(`cannot read ${evPath}: ${(err as Error).message}`);
  }
  const bundle = validateEvidenceBundle(bundleRaw);
  const integrity = verifyReportIntegrity(report, bundle);
  if (!integrity.ok) {
    throw new ArtifactError(`evidence does not match the report: ${integrity.problems.join('; ')}`);
  }
  return { report, bundle, evidencePath: evPath };
}
