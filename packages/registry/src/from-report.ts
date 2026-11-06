/**
 * Node-side conversion of a Report into a publishable ScanRecord.
 * `reportJson` must be the exact bytes written to report.json so the
 * embedded sha256 is reproducible by anyone holding that file.
 */
import { createHash } from 'node:crypto';
import type { Report } from '@igris/core';
import { RECORD_VERSION, type ScanRecord } from './record.js';

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function recordFromReport(report: Report, reportJson: string): ScanRecord {
  const leakClasses = [
    ...new Set(report.findings.filter((f) => f.countsTowardScore).map((f) => f.class)),
  ].sort();
  return {
    hostname: report.hostname,
    score: report.score,
    scannedAt: Math.floor(new Date(report.scannedAt).getTime() / 1000),
    scannerVersion: report.scannerVersion,
    reportVersion: report.reportVersion,
    chainId: report.chainId,
    thirdPartyCount: report.thirdParties.length,
    leakCount: report.findings.filter((f) => f.countsTowardScore).length,
    leakClasses: leakClasses.join(','),
    usesAnonRpc: report.usesAnonRpc,
    reportSha256: sha256Hex(reportJson),
    summary: {
      v: RECORD_VERSION,
      status: report.status,
      spoofMetaMask: report.spoofMetaMask,
      canaryAddress: report.canaryAddress,
      findings: report.findings.map((f) => ({
        class: f.class,
        location: f.location,
        encoding: f.encoding,
        category: f.category,
        host: f.host,
        phase: f.phase,
        counted: f.countsTowardScore,
      })),
      thirdParties: report.thirdParties.map((t) => ({
        host: t.host,
        class: t.class,
        phases: t.phases,
      })),
      ledger: report.ledger.map((l) => ({ rule: l.rule, points: l.points, label: l.label })),
      readsViaWallet: report.readsViaWallet,
    },
  };
}
