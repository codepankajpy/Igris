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
 *
 * A draft 3.0.0 scan (cached before `walletRequests` existed: no
 * walletRequests, an igris.evidence.v3 bundle) is checked on its stored
 * files first, then upgraded for display only (core's upgradeDraftReportV3)
 * with a problem saying so; it is never published from the cache.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPORT_V3_VERSION,
  canonicalize,
  contentHash,
  isDraftReportV3,
  upgradeDraftReportV3,
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
  /** Empty when every check passed (never empty for a draft). */
  problems: string[];
  /**
   * Set when the cache holds a draft 3.0.0 scan: `report` / `bundle` are its
   * display upgrade (they hash differently from what was stored), and
   * `evidenceSha256` is the sha256 of the STORED evidence.json bytes — what
   * a published entity's evidenceSha256 must equal. null otherwise.
   */
  draft: { evidenceSha256: string } | null;
}

/** Problem note carried by every draft served from the cache. */
export const DRAFT_NOTE =
  `draft ${REPORT_V3_VERSION} report (cached before wallet requests were recorded): ` +
  'its hashes were checked on the stored files; it is shown upgraded for display only ' +
  '(walletRequests not recorded, evidence re-labelled igris.evidence.v4)';

/**
 * Read a cached scan back, verified. null when the cache has no such scan or
 * its files cannot be parsed as a 3.0.0 report + bundle at all (a draft
 * whose bundle does not hash to what its report claims cannot be upgraded:
 * null too).
 */
export function readCachedScan(dataDir: string, scanId: string): CachedScan | null {
  if (!isScanId(scanId)) return null;
  const dir = dirOf(dataDir, scanId);
  const reportPath = join(dir, REPORT_FILE);
  const evidencePath = join(dir, EVIDENCE_FILE);
  if (!existsSync(reportPath) || !existsSync(evidencePath)) return null;
  let rawReport: unknown;
  let evidenceBytes: Buffer;
  let rawBundle: unknown;
  try {
    rawReport = JSON.parse(readFileSync(reportPath, 'utf8'));
    evidenceBytes = readFileSync(evidencePath);
    rawBundle = JSON.parse(evidenceBytes.toString('utf8'));
  } catch {
    return null;
  }
  if (isDraftReportV3(rawReport, rawBundle)) {
    return readDraft(scanId, rawReport, rawBundle, evidenceBytes);
  }
  let report: ReportV3;
  let bundle: EvidenceBundle;
  try {
    const r = validateReport(rawReport);
    if (r.reportVersion !== REPORT_V3_VERSION) return null;
    report = r as ReportV3;
    bundle = validateEvidenceBundle(rawBundle);
  } catch {
    return null;
  }
  const problems: string[] = [];
  const reportHash = contentHash(report);
  if (reportHash !== scanId) problems.push(`cached report hashes to ${reportHash}, not ${scanId}`);
  const integrity = verifyReportIntegrity(report, bundle);
  problems.push(...integrity.problems);
  return { report, bundle, problems, draft: null };
}

/**
 * A draft 3.0.0 scan: hashes verified on the stored report and evidence
 * bytes FIRST, then upgraded (schema + integrity checked by the upgrade).
 */
function readDraft(
  scanId: string,
  rawReport: unknown,
  rawBundle: unknown,
  evidenceBytes: Buffer,
): CachedScan | null {
  const problems: string[] = [];
  const reportHash = contentHash(rawReport);
  if (reportHash !== scanId) problems.push(`cached report hashes to ${reportHash}, not ${scanId}`);
  const evidenceSha256 = createHash('sha256').update(evidenceBytes).digest('hex');
  const claimed = (rawReport as { evidence?: { sha256?: unknown } }).evidence?.sha256;
  if (evidenceSha256 !== claimed) {
    problems.push(`cached evidence hashes to ${evidenceSha256}, not the report's evidence.sha256`);
  }
  let upgraded: { report: ReportV3; bundle: EvidenceBundle };
  try {
    upgraded = upgradeDraftReportV3(rawReport, rawBundle);
  } catch {
    return null;
  }
  problems.push(DRAFT_NOTE);
  return { ...upgraded, problems, draft: { evidenceSha256 } };
}
