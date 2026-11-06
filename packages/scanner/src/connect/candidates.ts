/**
 * Strict scoring of connect-control candidates.
 *
 * The old heuristic clicked the first visible element whose text matched
 * /connect|sign in|log ?in|launch app|get started/ — which clicked a
 * "ConnectKit" nav link (family.co), "Get started now" (demo.privy.io) and
 * GitHub's "Sign in". The rules below are deterministic and every decision
 * carries a reason for the diagnostics.
 *
 * Eligibility (all required):
 *  - visible, enabled, accessible name ≤ 40 chars;
 *  - NOT a link that navigates (an <a> whose href is not "#", "" or
 *    javascript:) — connecting must never navigate away;
 *  - name matches one of the TIERS below as a whole phrase.
 * Score = tier score − footer penalty; ties broken by position (higher on the
 * page first), then DOM order. Below MIN_SCORE: no candidate.
 */
import type { RawCandidate } from './page-probes.js';

export interface ScoredCandidate {
  index: number;
  name: string;
  score: number;
  reasons: string[];
}

/** Whole-name patterns (case-insensitive), best first. */
export const TIERS: Array<{ score: number; re: RegExp; why: string }> = [
  { score: 100, re: /^connect( a| your)? wallet$/i, why: 'exact "connect wallet"' },
  { score: 95, re: /^connect$/i, why: 'exact "connect"' },
  { score: 85, re: /^connect( a| your)? [a-z0-9]{2,10} wallet$/i, why: '"connect <chain> wallet"' },
  {
    score: 80,
    re: /^(log ?in|sign ?in)( \/ sign ?up| or sign up)?$/i,
    why: 'exact "log in" / "sign in"',
  },
  { score: 60, re: /^connect to (?:a )?wallet$/i, why: '"connect to wallet"' },
];
export const MIN_SCORE = 60;
const MAX_NAME = 40;

/** Is this <a> a real navigation (as opposed to a button styled as a link)? */
export function isNavigatingLink(c: Pick<RawCandidate, 'tag' | 'href'>): boolean {
  if (c.tag !== 'a') return false;
  const h = (c.href ?? '').trim().toLowerCase();
  return !(h === '' || h === '#' || h.startsWith('javascript:'));
}

/** Score candidates (pure; unit-tested). Returns eligible candidates, best first. */
export function scoreCandidates(raw: RawCandidate[]): ScoredCandidate[] {
  const out: Array<ScoredCandidate & { top: number }> = [];
  for (const c of raw) {
    if (!c.visible || c.disabled) continue;
    const name = c.name.replace(/\s+/g, ' ').trim();
    if (!name || name.length > MAX_NAME) continue;
    if (isNavigatingLink(c)) continue;
    const tier = TIERS.find((t) => t.re.test(name));
    if (!tier) continue;
    const reasons = [tier.why];
    let score = tier.score;
    if (c.inFooter) {
      score -= 30;
      reasons.push('in <footer> (−30)');
    }
    if (c.hasPopup) reasons.push('aria-haspopup');
    if (score >= MIN_SCORE) out.push({ index: c.index, name, score, reasons, top: c.top });
  }
  out.sort((a, b) => b.score - a.score || a.top - b.top || a.index - b.index);
  return out.map(({ top: _t, ...c }) => c);
}
