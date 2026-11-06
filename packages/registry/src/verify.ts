/**
 * Read-side verification of a published version (docs/design/FLOW.md,
 * "Verification on read"). Shared by both backends.
 *
 * Checks, all of which must pass for `verified: true`:
 *  - contentHash(report) === scan.scanId;
 *  - bundleHash(bundle) === scan.evidenceSha256 === report.evidence.sha256
 *    (and the evidence entity's own sha256 / scanId attributes agree);
 *  - schema validity of the report (3.0.0) and the bundle;
 *  - verifyReportIntegrity (recomputes recipients and verdicts);
 *  - the entity's derived attributes (hostname, findingSet, coverage, …)
 *    match the report.
 *
 * A payload that cannot be decoded, or that fails schema validation, cannot
 * be handed to a renderer at all: that is a ScanLoadError, not
 * `verified: false`.
 */
import {
  addressReceived,
  bundleHash,
  contentHash,
  REPORT_V3_VERSION,
  summarise,
  validateEvidenceBundle,
  validateReport,
  verifyReportIntegrity,
  type EvidenceBundle,
  type ReportV3,
} from '@igris/core';
import { decodePayload } from './payload.js';
import type { EvidenceRow } from './rows.js';
import type { LoadedScan, PublishedScan } from './site-registry.js';

/** The stored report or evidence of a version cannot be read at all. */
export class ScanLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanLoadError';
  }
}

export function verifyLoaded(
  scan: PublishedScan,
  reportPayload: string | null,
  evidence: EvidenceRow | null,
): LoadedScan {
  const where = `${scan.hostname} v${scan.version}`;
  if (reportPayload === null)
    throw new ScanLoadError(`${where}: the scan entity has no report payload`);
  if (evidence === null) {
    throw new ScanLoadError(
      `${where}: no evidence entity ${scan.evidenceSha256} by ${scan.owner} was found`,
    );
  }
  let reportRaw: unknown;
  let bundleRaw: unknown;
  try {
    reportRaw = decodePayload(reportPayload, 'report');
    bundleRaw = decodePayload(evidence.bundle, 'evidence bundle');
  } catch (err) {
    throw new ScanLoadError(`${where}: ${(err as Error).message}`);
  }
  if ((reportRaw as { reportVersion?: unknown } | null)?.reportVersion !== REPORT_V3_VERSION) {
    throw new ScanLoadError(`${where}: the stored report is not Report ${REPORT_V3_VERSION}`);
  }
  let report: ReportV3;
  let bundle: EvidenceBundle;
  try {
    report = validateReport(reportRaw) as ReportV3;
  } catch (err) {
    throw new ScanLoadError(
      `${where}: the stored report fails schema validation: ${(err as Error).message}`,
    );
  }
  try {
    bundle = validateEvidenceBundle(bundleRaw);
  } catch (err) {
    throw new ScanLoadError(
      `${where}: the stored evidence bundle fails schema validation: ${(err as Error).message}`,
    );
  }

  const problems: string[] = [];
  const scanId = contentHash(report);
  if (scanId !== scan.scanId) problems.push(`report hash ${scanId} != scanId ${scan.scanId}`);
  if (report.scan.hostname !== scan.hostname)
    problems.push(`report is for ${report.scan.hostname}, entity says ${scan.hostname}`);
  const bundleSha = bundleHash(bundle);
  if (bundleSha !== scan.evidenceSha256)
    problems.push(`evidence hash ${bundleSha} != entity evidenceSha256 ${scan.evidenceSha256}`);
  if (bundleSha !== report.evidence.sha256)
    problems.push(`evidence hash ${bundleSha} != report.evidence.sha256 ${report.evidence.sha256}`);
  if (evidence.sha256 !== scan.evidenceSha256 || evidence.scanId !== scan.scanId)
    problems.push('evidence entity attributes do not match the scan entity');
  if (evidence.bundleVersion !== bundle.bundleVersion)
    problems.push(
      `evidence entity says ${evidence.bundleVersion}, bundle is ${bundle.bundleVersion}`,
    );

  const integrity = verifyReportIntegrity(report, bundle);
  problems.push(...integrity.problems);

  // The indexed attributes people filter on must say what the report says.
  const expect: Array<[string, unknown, unknown]> = [
    ['findingSetSha256', scan.findingSetSha256, report.findingSet.sha256],
    ['coverage', scan.coverage, report.privacy.coverage],
    ['state', scan.state, summarise(report, bundle).state],
    ['recipients', scan.recipients, report.recipients.length],
    [
      'addressRecipients',
      scan.addressRecipients,
      report.recipients.filter((r) => addressReceived(r.learned.address)).length,
    ],
    [
      'trackingRecipients',
      scan.trackingRecipients,
      report.recipients.filter((r) => r.verdict === 'tracking' || r.verdict === 'unidentified')
        .length,
    ],
    ['usesAnonRpc', scan.usesAnonRpc, report.wallet.usesAnonRpc],
    ['scannerVersion', scan.scannerVersion, report.scan.scannerVersion],
    ['scannedAt', scan.scannedAt, Math.floor(Date.parse(report.scan.scannedAt) / 1000)],
  ];
  for (const [name, entity, fromReport] of expect) {
    if (entity !== fromReport)
      problems.push(`entity ${name} ${String(entity)} != report ${String(fromReport)}`);
  }
  return { report, bundle, verified: problems.length === 0, problems };
}
