/**
 * Connect engine (replaces the legacy page-wide heuristic).
 *
 *   open-connect-ui  strict control scoring + navigation guard (open.ts)
 *   select-wallet    dialog-scoped choice: canary → hop → fallback (choice.ts)
 *   await-request    connected = the dApp called eth_requestAccounts
 *   sign-in          optional: one click on an in-dialog SIWE confirmation
 *
 * Never clicks outside an open dialog after the connect control, never
 * follows a navigating link, aborts on a change of origin. Every step is
 * recorded for scan.connection (Report 2.1.0). No silent fallback to generic
 * clicking: when a step cannot be done the scan says which and why.
 */
import type { ElementHandle, Page } from 'playwright';
import type { ConnectionDiagnostics, FailureCategory } from '@igris/core';
import { CANARY_NAME, CANARY_RDNS, FALLBACK_NAMES, HOP_NAMES, SIGN_NAMES } from './choice.js';
import { collectKitSignals, identifyKit, type KitFingerprint } from './fingerprint.js';
import { isUnexpectedNavigation, openConnectUi } from './open.js';
import {
  DIALOG_OPEN_PROBE,
  DIALOG_SNAPSHOT_PROBE,
  walletChoiceProbe,
  type ChoiceDescription,
  type ChoiceKind,
} from './page-probes.js';

export const CONNECT_ENGINE_VERSION = 1;

const RULES = {
  canaryRdns: CANARY_RDNS,
  canaryName: CANARY_NAME.source,
  lists: {
    hop: HOP_NAMES.map((r) => r.source),
    fallback: FALLBACK_NAMES.map((r) => r.source),
    sign: SIGN_NAMES.map((r) => r.source),
  },
};

export interface ConnectEngineOptions {
  /** eth_requestAccounts calls the canary wallet has received so far. */
  requestAccounts: () => number;
  /** Hosts contacted so far (weak kit signals). */
  hosts: () => Iterable<string>;
  /** Max wait for eth_requestAccounts after choosing the wallet. */
  requestTimeoutMs?: number;
  /** Max hops (intermediate screens) before giving up on finding a wallet. */
  maxHops?: number;
}

type Step = ConnectionDiagnostics['steps'][number];

async function describe(page: Page, kind: ChoiceKind): Promise<ChoiceDescription | null> {
  try {
    return (await page.evaluate(
      walletChoiceProbe(kind, 'describe', RULES),
    )) as ChoiceDescription | null;
  } catch {
    return null;
  }
}

async function element(page: Page, kind: ChoiceKind): Promise<ElementHandle | null> {
  try {
    const h = await page.evaluateHandle(walletChoiceProbe(kind, 'element', RULES));
    const el = h.asElement();
    if (!el) await h.dispose();
    return el;
  } catch {
    return null;
  }
}

async function click(page: Page, kind: ChoiceKind): Promise<{ ok: boolean; detail: string }> {
  const d = await describe(page, kind);
  const el = await element(page, kind);
  if (!d || !el) return { ok: false, detail: `no ${kind} choice in the dialog` };
  const label = `${d.name || d.testid || d.tag}${d.testid ? ` [${d.testid}]` : ''}`;
  try {
    await el.click({ timeout: 5_000 });
    return { ok: true, detail: label };
  } catch (err) {
    // Overlays inside kit modals sometimes fail actionability; a DOM click
    // on the same (already dialog-scoped) element is equivalent for the dApp.
    try {
      await el.dispatchEvent('click');
      return { ok: true, detail: `${label} (dispatched)` };
    } catch {
      return { ok: false, detail: `click failed on ${label}: ${String(err).slice(0, 120)}` };
    }
  } finally {
    await el.dispose().catch(() => {});
  }
}

async function waitFor(
  page: Page,
  cond: () => Promise<boolean> | boolean,
  timeoutMs: number,
  pollMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(pollMs);
  }
}

export async function connectWithEngine(
  page: Page,
  opts: ConnectEngineOptions,
): Promise<ConnectionDiagnostics> {
  const listeners: Array<() => void> = [];
  try {
    return await run(page, opts, listeners);
  } finally {
    for (const off of listeners) off();
  }
}

async function run(
  page: Page,
  opts: ConnectEngineOptions,
  listeners: Array<() => void>,
): Promise<ConnectionDiagnostics> {
  const requestTimeoutMs = opts.requestTimeoutMs ?? 8_000;
  const maxHops = opts.maxHops ?? 2;
  const steps: Step[] = [];
  const startUrl = page.url();
  const urlChanges: string[] = [];
  const onNav = (frame: import('playwright').Frame) => {
    if (frame === page.mainFrame() && frame.url() !== (urlChanges.at(-1) ?? startUrl))
      urlChanges.push(frame.url().slice(0, 480));
  };
  page.on('framenavigated', onNav);
  listeners.push(() => page.off('framenavigated', onNav));

  let fp: KitFingerprint = { id: 'none', confidence: 'none', signals: [] };
  const record = (step: string, result: Step['result'], detail: string, t0: number) =>
    steps.push({ step, result, detail: detail.slice(0, 480), ms: Math.max(0, Date.now() - t0) });
  const navigatedAway = () => urlChanges.some((u) => isUnexpectedNavigation(startUrl, u));
  const finish = (
    outcome: ConnectionDiagnostics['outcome'],
    failure: { category: FailureCategory; step: string; detail: string } | null,
  ): ConnectionDiagnostics => {
    const kitRecipe = fp.confidence === 'high' && fp.id !== 'none';
    return {
      kit: fp,
      strategy: kitRecipe ? 'kit-recipe' : 'generic',
      recipe: `${kitRecipe ? fp.id : 'generic'}@${CONNECT_ENGINE_VERSION}`,
      outcome,
      failure,
      steps: steps.slice(0, 50),
      navigation: {
        urlChanges: urlChanges.slice(0, 20),
        aborted: failure?.category === 'unexpected-navigation',
      },
      requestAccountsCalls: opts.requestAccounts(),
    };
  };
  const fail = (category: FailureCategory, step: string, detail: string) =>
    finish('failed', { category, step, detail: detail.slice(0, 480) });

  // Some dApps request accounts on load (auto-connect): nothing to click.
  if (opts.requestAccounts() > 0) {
    fp = identifyKit(await collectKitSignals(page, opts.hosts()));
    record('auto-connect', 'ok', 'the dApp requested accounts without any interaction', Date.now());
    return finish('connected', null);
  }

  // 1. Open the connect UI. A custom (non-kit) modal counts as open as soon
  //    as a dialog shows our wallet.
  let t0 = Date.now();
  await page.evaluate(DIALOG_SNAPSHOT_PROBE).catch(() => false);
  const open = await openConnectUi(page, {
    hosts: opts.hosts,
    // Open as soon as a NEW dialog offers something actionable.
    opened: async () =>
      (await describe(page, 'canary')) !== null ||
      (await describe(page, 'hop')) !== null ||
      (await describe(page, 'fallback')) !== null,
  });
  fp = open.fingerprint;
  // Both listeners watch the same frame; keep this engine's (cut) list only.
  if (open.outcome === 'unexpected-navigation') {
    record('open-connect-ui', 'failed', open.detail, t0);
    return fail('unexpected-navigation', 'open-connect-ui', open.detail);
  }
  if (open.outcome === 'no-connect-control' || open.outcome === 'click-failed') {
    record('open-connect-ui', 'failed', open.detail, t0);
    return fail(
      open.outcome === 'no-connect-control' ? 'no-connect-control' : 'modal-not-opened',
      'open-connect-ui',
      open.detail,
    );
  }
  // A dApp may request accounts right after the click (single-wallet flows).
  if (opts.requestAccounts() > 0) {
    record('open-connect-ui', 'ok', `clicked "${open.clicked?.name}"; accounts requested`, t0);
    return finish('connected', null);
  }
  if (
    open.outcome === 'modal-not-opened' &&
    !(await page.evaluate(DIALOG_OPEN_PROBE).catch(() => false))
  ) {
    record('open-connect-ui', 'failed', open.detail, t0);
    return fail('modal-not-opened', 'open-connect-ui', open.detail);
  }
  record('open-connect-ui', 'ok', `clicked "${open.clicked?.name}" → ${open.detail}`, t0);

  // 2. Choose the wallet inside the dialog.
  t0 = Date.now();
  let chosen: { kind: ChoiceKind; detail: string } | null = null;
  for (let hop = 0; hop <= maxHops && !chosen; hop++) {
    // The wallet list may still be rendering: wait briefly for our wallet.
    await waitFor(
      page,
      async () => (await describe(page, 'canary')) !== null,
      hop === 0 ? 2_500 : 4_000,
    );
    const c = await click(page, 'canary');
    if (c.ok) {
      chosen = { kind: 'canary', detail: c.detail };
      break;
    }
    if (hop === maxHops) break;
    const h = await click(page, 'hop');
    if (!h.ok) break;
    record('reveal-wallet-list', 'ok', h.detail, t0);
    t0 = Date.now();
    if (navigatedAway())
      return fail('unexpected-navigation', 'reveal-wallet-list', urlChanges.at(-1)!);
  }
  if (!chosen) {
    const f = await click(page, 'fallback');
    if (f.ok) chosen = { kind: 'fallback', detail: f.detail };
  }
  if (!chosen) {
    record(
      'select-wallet',
      'failed',
      'no canary, hop or injected-wallet entry inside the dialog',
      t0,
    );
    return fail(
      'wallet-option-missing',
      'select-wallet',
      'the open dialog offers neither our EIP-6963 wallet nor a generic injected entry',
    );
  }
  record('select-wallet', 'ok', `${chosen.kind}: ${chosen.detail}`, t0);
  if (navigatedAway()) return fail('unexpected-navigation', 'select-wallet', urlChanges.at(-1)!);

  // 3. Connected means the dApp asked our wallet for accounts.
  t0 = Date.now();
  const requested = await waitFor(page, () => opts.requestAccounts() > 0, requestTimeoutMs);
  if (!requested) {
    record('await-request', 'failed', `no eth_requestAccounts within ${requestTimeoutMs} ms`, t0);
    return fail(
      'request-not-issued',
      'await-request',
      `selected ${chosen.detail} but the dApp never called eth_requestAccounts`,
    );
  }
  record('await-request', 'ok', `eth_requestAccounts ×${opts.requestAccounts()}`, t0);

  // 4. Optional sign-in confirmation (SIWE) inside the dialog: one click.
  t0 = Date.now();
  await page.waitForTimeout(1_500);
  const sign = await describe(page, 'sign');
  if (sign) {
    const s = await click(page, 'sign');
    record('sign-in', s.ok ? 'ok' : 'failed', s.detail, t0);
    await page.waitForTimeout(1_000);
  } else {
    record('sign-in', 'skipped', 'no sign-in confirmation shown', t0);
  }
  // Leaving the origin after connecting means the post-connect phase would
  // observe some other site: report it rather than call the scan complete.
  if (navigatedAway())
    return fail('unexpected-navigation', 'after-connect', urlChanges.at(-1) ?? '');
  const after = identifyKit(await collectKitSignals(page, opts.hosts()));
  if (fp.confidence !== 'high' && after.confidence === 'high') fp = after;
  return finish('connected', null);
}
