/**
 * Executive summary of a scan, for people — descriptive, never a grade.
 *
 * Deterministic and derived ONLY from the report and its evidence: no model,
 * no heuristics beyond the rules below. The web app displays this; it never
 * computes its own verdict. There is no score and no level.
 *
 * States (first matching rule wins):
 *  - not-observed:         the page never loaded (coverage "none");
 *  - address-to-trackers:  the wallet address (exact or hashed) reached a
 *                          recipient whose verdict is tracking or unidentified;
 *  - address-to-services:  it reached only expected / avoidable recipients
 *                          (RPC providers, wallet SDKs, relays, …);
 *  - no-address-observed:  no recipient received the address.
 * Partial coverage (wallet never connected) is always stated: post-connect
 * behaviour was not observed.
 *
 * Accepts 2.x reports too: their recipients are computed with the same
 * rules (verdicts.ts) the engine uses for 3.0.0.
 */
import type { EvidenceBundle } from './contracts/evidence.js';
import { isReportV3, type Recipient, type ReportAny, type Verdict } from './contracts/report-v3.js';
import { addressReceived, computeRecipients } from './verdicts.js';

export const SUMMARY_STATES = [
  'not-observed',
  'address-to-trackers',
  'address-to-services',
  'no-address-observed',
] as const;
export type SummaryState = (typeof SUMMARY_STATES)[number];

export interface Summary {
  state: SummaryState;
  headline: string;
  /** Plain-language statements, each backed by report data. */
  points: string[];
  /** Caveats a reader must know (coverage, what a browser scan cannot see). */
  caveats: string[];
}

const list = (xs: string[], max = 4) =>
  xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`;
const parties = (n: number) => `${n} third part${n === 1 ? 'y' : 'ies'}`;
const distinct = (xs: string[]) => [...new Set(xs)].sort();

/** The report's recipients (3.0.0), or the same rules applied to a 2.x report. */
export function recipientsOf(report: ReportAny, bundle: EvidenceBundle): Recipient[] {
  if (isReportV3(report)) return report.recipients;
  return computeRecipients({
    contacts: report.contacts,
    findings: [...report.privacy.findings, ...report.security.observations],
    bundle,
  });
}

const VERDICT_SENTENCE: Record<Verdict, (n: number) => string> = {
  unidentified: (n) => `${parties(n)} could not be identified`,
  tracking: (n) => `${parties(n)} ${n === 1 ? 'is a tracker' : 'are trackers'}`,
  avoidable: (n) =>
    `${parties(n)} ${n === 1 ? 'is' : 'are'} avoidable (the app works without ${n === 1 ? 'it' : 'them'})`,
  expected: (n) => `${parties(n)} ${n === 1 ? 'is' : 'are'} expected for the app to work as built`,
};

export function summarise(report: ReportAny, bundle: EvidenceBundle): Summary {
  if (report.privacy.coverage === 'none') {
    const why = report.scan.failure
      ? `${report.scan.failure.category.replaceAll('-', ' ')} (${report.scan.failure.detail})`
      : (report.scan.notes[0] ?? 'the page did not load');
    return {
      state: 'not-observed',
      headline: 'Nothing observed: the dApp could not be loaded',
      points: [`The scan measured nothing: ${why}.`],
      caveats: ['Nothing is said about a page that was never observed.'],
    };
  }

  const recipients = recipientsOf(report, bundle);
  const received = recipients.filter((r) => addressReceived(r.learned.address));
  const toTrackers = received.filter(
    (r) => r.verdict === 'tracking' || r.verdict === 'unidentified',
  );
  const trackerDomains = distinct(toTrackers.map((r) => r.registrableDomain));
  const receivedDomains = distinct(received.map((r) => r.registrableDomain));
  const contacted = distinct(recipients.map((r) => r.registrableDomain));
  const connected = report.scan.status === 'completed';

  let state: SummaryState;
  let headline: string;
  if (toTrackers.length) {
    state = 'address-to-trackers';
    headline = `Wallet address sent to ${parties(trackerDomains.length)} that track${trackerDomains.length === 1 ? 's' : ''} visitors or could not be identified`;
  } else if (received.length) {
    state = 'address-to-services';
    headline = `Wallet address sent to ${receivedDomains.length} service${receivedDomains.length === 1 ? '' : 's'} the dApp uses; no trackers`;
  } else {
    state = 'no-address-observed';
    headline = `No wallet-address leak observed; ${parties(contacted.length)} contacted`;
  }

  const points: string[] = [];
  if (received.length) {
    points.push(`The throwaway wallet address was observed reaching ${list(receivedDomains)}.`);
  } else if (connected) {
    points.push('The throwaway wallet address was not observed in any third-party traffic.');
  }
  const possible = distinct(
    recipients.filter((r) => r.learned.address === 'possible').map((r) => r.registrableDomain),
  );
  if (possible.length) {
    points.push(
      `A truncated display form of the address (a possible match) reached ${list(possible)}.`,
    );
  }
  for (const v of ['unidentified', 'tracking', 'avoidable', 'expected'] as const) {
    const domains = distinct(
      recipients.filter((r) => r.verdict === v).map((r) => r.registrableDomain),
    );
    if (domains.length) points.push(`${VERDICT_SENTENCE[v](domains.length)}: ${list(domains)}.`);
  }
  const preConnect = distinct(
    recipients.filter((r) => r.learned.ip.includes('pre-connect')).map((r) => r.registrableDomain),
  );
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
      `${risks.length} security header risk${risks.length === 1 ? '' : 's'} on the main document (listed separately from privacy).`,
    );

  const caveats: string[] = [];
  if (!connected) caveats.push('Partial scan: address leaks after connecting were not tested.');
  caveats.push(
    'This reflects what the scan could observe in the browser; server-side sharing is invisible to it.',
  );
  return { state, headline, points, caveats };
}
