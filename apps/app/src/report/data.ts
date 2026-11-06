/**
 * What the report view draws, from either source the backend offers:
 *  - a published version (GET /api/sites/:hostname/versions/:n), or
 *  - a completed scan that is not published yet, read from the server's
 *    cache (GET /api/scans/:id/report).
 * Nothing here is computed: the two responses are only put in one shape, with
 * `scan` (the registry entity) null when there is no published version.
 */
import type { EvidenceBundle, ReportV3 } from '@igris/core/contracts';
import {
  api,
  type Changes,
  type PublishedScan,
  type ScanReportResponse,
  type Summary,
  type VersionResponse,
} from '../api.js';
import type { ReportRef } from '../router.js';

export interface ReportData {
  ref: ReportRef;
  hostname: string;
  /** The published registry entity; null for a scan not published yet. */
  scan: PublishedScan | null;
  report: ReportV3;
  evidence: EvidenceBundle;
  verified: boolean;
  problems: string[];
  summary: Summary;
  changes: Changes | null;
  source: 'arkiv' | 'local';
}

export function fromVersion(v: VersionResponse): ReportData {
  return {
    ref: { kind: 'version', hostname: v.scan.hostname, version: v.scan.version },
    hostname: v.scan.hostname,
    scan: v.scan,
    report: v.report,
    evidence: v.evidence,
    verified: v.verified,
    problems: v.problems,
    summary: v.summary,
    changes: v.changes,
    source: v.source,
  };
}

export function fromScanReport(
  job: { id: string; hostname: string },
  r: ScanReportResponse,
): ReportData {
  return {
    ref: { kind: 'scan', id: job.id },
    hostname: job.hostname,
    scan: null,
    report: r.report,
    evidence: r.evidence,
    verified: r.verified,
    problems: r.problems,
    summary: r.summary,
    changes: null,
    source: r.source,
  };
}

/** Published versions are immutable: cache them for the session. */
const versionCache = new Map<string, Promise<VersionResponse>>();
export function loadVersion(hostname: string, n: number): Promise<VersionResponse> {
  const k = `${hostname}@${n}`;
  let p = versionCache.get(k);
  if (!p) {
    p = api.version(hostname, n);
    p.catch(() => versionCache.delete(k));
    versionCache.set(k, p);
  }
  return p;
}

/** An unpublished scan's cached report (its content never changes for a job id). */
const scanCache = new Map<string, Promise<ReportData>>();
export function loadScanReport(id: string): Promise<ReportData> {
  let p = scanCache.get(id);
  if (!p) {
    p = Promise.all([api.job(id), api.scanReport(id)]).then(([job, r]) => fromScanReport(job, r));
    p.catch(() => scanCache.delete(id));
    scanCache.set(id, p);
  }
  return p;
}

export function loadReport(ref: ReportRef): Promise<ReportData> {
  return ref.kind === 'version'
    ? loadVersion(ref.hostname, ref.version).then(fromVersion)
    : loadScanReport(ref.id);
}
