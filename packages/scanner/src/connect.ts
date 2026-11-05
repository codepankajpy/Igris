/**
 * Connect-wallet heuristics — ALL the magic strings live here, with reasons.
 *
 * Strategy: find a clickable element whose visible text looks like a connect
 * action, click it, then (if a wallet-picker modal appears) click the entry
 * that matches our injected provider. Sites with stranger flows use a recipe
 * (recipes/README.md documents the schema).
 */
import type { Page } from 'playwright';

/**
 * Texts that mean "connect a wallet". Kept deliberately short: overly broad
 * patterns (e.g. /sign/) would click "Sign out" or newsletter sign-ups.
 */
export const CONNECT_TEXT = /connect( wallet)?|sign in|log ?in|launch app|get started/i;

/**
 * Wallet-picker entries that select our injected provider, in preference
 * order: our own EIP-6963 name first, then the generic injected labels, then
 * MetaMask (we optionally spoof isMetaMask — see --spoof-metamask).
 */
export const WALLET_OPTION_TEXTS = [
  /igris canary wallet/i,
  /injected/i,
  /browser wallet/i,
  /detected/i,
  /metamask/i,
];

export interface RecipeStep {
  /** CSS selector or text=… selector to click. */
  click: string;
  /** ms to wait after the click (default 500). */
  waitMs?: number;
}

export interface Recipe {
  /** Documented in recipes/README.md. */
  version: 1;
  steps: RecipeStep[];
}

export interface ConnectResult {
  connected: boolean;
  /** What we clicked, for the report/debugging. */
  log: string[];
}

async function clickFirstVisible(
  page: Page,
  pattern: RegExp,
  log: string[],
  what: string,
): Promise<boolean> {
  const candidates = page
    .locator('button, a, [role="button"], [class*="connect" i]')
    .filter({ hasText: pattern });
  const count = await candidates.count();
  for (let i = 0; i < Math.min(count, 10); i++) {
    const el = candidates.nth(i);
    try {
      if (!(await el.isVisible())) continue;
      const text = (await el.innerText()).trim().slice(0, 60);
      await el.click({ timeout: 2000, noWaitAfter: true });
      log.push(`clicked ${what}: "${text}"`);
      return true;
    } catch {
      /* try the next candidate */
    }
  }
  return false;
}

/**
 * Run a recipe (explicit click path), or the generic heuristic.
 * Returns whether eth_requestAccounts ended up being called is NOT known here;
 * the caller checks the wallet's connected state via page evaluation.
 */
export async function connectWallet(
  page: Page,
  recipe: Recipe | undefined,
  log: string[],
): Promise<void> {
  if (recipe) {
    for (const step of recipe.steps) {
      try {
        await page.locator(step.click).first().click({ timeout: 5000 });
        log.push(`recipe click: ${step.click}`);
      } catch (err) {
        log.push(`recipe click FAILED: ${step.click} (${String(err).slice(0, 100)})`);
      }
      await page.waitForTimeout(step.waitMs ?? 500);
    }
    return;
  }

  const clickedConnect = await clickFirstVisible(page, CONNECT_TEXT, log, 'connect button');
  if (!clickedConnect) {
    log.push('no connect button found by heuristic');
    return;
  }
  await page.waitForTimeout(1000); // let a wallet-picker modal render

  for (const pattern of WALLET_OPTION_TEXTS) {
    if (await clickFirstVisible(page, pattern, log, 'wallet option')) {
      await page.waitForTimeout(500);
      break;
    }
  }
}

/** Ask the injected wallet whether the dapp completed eth_requestAccounts. */
export async function isWalletConnected(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const eth = (window as any).ethereum;
      if (!eth) return false;
      const accounts = (await eth.request({ method: 'eth_accounts' })) as string[];
      return accounts.length > 0;
    });
  } catch {
    return false;
  }
}
