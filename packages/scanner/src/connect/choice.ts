/**
 * Choosing the wallet INSIDE an open connect dialog.
 *
 * The legacy heuristic searched the whole page for /metamask/i and clicked
 * relay.link's marketing line "…powering Phantom, MetaMask…". Everything here
 * is scoped to visible dialog roots (open shadow roots included) and matches
 * whole accessible names, never substrings of prose.
 *
 * Preference, verified live on 2026-11-06 (scripts/connect-probe.ts):
 *  1. canary — our EIP-6963 wallet: data-testid containing our rdns
 *     (RainbowKit `rk-wallet-option-network.igris.canary`, AppKit
 *     `wallet-selector-network.igris.canary`) or the exact name
 *     "Igris Canary Wallet" (+ a status word: Detected / Installed …) —
 *     ConnectKit (Aave), Privy (Matcha), Uniswap's own modal;
 *  2. hop — a control that reveals the wallet list (Dynamic shows email /
 *     social first: "Continue with a wallet");
 *  3. fallback — generic injected labels, exact names only ("Browser
 *     Wallet", "Injected", "MetaMask" — the canary also answers isMetaMask).
 */

/** Our EIP-6963 rdns (wallet-init.ts announces it). */
export const CANARY_RDNS = 'network.igris.canary';

const STATUS = '(?:\\s+(?:detected|installed|recent|recommended|popular|last used))?';

export const CANARY_NAME = new RegExp(`^igris canary wallet${STATUS}$`, 'i');

/** Controls that open the wallet list, best first (whole names). */
export const HOP_NAMES: RegExp[] = [
  /^continue with (?:a |your )?wallet$/i,
  /^(?:connect|use) (?:a |your )?wallet$/i,
  /^(?:other|more|all) wallets?$/i,
  /^view all(?: wallets)?$/i,
  /^show (?:more|all)(?: wallets)?$/i,
  /^(?:browser|injected|extension) wallets$/i,
];

/** Generic injected entries, best first (whole names). */
export const FALLBACK_NAMES: RegExp[] = [
  new RegExp(`^browser wallet${STATUS}$`, 'i'),
  new RegExp(`^injected(?: wallet)?${STATUS}$`, 'i'),
  new RegExp(`^metamask${STATUS}$`, 'i'),
];

/** After connecting, a sign-in (SIWE) confirmation inside the dialog. */
export const SIGN_NAMES: RegExp[] = [
  /^sign(?: message| in| in with ethereum)?$/i,
  /^verify(?: wallet| account| ownership)?$/i,
];

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function isCanaryChoice(name: string, testid: string | null): boolean {
  return Boolean(testid && testid.includes(CANARY_RDNS)) || CANARY_NAME.test(norm(name));
}

/** Rank of a name in a list of whole-name patterns, or -1. */
export function rankIn(list: RegExp[], name: string): number {
  const n = norm(name);
  return list.findIndex((re) => re.test(n));
}
