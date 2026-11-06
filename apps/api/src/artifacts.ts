/**
 * The LOCAL CACHE of finished scans: <dataDir>/cache/<scanId>/
 *   report.json    Report 3.0.0, pretty-printed for humans
 *   evidence.json  the igris.evidence.v3 bundle as EXACT RFC 8785 canonical
 *                  bytes, so `shasum -a 256 evidence.json` equals
 *                  report.evidence.sha256
 *
 * scanId = contentHash(report). The cache is a fallback and a staging area
 * (a scan whose publish failed is retried from here); the registry is the
 * source of truth. Everything read back is re-verified — schema, report
 * hash, bundle hash, integrity — and never trusted because it is on disk.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPORT_V3_VERSION,
  canonicalize,
  contentHash,
  validateEvidenceBundle,
  validateReport,
  verifyReportIntegrity,
  type EvidenceBundle,
  type ReportV3,
} from '@igris/core';

export const REPORT_FILE = 'report.json';
export const EVIDENCE_FILE = 'evidence.json';

const SCAN_ID_RE = /^[0-9a-f]{64}$/;

export function isScanId(s: string): boolean {
  return SCAN_ID_RE.test(s);
}

function dirOf(dataDir: string, scanId: string): string {
  if (!isScanId(scanId)) throw new Error(`not a scan id: ${scanId.slice(0, 80)}`);
  return join(dataDir, 'cache', scanId);
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** Write a finished scan to the cache; returns its scanId (contentHash(report)). */
export function writeCachedScan(dataDir: string, report: ReportV3, bundle: EvidenceBundle): string {
  const scanId = contentHash(report);
  const dir = dirOf(dataDir, scanId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(join(dir, EVIDENCE_FILE), canonicalize(bundle));
  writeAtomic(join(dir, REPORT_FILE), JSON.stringify(report, null, 2) + '\n');
  return scanId;
}

export interface CachedScan {
  report: ReportV3;
  bundle: EvidenceBundle;
  /** Empty when every check passed. */
  problems: string[];
}

/**
 * Read a cached scan back, verified. null when the cache has no such scan or
 * its files cannot be parsed as a 3.0.0 report + bundle at all.
 */
export function readCachedScan(dataDir: string, scanId: string): CachedScan | null {
  if (!isScanId(scanId)) return null;
  const dir = dirOf(dataDir, scanId);
  const reportPath = join(dir, REPORT_FILE);
  const evidencePath = join(dir, EVIDENCE_FILE);
  if (!existsSync(reportPath) || !existsSync(evidencePath)) return null;
  let report: ReportV3;
  let bundle: EvidenceBundle;
  try {
    const r = validateReport(JSON.parse(readFileSync(reportPath, 'utf8')));
    if (r.reportVersion !== REPORT_V3_VERSION) return null;
    report = r as ReportV3;
    bundle = validateEvidenceBundle(JSON.parse(readFileSync(evidencePath, 'utf8')));
  } catch {
    return null;
  }
  const problems: string[] = [];
  const reportHash = contentHash(report);
  if (reportHash !== scanId) problems.push(`cached report hashes to ${reportHash}, not ${scanId}`);
  const integrity = verifyReportIntegrity(report, bundle);
  problems.push(...integrity.problems);
  return { report, bundle, problems };
}
