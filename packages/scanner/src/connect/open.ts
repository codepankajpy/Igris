/**
 * Open the dapp's connect UI: score candidates strictly, click the best one
 * (Playwright actionability checks: visible, stable, enabled, hit-testable),
 * then wait — on a CONDITION, bounded — for a wallet-kit modal to appear.
 * Records URL changes; a change of origin or document during this step is
 * unexpected navigation and aborts it.
 */
import type { ElementHandle, Page } from 'playwright';
import { scoreCandidates, type ScoredCandidate } from './candidates.js';
import { collectKitSignals, identifyKit, type KitFingerprint } from './fingerprint.js';
import { candidateHandleProbe, CANDIDATES_PROBE, type RawCandidate } from './page-probes.js';

export interface OpenResult {
  outcome:
    | 'modal-opened'
    | 'no-connect-control'
    | 'modal-not-opened'
    | 'unexpected-navigation'
    | 'click-failed';
  clicked: ScoredCandidate | null;
  candidates: ScoredCandidate[];
  fingerprint: KitFingerprint;
  urlChanges: string[];
  detail: string;
}

export interface OpenOptions {
  /** Max wait for a modal after the click. */
  modalTimeoutMs?: number;
  /** Poll interval while waiting for the modal condition. */
  pollMs?: number;
  /** Hosts contacted so far (weak network signals). */
  hosts?: () => Iterable<string>;
}

async function candidateHandle(page: Page, index: number): Promise<ElementHandle | null> {
  const handle = await page.evaluateHandle(candidateHandleProbe(index));
  const el = handle.asElement();
  if (!el) await handle.dispose();
  return el;
}

export async function scoreConnectCandidates(page: Page): Promise<ScoredCandidate[]> {
  const raw = (await page.evaluate(CANDIDATES_PROBE)) as RawCandidate[];
  return scoreCandidates(raw);
}

/** Has the page left the original document (new origin or new document load)? */
export function isUnexpectedNavigation(before: string, after: string): boolean {
  try {
    const a = new URL(before);
    const b = new URL(after);
    return a.origin !== b.origin;
  } catch {
    return before !== after;
  }
}

export async function openConnectUi(page: Page, opts: OpenOptions = {}): Promise<OpenResult> {
  const modalTimeoutMs = opts.modalTimeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 250;
  const startUrl = page.url();
  const urlChanges: string[] = [];
  let documentLoads = 0;
  const onNav = (frame: import('playwright').Frame) => {
    if (frame !== page.mainFrame()) return;
    if (frame.url() !== (urlChanges.at(-1) ?? startUrl)) urlChanges.push(frame.url());
  };
  const onLoad = () => (documentLoads += 1);
  page.on('framenavigated', onNav);
  page.on('domcontentloaded', onLoad);
  const done = (r: Omit<OpenResult, 'urlChanges'>): OpenResult => {
    page.off('framenavigated', onNav);
    page.off('domcontentloaded', onLoad);
    return { ...r, urlChanges: urlChanges.slice(0, 20) };
  };

  const hostsNow = () => opts.hosts?.() ?? [];
  const before = identifyKit(await collectKitSignals(page, hostsNow()));
  const candidates = await scoreConnectCandidates(page).catch(() => [] as ScoredCandidate[]);
  const best = candidates[0];
  if (!best) {
    return done({
      outcome: 'no-connect-control',
      clicked: null,
      candidates,
      fingerprint: before,
      detail: 'no eligible connect control (strict scoring)',
    });
  }
  const handle = await candidateHandle(page, best.index);
  if (!handle) {
    return done({
      outcome: 'click-failed',
      clicked: best,
      candidates,
      fingerprint: before,
      detail: 'candidate vanished',
    });
  }
  try {
    await handle.click({ timeout: 5_000 });
  } catch (err) {
    return done({
      outcome: 'click-failed',
      clicked: best,
      candidates,
      fingerprint: before,
      detail: `click failed: ${String(err).slice(0, 160)}`,
    });
  } finally {
    await handle.dispose().catch(() => {});
  }

  const deadline = Date.now() + modalTimeoutMs;
  let fp = before;
  for (;;) {
    if (documentLoads > 0 || urlChanges.some((u) => isUnexpectedNavigation(startUrl, u))) {
      return done({
        outcome: 'unexpected-navigation',
        clicked: best,
        candidates,
        fingerprint: fp,
        detail: `navigation after clicking "${best.name}": ${urlChanges.at(-1) ?? '(document reload)'}`,
      });
    }
    fp = identifyKit(await collectKitSignals(page, hostsNow()));
    if (fp.confidence === 'high') {
      return done({
        outcome: 'modal-opened',
        clicked: best,
        candidates,
        fingerprint: fp,
        detail: `modal: ${fp.id}`,
      });
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(pollMs); // poll a condition, bounded by the deadline
  }
  return done({
    outcome: 'modal-not-opened',
    clicked: best,
    candidates,
    fingerprint: fp,
    detail: `no wallet-kit modal within ${modalTimeoutMs} ms after clicking "${best.name}"`,
  });
}
