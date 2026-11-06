/**
 * ip-exposure (privacy): third parties the page contacted. Each one learns
 * the visitor's IP address and that they use this dapp — even when no wallet
 * address is sent. One finding per third-party registrable domain.
 *
 * Scoring (unchanged from v1, see scoring-v2.ts): per phase, a small charge
 * per distinct counted domain, capped per phase. Anon-RPC contacts are
 * reported as observations and never counted.
 *
 * P1-3 will separate infrastructure (same-organisation assets) from tracking;
 * until then every third party is treated alike, as in v1.
 */
import type { Phase, RecipientClass, ThirdPartyContact } from '../report.js';
import type { Capture } from '../contracts/capture.js';
import type { Detector, DetectorContext, DraftFinding } from '../contracts/detector.js';
import type { ThirdPartyContactEvidence } from '../contracts/evidence.js';

export const IP_EXPOSURE_DETECTOR_ID = 'ip-exposure';
export const IP_EXPOSURE_DETECTOR_VERSION = '1.0.0';

const SCANNED_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

/**
 * Third-party contacts with request counts (telemetry; volatile). First-party
 * hosts and egress-refused requests are excluded. Sorted by host.
 */
export function computeContacts(capture: Capture, ctx: DetectorContext): ThirdPartyContact[] {
  const contacts = new Map<string, ThirdPartyContact>();
  for (const req of capture.requests) {
    let u: URL;
    try {
      u = new URL(req.url);
    } catch {
      continue;
    }
    if (!SCANNED_PROTOCOLS.has(u.protocol) || !u.hostname || ctx.wasBlocked(u)) continue;
    const c = ctx.classify(u.hostname);
    if (c.class === 'first-party') continue;
    const existing = contacts.get(c.host) ?? {
      host: c.host,
      registrableDomain: c.registrableDomain,
      class: c.class,
      phases: [],
      requestCount: 0,
      methods: [],
      resourceTypes: [],
    };
    if (!existing.phases.includes(req.phase)) existing.phases.push(req.phase);
    if (req.method && !existing.methods?.includes(req.method)) existing.methods?.push(req.method);
    if (req.resourceType && !existing.resourceTypes?.includes(req.resourceType)) {
      existing.resourceTypes?.push(req.resourceType);
    }
    existing.requestCount += 1;
    contacts.set(c.host, existing);
  }
  return [...contacts.values()].sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

const PHASE_ORDER: Record<Phase, number> = { 'pre-connect': 0, 'post-connect': 1 };

export function contactEvidence(t: ThirdPartyContact): ThirdPartyContactEvidence {
  return {
    type: 'third-party-contact',
    host: t.host,
    registrableDomain: t.registrableDomain,
    recipientClass: t.class,
    phases: [...new Set(t.phases)].sort((a, b) => PHASE_ORDER[a] - PHASE_ORDER[b]),
    methods: [...new Set(t.methods ?? [])].sort(),
    resourceTypes: [...new Set(t.resourceTypes ?? [])].sort(),
  };
}

/** Classes that count toward IP-exposure penalties (v1 semantics). */
export function contactCounts(cls: RecipientClass): boolean {
  return cls !== 'first-party' && cls !== 'anon-rpc';
}

/** Build one draft per registrable domain from contacts (shared with migration). */
export function ipExposureDrafts(contacts: ThirdPartyContact[]): DraftFinding[] {
  const byDomain = new Map<string, ThirdPartyContact[]>();
  for (const t of contacts) {
    if (t.class === 'first-party') continue;
    const list = byDomain.get(t.registrableDomain) ?? [];
    list.push(t);
    byDomain.set(t.registrableDomain, list);
  }
  const drafts: DraftFinding[] = [];
  for (const [domain, list] of byDomain) {
    const evidence = list.map(contactEvidence);
    const counted = list.some((t) => contactCounts(t.class));
    const classes = [...new Set(list.map((t) => t.class))].sort().join(', ');
    const beforeConnect = list.some((t) => t.phases.includes('pre-connect'));
    const rpc = list.some((t) => t.class === 'rpc-provider');
    drafts.push(
      counted
        ? {
            fingerprintInput: { registrableDomain: domain },
            kind: 'issue',
            severity: 'low',
            confidence: 'confirmed',
            title: `Visitor IP exposed to ${domain}${beforeConnect ? ' before wallet connect' : ''}`,
            impact: `${domain} (${classes}) learns each visitor’s IP address and that they use this dapp${
              beforeConnect ? ', before any wallet interaction' : ''
            }. No wallet address is implied by this finding alone.`,
            remediation: rpc
              ? 'Route RPC reads through Anon-RPC (`igris fix`) or through the user’s wallet.'
              : 'Self-host the resource or serve it from the dapp’s own origin; remove third parties the page does not need.',
            evidence,
            countsTowardPrivacyScore: true,
          }
        : {
            fingerprintInput: { registrableDomain: domain },
            kind: 'observation',
            severity: 'info',
            confidence: 'confirmed',
            title: `Anon-RPC network contacted (${domain})`,
            impact:
              'Traffic to an Anon-RPC network; the RPC provider does not see the visitor’s IP.',
            remediation: 'No action required.',
            evidence,
            countsTowardPrivacyScore: false,
          },
    );
  }
  return drafts;
}

export const ipExposureDetector: Detector = {
  id: IP_EXPOSURE_DETECTOR_ID,
  version: IP_EXPOSURE_DETECTOR_VERSION,
  domain: 'privacy',
  run: (capture, ctx) => ipExposureDrafts(computeContacts(capture, ctx)),
};
