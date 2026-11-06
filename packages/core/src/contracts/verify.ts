/**
 * Integrity check of a report against its evidence bundle (browser-safe; no
 * schema validation here — see validate.ts for that). Answers: does this
 * bundle hash to what the report claims, and does every finding's evidence
 * resolve to an item of the claimed type whose id matches its content?
 */
import {
  EVIDENCE_BUNDLE_VERSION,
  EVIDENCE_BUNDLE_VERSION_V2,
  EVIDENCE_BUNDLE_VERSION_V1,
  EVIDENCE_BUNDLE_VERSION_V3,
  WALLET_REQUEST_DECODED_PROPERTIES,
  bundleHash,
  evidenceId,
  type EvidenceBundleV1,
} from './evidence.js';
import type { FindingSetDigest } from './report-v2.js';
import { isReportV3, type FindingV3, type ReportAny, type ReportV3 } from './report-v3.js';
import { contentHash } from './hash.js';
import { canonicalize } from './canonical.js';
import { computeRecipients } from '../verdicts.js';

/** Which bundle version each report version must reference. */
const BUNDLE_FOR_REPORT: Record<string, string> = {
  '2.0.0': EVIDENCE_BUNDLE_VERSION_V1,
  '2.1.0': EVIDENCE_BUNDLE_VERSION_V2,
  '2.2.0': EVIDENCE_BUNDLE_VERSION_V3,
  '3.0.0': EVIDENCE_BUNDLE_VERSION,
};

/** The decoded fields a walletRequests summary repeats from its evidence item. */
const WALLET_SHARED_FIELDS = Object.keys(WALLET_REQUEST_DECODED_PROPERTIES) as Array<
  keyof typeof WALLET_REQUEST_DECODED_PROPERTIES
>;

export interface IntegrityResult {
  ok: boolean;
  problems: string[];
  /** Hash recomputed from the bundle. */
  bundleSha256: string;
}

/** The finding-set digest of a list of findings (order-independent). */
export function findingSetDigest(
  findings: readonly Pick<FindingV3, 'fingerprint'>[],
): FindingSetDigest {
  const fps = findings.map((f) => f.fingerprint).sort();
  return { sha256: contentHash(fps), count: fps.length };
}

export function verifyReportIntegrity(
  report: ReportAny,
  bundle: EvidenceBundleV1,
): IntegrityResult {
  const problems: string[] = [];
  // Version pairing: report 2.0.0 ↔ bundle v1, 2.1.0 ↔ v2, 2.2.0 ↔ v3, 3.0.0 ↔ v4.
  const expected = BUNDLE_FOR_REPORT[report.reportVersion];
  if (expected !== bundle.bundleVersion) {
    problems.push(
      `report ${report.reportVersion} cannot reference a ${bundle.bundleVersion} bundle`,
    );
  }
  if (report.evidence.bundleVersion !== bundle.bundleVersion) {
    problems.push(
      `report claims ${report.evidence.bundleVersion}, bundle is ${bundle.bundleVersion}`,
    );
  }
  const recomputed = bundleHash(bundle);
  if (recomputed !== report.evidence.sha256) {
    problems.push(`bundle hash ${recomputed} != report.evidence.sha256 ${report.evidence.sha256}`);
  }
  const ids = Object.keys(bundle.items);
  if (ids.length !== report.evidence.itemCount) {
    problems.push(`bundle has ${ids.length} items, report claims ${report.evidence.itemCount}`);
  }
  for (const id of ids) {
    const item = bundle.items[id]!;
    if (evidenceId(item) !== id) problems.push(`item ${id} does not match its content id`);
  }
  const all: FindingV3[] = [...report.privacy.findings, ...report.security.observations];
  for (const f of all) {
    if (f.evidence.length === 0) problems.push(`${f.id} has no evidence`);
    for (const ref of f.evidence) {
      const item = bundle.items[ref.id];
      if (!item) problems.push(`${f.id} references missing evidence ${ref.id}`);
      else if (item.type !== ref.type)
        problems.push(`${f.id} references ${ref.id} as ${ref.type} but it is ${item.type}`);
    }
  }
  const digest = findingSetDigest(all);
  if (digest.sha256 !== report.findingSet.sha256 || digest.count !== report.findingSet.count) {
    problems.push(
      `findingSet digest ${digest.sha256}/${digest.count} != report ${report.findingSet.sha256}/${report.findingSet.count}`,
    );
  }
  const findingIds = new Set(all.map((f) => f.id));
  if (isReportV3(report)) {
    // Every recipient must stand on something the report or bundle shows:
    // a contact, or a canary match a finding points to.
    const contactKeys = new Set(report.contacts.map((c) => `${c.registrableDomain}|${c.class}`));
    const matchKeys = new Set<string>();
    for (const f of all) {
      for (const ref of f.evidence) {
        const item = bundle.items[ref.id];
        if (item?.type === 'canary-match')
          matchKeys.add(`${item.registrableDomain}|${item.recipientClass}`);
      }
    }
    // Recipients and verdicts are a pure function of contacts, findings and
    // evidence: recompute them, so an edited verdict or a dropped recipient
    // cannot pass.
    const expected = computeRecipients({ contacts: report.contacts, findings: all, bundle });
    if (canonicalize(expected) !== canonicalize(report.recipients))
      problems.push(
        'recipients do not match those recomputed from contacts, findings and evidence',
      );
    for (const r of report.recipients) {
      const key = `${r.registrableDomain}|${r.class}`;
      if (!contactKeys.has(key) && !matchKeys.has(key))
        problems.push(`recipient ${r.registrableDomain} (${r.class}) is in no contact or evidence`);
      for (const id of r.findingIds) {
        if (!findingIds.has(id))
          problems.push(`recipient ${r.registrableDomain} references unknown finding ${id}`);
      }
    }
    if (report.timeline) {
      const keys = (xs: ReadonlyArray<{ registrableDomain: string; class: string }>) =>
        xs.map((x) => `${x.registrableDomain}|${x.class}`).join(',');
      if (keys(report.timeline.recipients) !== keys(report.recipients))
        problems.push('timeline recipients do not match report recipients');
    }
    problems.push(...walletRequestProblems(report.walletRequests, bundle, all));
  } else {
    for (const line of report.privacy.ledger) {
      for (const id of line.findingIds) {
        if (!findingIds.has(id))
          problems.push(`ledger ${line.id} references unknown finding ${id}`);
      }
    }
    for (const o of report.security.observations) {
      if (o.countsTowardPrivacyScore)
        problems.push(`security observation ${o.id} counts toward the privacy score`);
    }
  }
  return { ok: problems.length === 0, problems, bundleSha256: recomputed };
}

/**
 * walletRequests ↔ bundle: every summary points at a wallet-request item and
 * repeats its decoded fields exactly; its findingIds are exactly the
 * findings that reference that item; every wallet-request item in the bundle
 * is summarised (none when walletRequests is null).
 */
function walletRequestProblems(
  summaries: ReportV3WalletRequests,
  bundle: EvidenceBundleV1,
  findings: readonly FindingV3[],
): string[] {
  const problems: string[] = [];
  const walletItems = Object.entries(bundle.items)
    .filter(([, item]) => item.type === 'wallet-request')
    .map(([id]) => id);
  if (summaries === null || summaries === undefined) {
    if (walletItems.length)
      problems.push(
        `walletRequests is null but the bundle holds ${walletItems.length} wallet-request items`,
      );
    return problems;
  }
  const summarised = new Set<string>();
  summaries.forEach((s, i) => {
    const at = `walletRequests[${i}]`;
    const item = bundle.items[s.evidenceId];
    summarised.add(s.evidenceId);
    if (!item || item.type !== 'wallet-request') {
      problems.push(`${at} references ${s.evidenceId}, which is not a wallet-request item`);
      return;
    }
    for (const k of WALLET_SHARED_FIELDS) {
      if (s[k] !== item[k]) problems.push(`${at}.${k} does not match evidence ${s.evidenceId}`);
    }
    const expected = [
      ...new Set(
        findings.filter((f) => f.evidence.some((r) => r.id === s.evidenceId)).map((f) => f.id),
      ),
    ].sort();
    if (canonicalize(expected) !== canonicalize(s.findingIds))
      problems.push(`${at}.findingIds do not match the findings that reference ${s.evidenceId}`);
  });
  for (const id of walletItems) {
    if (!summarised.has(id))
      problems.push(`wallet-request item ${id} is in no walletRequests entry`);
  }
  return problems;
}

type ReportV3WalletRequests = ReportV3['walletRequests'] | undefined;
