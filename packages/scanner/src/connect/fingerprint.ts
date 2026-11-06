/**
 * Wallet-kit identification from observable signals.
 *
 * Confidence is earned by what was SEEN, never assumed:
 *  - high:   the kit's own connect modal was observed open (strong modal signal);
 *  - medium: a strong static signal (e.g. AppKit custom elements registered,
 *            RainbowKit's own connect button rendered) but no modal yet;
 *  - low:    only weak signals (an SDK iframe or SDK host contacted) — a site
 *            can load an SDK it does not use for connecting (Uniswap loads
 *            Privy's iframe but connects through its own modal);
 *  - none:   nothing.
 * If strong signals of two kits conflict, the modal stage wins; a tie at the
 * same stage is reported as ambiguous (confidence low) rather than guessed.
 */
import type { Page } from 'playwright';
import type { KitId } from '@igris/core';
import { KIT_SIGNALS_PROBE } from './page-probes.js';

export interface KitSignal {
  kit: KitId;
  strength: 'strong' | 'weak';
  stage: 'static' | 'modal' | 'network';
  marker: string;
}

export interface KitFingerprint {
  id: KitId | 'none';
  confidence: 'high' | 'medium' | 'low' | 'none';
  signals: string[];
}

/** SDK backend hosts (weak network signals: contacted ≠ used for connecting). */
const NETWORK_SIGNALS: Array<{ kit: KitId; re: RegExp; marker: string }> = [
  { kit: 'privy', re: /(^|\.)privy\.io$/, marker: 'host:*.privy.io' },
  { kit: 'dynamic', re: /(^|\.)dynamicauth\.com$/, marker: 'host:*.dynamicauth.com' },
  { kit: 'connectkit', re: /^app\.family\.co$/, marker: 'host:app.family.co' },
];

export async function collectKitSignals(
  page: Page,
  hosts: Iterable<string> = [],
): Promise<KitSignal[]> {
  let signals: KitSignal[] = [];
  try {
    signals = (await page.evaluate(KIT_SIGNALS_PROBE)) as KitSignal[];
  } catch {
    signals = []; // page navigated or crashed; caller records the failure
  }
  const seen = new Set<string>();
  for (const h of hosts) {
    for (const n of NETWORK_SIGNALS) {
      if (n.re.test(h) && !seen.has(n.marker)) {
        seen.add(n.marker);
        signals.push({ kit: n.kit, strength: 'weak', stage: 'network', marker: n.marker });
      }
    }
  }
  return signals;
}

/** Pure decision from signals (unit-tested). */
export function identifyKit(signals: KitSignal[]): KitFingerprint {
  const label = (s: KitSignal) => `${s.kit}:${s.stage}:${s.marker}`;
  const all = signals.map(label).sort();
  const strongModal = [
    ...new Set(
      signals.filter((s) => s.strength === 'strong' && s.stage === 'modal').map((s) => s.kit),
    ),
  ];
  if (strongModal.length === 1) return { id: strongModal[0]!, confidence: 'high', signals: all };
  if (strongModal.length > 1)
    return { id: 'none', confidence: 'low', signals: ['ambiguous:modal', ...all] };
  const strongStatic = [
    ...new Set(signals.filter((s) => s.strength === 'strong').map((s) => s.kit)),
  ];
  if (strongStatic.length === 1)
    return { id: strongStatic[0]!, confidence: 'medium', signals: all };
  if (strongStatic.length > 1)
    return { id: 'none', confidence: 'low', signals: ['ambiguous:static', ...all] };
  const weak = [...new Set(signals.map((s) => s.kit))];
  if (weak.length === 1) return { id: weak[0]!, confidence: 'low', signals: all };
  if (weak.length > 1)
    return { id: 'none', confidence: 'low', signals: ['ambiguous:weak', ...all] };
  return { id: 'none', confidence: 'none', signals: [] };
}
