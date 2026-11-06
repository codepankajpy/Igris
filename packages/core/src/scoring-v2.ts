/**
 * Privacy scoring v2: computed ONLY from privacy findings, by rules
 * registered per detector, reading the typed evidence those findings point
 * to. Security observations are not an input (different type, never passed).
 *
 * The arithmetic is exactly v1's (weights.ts, docs/SCORING.md) — migration
 * tests assert that every valid v1 score is reproduced.
 *
 * A counted finding from a detector WITHOUT a registered rule is an error:
 * a new privacy detector must define how it is scored, or emit
 * non-counting findings.
 */
import type { PenaltyLine, RecipientClass, ScanCoverage } from './report.js';
import { WEIGHTS } from './weights.js';
import type {
  CanaryMatchEvidence,
  EvidenceBundleV1,
  ThirdPartyContactEvidence,
} from './contracts/evidence.js';
import type { PrivacyFinding } from './contracts/report-v2.js';
import { CANARY_LEAK_DETECTOR_ID } from './detectors/canary-leak.js';
import { IP_EXPOSURE_DETECTOR_ID, contactCounts } from './detectors/ip-exposure.js';

export class ScoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoringError';
  }
}

type LineDraft = Omit<PenaltyLine, 'id'>;
type Rule = (findings: PrivacyFinding[], bundle: EvidenceBundleV1) => LineDraft[];

function itemsOf<T extends { type: string }>(
  f: PrivacyFinding,
  bundle: EvidenceBundleV1,
  type: T['type'],
): T[] {
  return f.evidence
    .filter((r) => r.type === type)
    .map((r) => {
      const item = bundle.items[r.id];
      if (!item || item.type !== type)
        throw new ScoringError(`${f.id}: evidence ${r.id} missing or not ${type}`);
      return item as unknown as T;
    });
}

/** Leak penalties, once per (registrable domain, class); hashed-only → × multiplier. */
const canaryRule: Rule = (findings, bundle) => {
  const groups = new Map<
    string,
    { domain: string; cls: RecipientClass; ids: string[]; allHashed: boolean }
  >();
  for (const f of findings) {
    for (const e of itemsOf<CanaryMatchEvidence>(f, bundle, 'canary-match')) {
      const key = `${e.registrableDomain}|${e.recipientClass}`;
      const g = groups.get(key) ?? {
        domain: e.registrableDomain,
        cls: e.recipientClass,
        ids: [],
        allHashed: true,
      };
      g.ids.push(f.id);
      if (e.category !== 'hashed') g.allHashed = false;
      groups.set(key, g);
    }
  }
  const lines: LineDraft[] = [];
  for (const [, g] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const base = WEIGHTS.leak[g.cls];
    if (base === 0) continue;
    lines.push({
      label: g.allHashed
        ? `hashed address reached ${g.domain} (${g.cls}) — hashed, still linkable`
        : `address reached ${g.domain} (${g.cls})`,
      points: g.allHashed ? base * WEIGHTS.hashedMultiplier : base,
      rule: g.allHashed ? `leak.${g.cls} × hashedMultiplier` : `leak.${g.cls}`,
      findingIds: [...new Set(g.ids)].sort(),
    });
  }
  return lines;
};

/** IP exposure: per phase, per distinct counted domain, capped per phase. */
const ipRule: Rule = (findings, bundle) => {
  const lines: LineDraft[] = [];
  const phases = [
    ['pre-connect', WEIGHTS.contact.perDomainPreConnect, 'perDomainPreConnect', 'before'] as const,
    [
      'post-connect',
      WEIGHTS.contact.perDomainPostConnect,
      'perDomainPostConnect',
      'after',
    ] as const,
  ];
  for (const [phase, perDomain, ruleName, word] of phases) {
    const domains = new Map<string, string[]>();
    for (const f of findings) {
      for (const e of itemsOf<ThirdPartyContactEvidence>(f, bundle, 'third-party-contact')) {
        if (!contactCounts(e.recipientClass) || !e.phases.includes(phase)) continue;
        const ids = domains.get(e.registrableDomain) ?? [];
        ids.push(f.id);
        domains.set(e.registrableDomain, ids);
      }
    }
    if (domains.size === 0) continue;
    const names = [...domains.keys()].sort();
    const raw = names.length * perDomain;
    const points = Math.min(raw, WEIGHTS.contact.capPerPhase);
    lines.push({
      label:
        `${names.length} third part${names.length === 1 ? 'y' : 'ies'} contacted ${word} connect (IP exposure): ${names.join(', ')}` +
        (raw > points ? ` (capped at ${points})` : ''),
      points,
      rule: `contact.${ruleName}`,
      findingIds: [...new Set([...domains.values()].flat())].sort(),
    });
  }
  return lines;
};

/** Registered scoring rules, applied in this order (ledger order = v1 order). */
export const SCORING_RULES: ReadonlyArray<readonly [string, Rule]> = [
  [CANARY_LEAK_DETECTOR_ID, canaryRule],
  [IP_EXPOSURE_DETECTOR_ID, ipRule],
];

export function hasScoringRule(detectorId: string): boolean {
  return SCORING_RULES.some(([id]) => id === detectorId);
}

export interface PrivacyScore {
  score: number | null;
  ledger: PenaltyLine[];
}

export function scorePrivacy(
  findings: PrivacyFinding[],
  bundle: EvidenceBundleV1,
  coverage: ScanCoverage,
): PrivacyScore {
  // Runtime guard behind the type: only privacy findings may be scored.
  for (const f of findings) {
    if ((f as { domain: string }).domain !== 'privacy') {
      throw new ScoringError(
        `${f.id} is a ${(f as { domain: string }).domain} finding; only privacy findings are scored`,
      );
    }
    if (f.countsTowardPrivacyScore && !hasScoringRule(f.detector)) {
      throw new ScoringError(`${f.id}: detector "${f.detector}" has no registered scoring rule`);
    }
  }
  if (coverage === 'none') return { score: null, ledger: [] };
  const counted = findings.filter((f) => f.countsTowardPrivacyScore);
  const drafts = SCORING_RULES.flatMap(([id, rule]) =>
    rule(
      counted.filter((f) => f.detector === id),
      bundle,
    ),
  );
  const ledger = drafts.map((d, i) => ({ id: `p${i + 1}`, ...d }));
  const total = ledger.reduce((s, l) => s + l.points, 0);
  return { score: Math.max(0, Math.round(100 - total)), ledger };
}
