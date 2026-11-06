/**
 * The detector engine: runs detectors over a Capture, enforces the detector
 * contract, assigns fingerprint-derived ids, builds the content-addressed
 * evidence bundle, scores privacy, and assembles a schema-valid Report v2.
 *
 * Everything that makes a report trustworthy happens here, once, for every
 * detector — detectors cannot opt out of it.
 */
import { classifyHost, registrableDomain } from './classify.js';
import { buildCanaryForms, type CanaryForms } from './encodings.js';
import { findCanary } from './detect.js';
import {
  coverageForStatus,
  type ScanCoverage,
  type ScanStatus,
  type WalletRead,
} from './report.js';
import type { ThirdPartyEntry } from './third-parties.js';
import { canonicalize } from './contracts/canonical.js';
import { contentHash, CANONICALIZATION } from './contracts/hash.js';
import type { Capture } from './contracts/capture.js';
import {
  DetectorContractError,
  type Detector,
  type DetectorContext,
  type DraftFinding,
} from './contracts/detector.js';
import {
  EVIDENCE_BUNDLE_VERSION,
  bundleHash,
  evidenceId,
  type EvidenceBundleV1,
  type EvidenceItem,
} from './contracts/evidence.js';
import {
  REPORT_V2_VERSION,
  type ConnectionDiagnostics,
  type ScanFailure,
  type DetectorRun,
  type FindingV2,
  type PrivacyFinding,
  type ReportV2,
  type SecurityObservation,
} from './contracts/report-v2.js';
import {
  validateEvidenceItem,
  validateEvidenceBundle,
  validateReportV2,
} from './contracts/validate.js';
import { findingSetDigest } from './contracts/verify.js';
import { canaryLeakDetector } from './detectors/canary-leak.js';
import { computeContacts, ipExposureDetector } from './detectors/ip-exposure.js';
import { securityHeadersDetector } from './detectors/security-headers.js';
import { hasScoringRule, scorePrivacy } from './scoring-v2.js';

export const DEFAULT_DETECTORS: readonly Detector[] = [
  canaryLeakDetector,
  ipExposureDetector,
  securityHeadersDetector,
];

export interface ScanResult {
  report: ReportV2;
  bundle: EvidenceBundleV1;
}

export class RedactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedactionError';
  }
}

/** "F-" + first 16 hex of the fingerprint. */
export function findingIdFromFingerprint(fingerprint: string): string {
  return `F-${fingerprint.slice(0, 16)}`;
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;

/**
 * Turn one detector's drafts into findings, enforcing the contract and
 * adding their evidence to `items`. Shared by the engine and the migration.
 */
export function finalizeDrafts(
  detector: Pick<Detector, 'id' | 'version' | 'domain'>,
  drafts: DraftFinding[],
  items: Map<string, EvidenceItem>,
): FindingV2[] {
  const seen = new Set<string>();
  const findings: FindingV2[] = [];
  for (const d of drafts) {
    if (!Array.isArray(d.evidence) || d.evidence.length === 0) {
      throw new DetectorContractError(detector.id, `finding "${d.title}" has no evidence`);
    }
    if (detector.domain === 'security' && d.countsTowardPrivacyScore) {
      throw new DetectorContractError(
        detector.id,
        'a security finding cannot count toward the privacy score',
      );
    }
    if (
      detector.domain === 'privacy' &&
      d.countsTowardPrivacyScore &&
      !hasScoringRule(detector.id)
    ) {
      throw new DetectorContractError(
        detector.id,
        'counted privacy finding without a registered scoring rule',
      );
    }
    const refs = d.evidence.map((item) => {
      try {
        validateEvidenceItem(item);
      } catch (err) {
        throw new DetectorContractError(detector.id, `invalid evidence: ${(err as Error).message}`);
      }
      const id = evidenceId(item);
      items.set(id, item);
      return { id, type: item.type };
    });
    const fingerprint = contentHash({ detector: detector.id, ...d.fingerprintInput });
    if (seen.has(fingerprint)) {
      throw new DetectorContractError(
        detector.id,
        `duplicate finding identity ${canonicalize(d.fingerprintInput)}`,
      );
    }
    seen.add(fingerprint);
    findings.push({
      id: findingIdFromFingerprint(fingerprint),
      fingerprint,
      detector: detector.id,
      detectorVersion: detector.version,
      domain: detector.domain,
      kind: d.kind,
      severity: d.severity,
      confidence: d.confidence,
      title: d.title,
      impact: d.impact,
      remediation: d.remediation,
      // Stable order, no duplicates (two drafts may share an item).
      evidence: [...new Map(refs.map((r) => [r.id, r])).values()].sort((a, b) =>
        a.id < b.id ? -1 : 1,
      ),
      countsTowardPrivacyScore: d.countsTowardPrivacyScore,
    });
  }
  return findings;
}

/** Deterministic order: severity, then detector, then id. */
export function sortFindings<T extends FindingV2>(findings: T[]): T[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.detector < b.detector ? -1 : a.detector > b.detector ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Build the bundle with keys in sorted order (cosmetic; the hash is canonical anyway). */
export function buildBundle(items: Map<string, EvidenceItem>): EvidenceBundleV1 {
  const sorted = [...items.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  return { bundleVersion: EVIDENCE_BUNDLE_VERSION, items: Object.fromEntries(sorted) };
}

/** Refuse to publish a bundle that contains the canary in any detectable form. */
export function assertCanaryFree(bundle: EvidenceBundleV1, forms: CanaryForms): void {
  const text = canonicalize(bundle);
  const hits = findCanary(text, forms);
  if (hits.length > 0) {
    throw new RedactionError(
      `evidence bundle contains the canary (${hits[0]!.encoding}); refusing to build it`,
    );
  }
}

/** Split findings by domain into the two report sections (with runtime checks). */
export function partitionFindings(findings: FindingV2[]): {
  privacy: PrivacyFinding[];
  security: SecurityObservation[];
} {
  const privacy: PrivacyFinding[] = [];
  const security: SecurityObservation[] = [];
  for (const f of findings) {
    if (f.domain === 'privacy') privacy.push(f as PrivacyFinding);
    else if (!f.countsTowardPrivacyScore) security.push(f as SecurityObservation);
    else
      throw new DetectorContractError(
        f.detector,
        'security observation counts toward the privacy score',
      );
  }
  return { privacy: sortFindings(privacy), security: sortFindings(security) };
}

export interface ScanResultInput {
  target: string;
  canaryAddress: string;
  chainId: number;
  spoofMetaMask: boolean;
  scannerVersion: string;
  scannedAt: string;
  status: ScanStatus;
  egress: 'unrestricted' | 'public-only';
  capture: Capture;
  wallet: { readsViaWallet: WalletRead[]; usesAnonRpc: boolean };
  thirdPartyDb: ThirdPartyEntry[];
  firstParty?: string[];
  notes: string[];
  connectionLog?: string[];
  /** 2.1.0: structured connect-phase diagnostics (scanner-produced). */
  connection?: ConnectionDiagnostics;
  /** 2.1.0: why nothing was measured, when status is page-load-failed. */
  failure?: ScanFailure;
  /** "host:port" pairs refused by the egress proxy (never sent). */
  excludeHosts?: Set<string>;
  detectors?: readonly Detector[];
}

function defaultPort(protocol: string): number {
  return protocol === 'https:' || protocol === 'wss:' ? 443 : 80;
}

/** The main document's registrable domain when it differs from the target's. */
function landedRegistrableDomain(
  capture: Capture,
  targetRd: string,
): { host: string; registrableDomain: string } | undefined {
  if (!capture.mainDocument) return undefined;
  let host: string;
  try {
    host = new URL(capture.mainDocument.url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const rd = registrableDomain(host);
  return rd && rd !== targetRd ? { host, registrableDomain: rd } : undefined;
}

export function buildScanResult(input: ScanResultInput): ScanResult {
  const targetUrl = new URL(input.target);
  const canary = buildCanaryForms(input.canaryAddress);
  const coverage: ScanCoverage = coverageForStatus(input.status);
  const targetRd = registrableDomain(targetUrl.hostname);
  // The dApp is the page that actually loaded. When the target redirects to
  // another site (app.spark.fi → app.spark.finance), that site's own servers
  // are first party too — otherwise its own API is scored as a third party.
  // Derived from the captured main document only, and stated in the notes.
  const landed = landedRegistrableDomain(input.capture, targetRd);
  const firstParty = [...(input.firstParty ?? []), ...(landed ? [landed.registrableDomain] : [])];
  const notes = landed
    ? [
        ...input.notes,
        `the target redirected to ${landed.host}; ${landed.registrableDomain} is treated as first party`,
      ]
    : input.notes;
  const classifyOpts = {
    targetRegistrableDomain: targetRd,
    db: input.thirdPartyDb,
    ...(firstParty.length ? { firstParty } : {}),
  };
  const exclude = input.excludeHosts;
  const ctx: DetectorContext = {
    target: targetUrl,
    targetRegistrableDomain: targetRd,
    status: input.status,
    coverage,
    classify: (host) => classifyHost(host, classifyOpts),
    canary,
    wasBlocked: (u) => {
      if (!exclude || exclude.size === 0) return false;
      const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      return exclude.has(`${host}:${u.port ? Number(u.port) : defaultPort(u.protocol)}`);
    },
  };

  const detectors = input.detectors ?? DEFAULT_DETECTORS;
  const ids = new Set<string>();
  for (const d of detectors) {
    if (ids.has(d.id)) throw new DetectorContractError(d.id, 'detector id registered twice');
    ids.add(d.id);
  }

  const items = new Map<string, EvidenceItem>();
  const all: FindingV2[] = [];
  for (const d of detectors) all.push(...finalizeDrafts(d, d.run(input.capture, ctx), items));
  const findingIds = new Set<string>();
  for (const f of all) {
    if (findingIds.has(f.id))
      throw new DetectorContractError(f.detector, `finding id collision ${f.id}`);
    findingIds.add(f.id);
  }

  const bundle = buildBundle(items);
  assertCanaryFree(bundle, canary);
  const { privacy, security } = partitionFindings(all);
  const { score, ledger } = scorePrivacy(privacy, bundle, coverage);

  let pre = 0;
  let post = 0;
  for (const r of input.capture.requests) {
    try {
      const u = new URL(r.url);
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) || !u.hostname) continue;
      if (ctx.wasBlocked(u)) continue;
    } catch {
      continue;
    }
    if (r.phase === 'pre-connect') pre++;
    else post++;
  }

  const detectorRuns: DetectorRun[] = detectors.map((d) => ({
    id: d.id,
    version: d.version,
    domain: d.domain,
  }));
  const report: ReportV2 = {
    reportVersion: REPORT_V2_VERSION,
    scan: {
      target: input.target,
      hostname: targetUrl.hostname,
      scannedAt: input.scannedAt,
      chainId: input.chainId,
      status: input.status,
      scannerVersion: input.scannerVersion,
      spoofMetaMask: input.spoofMetaMask,
      canaryAddress: input.canaryAddress,
      egress: input.egress,
      connectionLog: input.connectionLog ?? [],
      notes,
      ...(input.connection ? { connection: input.connection } : {}),
      ...(input.failure ? { failure: input.failure } : {}),
    },
    detectors: detectorRuns,
    privacy: { score, coverage, ledger, findings: privacy },
    security: { observations: security },
    contacts: computeContacts(input.capture, ctx),
    wallet: { readsViaWallet: input.wallet.readsViaWallet, usesAnonRpc: input.wallet.usesAnonRpc },
    telemetry: {
      totalRequests: pre + post,
      preConnectRequests: pre,
      postConnectRequests: post,
      wsConnections: input.capture.wsConnections,
      wsFrames: input.capture.wsFrames.length,
      cookiesCount: input.capture.cookies.length,
      localStorageCount: input.capture.storage.filter((s) => s.kind === 'local-storage').length,
      sessionStorageCount: input.capture.storage.filter((s) => s.kind === 'session-storage').length,
    },
    evidence: {
      bundleVersion: EVIDENCE_BUNDLE_VERSION,
      canonicalization: CANONICALIZATION,
      sha256: bundleHash(bundle),
      itemCount: items.size,
    },
    findingSet: findingSetDigest([...privacy, ...security]),
  };
  // The engine validates its own output: drift between code and published
  // schema fails the scan instead of producing an invalid artifact.
  validateEvidenceBundle(bundle);
  validateReportV2(report);
  return { report, bundle };
}
