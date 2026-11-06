/**
 * Node-side conversion of a scan result (Report v2 + evidence bundle) into a
 * publishable ScanRecord (entity schema igris.scan.v1, summary v2).
 *
 * Hashes are content hashes (sha256 over RFC 8785 canonical JSON), so they
 * do not depend on how report.json was formatted:
 *  - reportSha256   = contentHash(report)
 *  - evidenceSha256 = contentHash(bundle) = report.evidence.sha256
 * Integrity is verified before anything is built: a report whose bundle does
 * not match is never turned into a record.
 */
import {
  contentHash,
  verifyReportIntegrity,
  type CanaryMatchEvidence,
  type DocumentHeadersEvidence,
  type EvidenceBundleV1,
  type ReportV2,
} from '@igris/core';
import { RECORD_VERSION, type ScanRecord, type SummaryPayload } from './record.js';

/** Thrown when a report must not be published. */
export class UnpublishableReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnpublishableReportError';
  }
}

export function recordFromReport(report: ReportV2, bundle: EvidenceBundleV1): ScanRecord {
  const host = report.scan.hostname;
  // Nothing measured (page never loaded) → no claim on a public registry.
  if (report.privacy.score === null || report.scan.status === 'page-load-failed') {
    throw new UnpublishableReportError(
      `refusing to publish ${host}: status ${report.scan.status}, no score (nothing was measured)`,
    );
  }
  const integrity = verifyReportIntegrity(report, bundle);
  if (!integrity.ok) {
    throw new UnpublishableReportError(
      `refusing to publish ${host}: evidence does not match the report (${integrity.problems[0]})`,
    );
  }

  const canary = report.privacy.findings.filter((f) => f.detector === 'canary-leak');
  const matches = canary.map((f) => ({
    finding: f,
    e: bundle.items[f.evidence[0]!.id] as CanaryMatchEvidence,
  }));
  const counted = matches.filter((m) => m.finding.countsTowardPrivacyScore);
  const leakClasses = [...new Set(counted.map((m) => m.e.recipientClass))].sort();
  const doc = Object.values(bundle.items).find(
    (i): i is DocumentHeadersEvidence => i.type === 'document-headers',
  );
  const t = report.telemetry;

  const summary: SummaryPayload = {
    v: RECORD_VERSION,
    status: report.scan.status,
    coverage: report.privacy.coverage,
    spoofMetaMask: report.scan.spoofMetaMask,
    canaryAddress: report.scan.canaryAddress,
    evidenceSha256: report.evidence.sha256,
    findings: matches.map(({ finding, e }) => ({
      class: e.recipientClass,
      location: e.location,
      encoding: e.encoding,
      category: e.category,
      host: e.host,
      phase: e.phase,
      counted: finding.countsTowardPrivacyScore,
    })),
    thirdParties: report.contacts.map((c) => ({
      host: c.host,
      class: c.class,
      phases: c.phases,
      requestCount: c.requestCount,
      ...(c.methods ? { methods: c.methods } : {}),
    })),
    ledger: report.privacy.ledger.map((l) => ({ rule: l.rule, points: l.points, label: l.label })),
    readsViaWallet: report.wallet.readsViaWallet,
    ...(t && t.wsConnections !== null
      ? {
          telemetry: {
            totalRequests: t.totalRequests,
            preConnectRequests: t.preConnectRequests,
            postConnectRequests: t.postConnectRequests,
            wsConnections: t.wsConnections,
            ...(t.wsFrames !== null ? { wsFrames: t.wsFrames } : {}),
          },
        }
      : {}),
    ...(doc
      ? {
          securityHeaders: {
            source: 'main-document' as const,
            documentStatus: doc.status,
            cspPresent: doc.headers['content-security-policy'] !== null,
            cspReportOnly: doc.headers['content-security-policy-report-only'] !== null,
            hstsPresent: doc.headers['strict-transport-security'] !== null,
            ...(doc.headers['x-frame-options'] !== null
              ? { xFrameOptions: doc.headers['x-frame-options'] }
              : {}),
          },
        }
      : {}),
    ...(report.scan.connectionLog.length ? { connectionLog: report.scan.connectionLog } : {}),
  };

  return {
    hostname: host,
    score: report.privacy.score,
    scannedAt: Math.floor(new Date(report.scan.scannedAt).getTime() / 1000),
    scannerVersion: report.scan.scannerVersion,
    reportVersion: report.reportVersion,
    chainId: report.scan.chainId,
    thirdPartyCount: report.contacts.length,
    leakCount: counted.length,
    leakClasses: leakClasses.join(','),
    usesAnonRpc: report.wallet.usesAnonRpc,
    reportSha256: contentHash(report),
    summary,
  };
}
