/**
 * Risk assessment + executive summary of a scan, for people.
 *
 * Deterministic and derived ONLY from the report and its evidence: no model,
 * no heuristics beyond the rules below. The web app displays this; it never
 * computes its own verdict.
 *
 * Levels (first matching rule wins):
 *  - not-assessed: no privacy score (the page never loaded);
 *  - critical:     the wallet address provably reached an analytics,
 *                  error-monitoring, support-chat or unidentified third party
 *                  (a scored canary-leak finding of severity high);
 *  - high:         any other scored wallet-address leak (e.g. an RPC provider);
 *  - elevated:     no address leak, score < 70;
 *  - moderate:     no address leak, 70 ≤ score < 90;
 *  - low:          no address leak, score ≥ 90.
 * Partial coverage (wallet never connected) is always stated: post-connect
 * leaks were not tested, so a low level is a statement about pre-connect only.
 */
import type {
  CanaryMatchEvidence,
  EvidenceBundle,
  ThirdPartyContactEvidence,
} from './contracts/evidence.js';
import type { ReportV2 } from './contracts/report-v2.js';

export type AssessmentLevel =
  'not-assessed' | 'critical' | 'high' | 'elevated' | 'moderate' | 'low';

export interface Assessment {
  level: AssessmentLevel;
  headline: string;
  /** Plain-language statements, each backed by report data. */
  points: string[];
  /** Caveats a reader must know (coverage, not-scored reasons). */
  caveats: string[];
}

const list = (xs: string[], max = 4) =>
  xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`;

export function assess(report: ReportV2, bundle: EvidenceBundle): Assessment {
  const caveats: string[] = [];
  const points: string[] = [];
  const score = report.privacy.score;

  if (score === null) {
    const why = report.scan.failure
      ? `${report.scan.failure.category.replaceAll('-', ' ')} (${report.scan.failure.detail})`
      : (report.scan.notes[0] ?? 'the page did not load');
    return {
      level: 'not-assessed',
      headline: 'Not assessed: the dApp could not be observed',
      points: [`The scan measured nothing: ${why}.`],
      caveats: ['No score is given for a page that was never observed.'],
    };
  }

  const leaks = report.privacy.findings
    .filter((f) => f.detector === 'canary-leak' && f.countsTowardPrivacyScore)
    .map((f) => ({ f, e: bundle.items[f.evidence[0]!.id] as CanaryMatchEvidence }));
  const severe = leaks.filter((l) => l.f.severity === 'high' || l.f.severity === 'critical');
  const leakDomains = [...new Set(leaks.map((l) => l.e.registrableDomain))].sort();
  const severeDomains = [...new Set(severe.map((l) => l.e.registrableDomain))].sort();

  const contacts = Object.values(bundle.items).filter(
    (i): i is ThirdPartyContactEvidence => i.type === 'third-party-contact',
  );
  const preConnect = [
    ...new Set(
      contacts.filter((c) => c.phases.includes('pre-connect')).map((c) => c.registrableDomain),
    ),
  ].sort();
  const connected = report.scan.status === 'completed';

  let level: AssessmentLevel;
  let headline: string;
  if (severe.length) {
    level = 'critical';
    headline = `Wallet address sent to ${severeDomains.length} tracking or unidentified third part${severeDomains.length === 1 ? 'y' : 'ies'}`;
  } else if (leaks.length) {
    level = 'high';
    headline = `Wallet address sent to ${leakDomains.length} third part${leakDomains.length === 1 ? 'y' : 'ies'}`;
  } else if (score < 70) {
    level = 'elevated';
    headline = 'No wallet-address leak observed; visitors are widely exposed to third parties';
  } else if (score < 90) {
    level = 'moderate';
    headline = 'No wallet-address leak observed; some third-party exposure';
  } else {
    level = 'low';
    headline = 'No wallet-address leak observed; little third-party exposure';
  }

  if (leaks.length) {
    points.push(`The throwaway wallet address was observed reaching ${list(leakDomains)}.`);
  } else if (connected) {
    points.push('The throwaway wallet address was not observed in any third-party traffic.');
  }
  if (preConnect.length) {
    points.push(
      `${preConnect.length} third part${preConnect.length === 1 ? 'y learns' : 'ies learn'} every visitor's IP address before any wallet interaction: ${list(preConnect)}.`,
    );
  }
  points.push(
    connected
      ? 'A wallet was connected, so behaviour after connecting was observed.'
      : 'The wallet could not be connected; only behaviour before connecting was observed.',
  );
  points.push(
    report.wallet.usesAnonRpc
      ? 'RPC reads are routed through Anon-RPC.'
      : 'RPC reads are not routed through Anon-RPC.',
  );
  const risks = report.security.observations.filter((o) => o.kind !== 'observation');
  if (risks.length)
    points.push(
      `${risks.length} security header risk${risks.length === 1 ? '' : 's'} on the main document (not part of the privacy score).`,
    );

  if (!connected) caveats.push('Partial scan: address leaks after connecting were not tested.');
  caveats.push(
    'A score reflects what this scan could observe in the browser; server-side sharing is invisible to it.',
  );
  return { level, headline, points, caveats };
}
