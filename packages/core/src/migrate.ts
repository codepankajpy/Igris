/**
 * Report v1 (1.0.0 / 1.1.0) → Report v2 + evidence bundle.
 *
 * Guarantees (regression-tested over every committed v1 report):
 *  - the output validates against the v2 schemas;
 *  - every v1 finding becomes exactly one v2 canary-leak finding whose
 *    evidence carries the v1 fields unchanged;
 *  - the privacy score is identical wherever the v1 score was valid. A v1
 *    "page-load-failed" report is migrated with score null (1.0.0 wrongly
 *    scored those 100). Any other mismatch throws MigrationError — the
 *    migration never silently changes a score;
 *  - known v1 DEFECTS are corrected explicitly, never silently: a "third
 *    party" with an empty hostname (a pre-b915636 scanner bug — such
 *    contacts were also charged IP-exposure penalties) is removed; when that
 *    changes the score, the old and new score and the reason go into
 *    scan.notes. This is the ONLY permitted score change;
 *  - nothing is invented: values v1 did not record become null / "unknown",
 *    and security headers are NOT migrated (1.0.0 read them from request
 *    headers, so they were wrong; 1.1.0 kept only booleans, too little to
 *    build document-headers evidence). Each such gap is stated in scan.notes.
 */
import { REPORT_JSON_SCHEMA, coverageForStatus, type Report as ReportV1 } from './report.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { CANONICALIZATION } from './contracts/hash.js';
import {
  EVIDENCE_BUNDLE_VERSION,
  bundleHash,
  type CanaryMatchEvidence,
  type EvidenceItem,
} from './contracts/evidence.js';
import { REPORT_V2_VERSION, type ReportV2, type TelemetryV2 } from './contracts/report-v2.js';
import { validateEvidenceBundle, validateReportV2 } from './contracts/validate.js';
import { findingSetDigest } from './contracts/verify.js';
import {
  CANARY_LEAK_DETECTOR_ID,
  CANARY_LEAK_DETECTOR_VERSION,
  canaryLeakDraftFromEvidence,
} from './detectors/canary-leak.js';
import {
  IP_EXPOSURE_DETECTOR_ID,
  IP_EXPOSURE_DETECTOR_VERSION,
  ipExposureDrafts,
} from './detectors/ip-exposure.js';
import { buildCanaryForms } from './encodings.js';
import {
  assertCanaryFree,
  buildBundle,
  finalizeDrafts,
  partitionFindings,
  type ScanResult,
} from './engine.js';
import { scorePrivacy } from './scoring-v2.js';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

let v1Validator: (((v: unknown) => boolean) & { errors?: unknown }) | undefined;
function validateV1(value: unknown): ReportV1 {
  if (!v1Validator) {
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    v1Validator = ajv.compile(REPORT_JSON_SCHEMA);
  }
  if (!v1Validator(value)) {
    throw new MigrationError(
      `not a valid v1 report: ${JSON.stringify(v1Validator.errors).slice(0, 300)}`,
    );
  }
  const r = value as ReportV1;
  if (r.reportVersion !== '1.0.0' && r.reportVersion !== '1.1.0') {
    throw new MigrationError(`unsupported v1 reportVersion ${r.reportVersion}`);
  }
  return r;
}

export function isReportV1(value: unknown): boolean {
  const v = (value as { reportVersion?: unknown })?.reportVersion;
  return typeof v === 'string' && /^1\.\d+\.\d+$/.test(v);
}

export function migrateReportV1toV2(input: unknown): ScanResult {
  const v1 = validateV1(input);
  const notes = [...v1.errors];
  // Known v1 defect: contacts with an empty hostname (scanner bug fixed in
  // b915636). They are not third parties; v1 nonetheless charged for them.
  const thirdParties = v1.thirdParties.filter((t) => t.host !== '');
  const phantomContacts = v1.thirdParties.length - thirdParties.length;
  if (phantomContacts > 0) {
    notes.push(
      `migration: removed ${phantomContacts} third-party contact(s) with an empty hostname (v1 scanner defect fixed in b915636)`,
    );
  }
  const items = new Map<string, EvidenceItem>();

  // --- canary-leak: one v2 finding per v1 finding, fields carried verbatim ---
  const canaryDrafts = v1.findings.map((f) => {
    const evidence: CanaryMatchEvidence = {
      type: 'canary-match',
      phase: f.phase,
      location: f.location,
      method: f.method,
      url: f.url,
      host: f.host,
      registrableDomain: f.registrableDomain,
      recipientClass: f.class,
      encoding: f.encoding,
      category: f.category,
      snippet: f.snippet,
    };
    let path = f.url;
    try {
      const u = new URL(f.url);
      path = `${u.hostname}${u.pathname}`;
    } catch {
      /* pseudo-URLs (cookie://, local-storage://) keep the raw form */
    }
    return canaryLeakDraftFromEvidence(evidence, f.countsTowardScore, {
      phase: f.phase,
      location: f.location,
      method: f.method,
      host: f.host,
      path,
      encoding: f.encoding,
    });
  });
  const canary = finalizeDrafts(
    { id: CANARY_LEAK_DETECTOR_ID, version: CANARY_LEAK_DETECTOR_VERSION, domain: 'privacy' },
    canaryDrafts,
    items,
  );
  const ip = finalizeDrafts(
    { id: IP_EXPOSURE_DETECTOR_ID, version: IP_EXPOSURE_DETECTOR_VERSION, domain: 'privacy' },
    ipExposureDrafts(thirdParties),
    items,
  );

  if (v1.securityHeaders) {
    notes.push(
      v1.reportVersion === '1.0.0'
        ? 'migration: security headers not migrated — report 1.0.0 read them from request headers, so they were incorrect'
        : 'migration: security headers not migrated — report 1.1.0 recorded only booleans, not header values',
    );
  }

  const bundle = buildBundle(items);
  assertCanaryFree(bundle, buildCanaryForms(v1.canaryAddress));
  const { privacy, security } = partitionFindings([...canary, ...ip]);
  const coverage = v1.coverage ?? coverageForStatus(v1.status);
  const { score, ledger } = scorePrivacy(privacy, bundle, coverage);

  if (v1.status === 'page-load-failed') {
    if (v1.score !== null) {
      notes.push(
        `migration: v1 score ${v1.score} dropped — the page never loaded, so nothing was measured`,
      );
    }
  } else if (v1.score !== score && phantomContacts > 0) {
    notes.push(
      `migration: privacy score ${String(v1.score)} → ${String(score)} because v1 charged IP-exposure penalties for the removed empty-hostname contact(s)`,
    );
  } else if (v1.score !== score) {
    throw new MigrationError(
      `score mismatch for ${v1.hostname}: v1 ${String(v1.score)} vs v2 ${String(score)} — refusing to migrate`,
    );
  }

  let telemetry: TelemetryV2 | null = null;
  if (v1.summary) {
    telemetry = {
      totalRequests: v1.summary.totalRequests,
      preConnectRequests: v1.summary.preConnectRequests,
      postConnectRequests: v1.summary.postConnectRequests,
      // 1.0.0 stored the FRAME count under wsConnections.
      wsConnections: v1.reportVersion === '1.0.0' ? null : v1.summary.wsConnections,
      wsFrames:
        v1.reportVersion === '1.0.0' ? v1.summary.wsConnections : (v1.summary.wsFrames ?? null),
      cookiesCount: v1.summary.cookiesCount,
      localStorageCount: v1.summary.localStorageCount,
      sessionStorageCount: v1.summary.sessionStorageCount,
    };
  } else {
    notes.push('migration: no telemetry recorded in the v1 report');
  }

  const report: ReportV2 = {
    reportVersion: REPORT_V2_VERSION,
    scan: {
      target: v1.target,
      hostname: v1.hostname,
      scannedAt: v1.scannedAt,
      chainId: v1.chainId,
      status: v1.status,
      scannerVersion: v1.scannerVersion,
      spoofMetaMask: v1.spoofMetaMask,
      canaryAddress: v1.canaryAddress,
      egress: 'unknown',
      connectionLog: v1.connectionLog ?? [],
      notes,
    },
    detectors: [
      { id: CANARY_LEAK_DETECTOR_ID, version: CANARY_LEAK_DETECTOR_VERSION, domain: 'privacy' },
      { id: IP_EXPOSURE_DETECTOR_ID, version: IP_EXPOSURE_DETECTOR_VERSION, domain: 'privacy' },
    ],
    privacy: { score, coverage, ledger, findings: privacy },
    security: { observations: security },
    contacts: thirdParties,
    wallet: { readsViaWallet: v1.readsViaWallet, usesAnonRpc: v1.usesAnonRpc },
    telemetry,
    evidence: {
      bundleVersion: EVIDENCE_BUNDLE_VERSION,
      canonicalization: CANONICALIZATION,
      sha256: bundleHash(bundle),
      itemCount: items.size,
    },
    findingSet: findingSetDigest([...privacy, ...security]),
    migratedFrom: v1.reportVersion,
  };
  validateEvidenceBundle(bundle);
  validateReportV2(report);
  return { report, bundle };
}
