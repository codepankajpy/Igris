/**
 * Transparent scoring: start at 100, subtract itemized penalties, floor at 0.
 * Every deduction is a PenaltyLine naming the rule and the finding IDs that
 * caused it, so `igris scan --explain` can print a complete ledger.
 *
 * Dedup rule: leak penalties are charged once per (registrable domain, class)
 * pair, not per request — a chatty tracker that receives the address fifty
 * times is one leak, not fifty. The worst applicable rate for the pair wins
 * (exact beats hashed).
 */
import type { Finding, PenaltyLine, RecipientClass, ThirdPartyContact } from './report.js';
import { WEIGHTS } from './weights.js';

/**
 * Whether a finding participates in scoring. Partial matches are too weak;
 * cookie/storage findings stay on the user's machine (reported, not charged);
 * first-party and anon-rpc destinations are deliberate choices.
 */
export function countsTowardScore(
  f: Pick<Finding, 'category' | 'location' | 'class'>,
): boolean {
  if (f.category === 'partial') return false;
  if (f.location === 'cookie' || f.location === 'local-storage' || f.location === 'session-storage')
    return false;
  if (f.class === 'first-party' || f.class === 'anon-rpc') return false;
  return true;
}

export interface ScoreResult {
  score: number;
  ledger: PenaltyLine[];
}

export function scoreReport(
  findings: Finding[],
  thirdParties: ThirdPartyContact[],
): ScoreResult {
  const ledger: PenaltyLine[] = [];
  let lineNo = 0;
  const nextId = () => `p${++lineNo}`;

  // --- leak penalties, deduped per (registrableDomain, class) ---
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!countsTowardScore(f)) continue;
    const key = `${f.registrableDomain}|${f.class}`;
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, group] of sortedGroups) {
    const [domain, cls] = key.split('|') as [string, RecipientClass];
    const base = WEIGHTS.leak[cls];
    if (base === 0) continue;
    const allHashed = group.every((f) => f.category === 'hashed');
    const points = allHashed ? base * WEIGHTS.hashedMultiplier : base;
    ledger.push({
      id: nextId(),
      label: allHashed
        ? `hashed address reached ${domain} (${cls}) — hashed, still linkable`
        : `address reached ${domain} (${cls})`,
      points,
      rule: allHashed ? `leak.${cls} × hashedMultiplier` : `leak.${cls}`,
      findingIds: group.map((f) => f.id).sort(),
    });
  }

  // --- IP-exposure penalties per phase ---
  const phases = [
    ['pre-connect', WEIGHTS.contact.perDomainPreConnect] as const,
    ['post-connect', WEIGHTS.contact.perDomainPostConnect] as const,
  ];
  for (const [phase, perDomain] of phases) {
    const domains = [
      ...new Set(
        thirdParties
          .filter(
            (t) =>
              t.class !== 'first-party' && t.class !== 'anon-rpc' && t.phases.includes(phase),
          )
          .map((t) => t.registrableDomain),
      ),
    ].sort();
    if (domains.length === 0) continue;
    const raw = domains.length * perDomain;
    const points = Math.min(raw, WEIGHTS.contact.capPerPhase);
    ledger.push({
      id: nextId(),
      label:
        `${domains.length} third part${domains.length === 1 ? 'y' : 'ies'} contacted ` +
        `${phase === 'pre-connect' ? 'before' : 'after'} connect (IP exposure): ${domains.join(', ')}` +
        (raw > points ? ` (capped at ${points})` : ''),
      points,
      rule: `contact.${phase === 'pre-connect' ? 'perDomainPreConnect' : 'perDomainPostConnect'}`,
      findingIds: [],
    });
  }

  const total = ledger.reduce((s, l) => s + l.points, 0);
  const score = Math.max(0, Math.round(100 - total));
  return { score, ledger };
}
