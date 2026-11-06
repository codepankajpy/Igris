/**
 * Page-side probes, as plain JavaScript source strings.
 *
 * Why strings: functions passed to page.evaluate are serialized from the
 * compiled module, and esbuild-based toolchains (tsx, vitest) inject helpers
 * (`__name`) that do not exist in the page. Strings run identically under tsc,
 * tsx and vitest. Every probe is READ-ONLY: it never mutates the page.
 *
 * All probes traverse OPEN shadow roots (wallet kits such as AppKit render
 * entirely inside nested shadow DOM).
 */

/** Shared helpers, prepended to every probe. */
const HELPERS = `
  const deepAll = (root, selector) => {
    const out = [];
    const walk = (r) => {
      for (const el of r.querySelectorAll(selector)) out.push(el);
      for (const el of r.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(root);
    return out;
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01;
  };
  const accName = (el) => {
    const aria = el.getAttribute('aria-label');
    const text = aria && aria.trim() ? aria : (el.innerText || el.textContent || '');
    return text.replace(/\\s+/g, ' ').trim();
  };
`;

/**
 * Kit signals currently observable on the page. Returns
 * Array<{ kit, strength: 'strong'|'weak', stage: 'static'|'modal', marker }>.
 * Every marker was verified against a live deployment (docs/CORPUS.md).
 */
export const KIT_SIGNALS_PROBE = `(() => {
  ${HELPERS}
  const s = [];
  const add = (kit, strength, stage, marker, cond) => { if (cond) s.push({ kit, strength, stage, marker }); };
  const visibleAny = (sel) => deepAll(document, sel).some(isVisible);
  // RainbowKit — testids are RainbowKit's own; the option id is the wallet's EIP-6963 rdns.
  add('rainbowkit', 'strong', 'static', '[data-testid="rk-connect-button"]', visibleAny('[data-testid="rk-connect-button"]'));
  add('rainbowkit', 'strong', 'modal', '#rk_connect_title', visibleAny('#rk_connect_title'));
  add('rainbowkit', 'strong', 'modal', '[data-testid^="rk-wallet-option-"]', visibleAny('[data-testid^="rk-wallet-option-"]'));
  // ConnectKit — modal root; [data-rk] is NOT used (Aave ships an unused RainbowKit style root).
  add('connectkit', 'strong', 'modal', '#__CONNECTKIT__ [role="dialog"]', visibleAny('#__CONNECTKIT__ [role="dialog"]'));
  add('connectkit', 'weak', 'modal', '[data-connectkit]', deepAll(document, '[data-connectkit]').length > 0);
  // AppKit / Web3Modal — custom elements are registered when the SDK initialises.
  const ce = ['appkit-modal', 'w3m-modal', 'appkit-button', 'w3m-button'].filter((n) => customElements.get(n));
  add('appkit', 'strong', 'static', 'customElements:' + ce.join(','), ce.length > 0);
  add('appkit', 'strong', 'modal', 'wui-list-wallet (visible)', visibleAny('wui-list-wallet, wui-list-select-wallet'));
  // Privy — the auth iframe loads even when the app's own modal is used (Uniswap), so it is weak.
  add('privy', 'weak', 'static', 'iframe[src*="auth.privy.io"]', document.querySelectorAll('iframe[src*="auth.privy.io"]').length > 0);
  add('privy', 'strong', 'modal', '#privy-modal-content', visibleAny('#privy-modal-content'));
  // Dynamic — verified on bungee.exchange: the SDK mounts div.dynamic-shadow-dom
  // (shadow host); its auth modal heading carries a stable testid.
  add('dynamic', 'weak', 'static', 'div.dynamic-shadow-dom', document.querySelectorAll('div.dynamic-shadow-dom').length > 0);
  add('dynamic', 'strong', 'modal', '[data-testid="dynamic-auth-modal-heading"]', visibleAny('[data-testid="dynamic-auth-modal-heading"]'));
  return s;
})()`;

/** A connect-control candidate as seen in the page (read-only description). */
export interface RawCandidate {
  index: number;
  tag: string;
  name: string;
  role: string | null;
  href: string | null;
  disabled: boolean;
  visible: boolean;
  inFooter: boolean;
  top: number;
  hasPopup: boolean;
}

/** Selector for interactive elements considered as connect controls. */
export const CANDIDATE_SELECTOR =
  'button, [role="button"], a[href], input[type="button"], input[type="submit"], appkit-button, w3m-button, appkit-connect-button, w3m-connect-button';

/**
 * Describe every interactive element (deep). Returns RawCandidate[]; the
 * element order matches CANDIDATE_HANDLES_PROBE so indices line up.
 */
export const CANDIDATES_PROBE = `(() => {
  ${HELPERS}
  const els = deepAll(document, ${JSON.stringify(CANDIDATE_SELECTOR)});
  return els.map((el, index) => {
    const r = el.getBoundingClientRect();
    return {
      index,
      tag: el.tagName.toLowerCase(),
      name: accName(el).slice(0, 120),
      role: el.getAttribute('role'),
      href: el.tagName === 'A' ? el.getAttribute('href') : null,
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      visible: isVisible(el),
      inFooter: Boolean(el.closest && el.closest('footer')),
      top: Math.round(r.top + window.scrollY),
      hasPopup: el.getAttribute('aria-haspopup') === 'dialog' || el.getAttribute('aria-haspopup') === 'true',
    };
  });
})()`;

/**
 * The candidate at `index` of the CANDIDATES_PROBE ordering, as an element
 * (for evaluateHandle). The index is interpolated as a number literal: a
 * string passed to JSHandle.evaluateHandle is evaluated as an EXPRESSION, not
 * called with arguments — that bug made every click fail in the first
 * discovery run.
 */
export const candidateHandleProbe = (index: number): string => {
  if (!Number.isInteger(index) || index < 0)
    throw new Error('candidate index must be a non-negative integer');
  return `(() => {
  ${HELPERS}
  return deepAll(document, ${JSON.stringify(CANDIDATE_SELECTOR)})[${index}] || null;
})()`;
};

/** Visible elements whose accessible name matches one of the given wallet labels. */
export const walletOptionProbe = (labels: string[]): string => `(() => {
  ${HELPERS}
  const wanted = ${JSON.stringify(labels.map((l) => l.toLowerCase()))};
  const els = deepAll(document, 'button, [role="button"], [role="option"], [role="menuitem"], li, wui-list-wallet, wui-list-select-wallet, [data-testid]');
  return els
    .map((el, index) => ({ index, name: accName(el).toLowerCase(), visible: isVisible(el) }))
    .filter((c) => c.visible && wanted.some((w) => c.name === w || c.name.startsWith(w + ' ')));
})()`;

/**
 * Read-only inventory of what a user would see: visible interactive control
 * names, open dialogs, wallet labels, visible custom elements and iframe
 * hosts. Used by discovery to explain WHY a connect attempt did or did not
 * reach a known kit (diagnosing false negatives of the scorer/fingerprint).
 */
export const INVENTORY_PROBE = `(() => {
  ${HELPERS}
  const uniq = (xs, n) => [...new Set(xs)].slice(0, n);
  const controls = deepAll(document, ${JSON.stringify(CANDIDATE_SELECTOR)})
    .filter(isVisible).map((el) => accName(el).slice(0, 50)).filter(Boolean);
  const dialogs = deepAll(document, '[role="dialog"], [aria-modal="true"], dialog[open]')
    .filter(isVisible)
    .map((d) => (d.getAttribute('aria-label') || (d.querySelector('h1,h2,h3,[role="heading"]') || d).textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60));
  const walletRe = /^(igris canary wallet|metamask|walletconnect|coinbase( wallet)?|rabby( wallet)?|rainbow|browser wallet|injected( wallet)?|phantom|trust( wallet)?|continue with a wallet)\\b/i;
  const walletLabels = deepAll(document, '*')
    .filter((el) => el.children.length === 0 && isVisible(el))
    .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim())
    .filter((t) => walletRe.test(t) && t.length < 40);
  const customTags = deepAll(document, '*')
    .filter((el) => el.tagName.includes('-') && isVisible(el)).map((el) => el.tagName.toLowerCase());
  const iframes = [...document.querySelectorAll('iframe')].map((f) => { try { return new URL(f.src).hostname; } catch { return ''; } }).filter(Boolean);
  return {
    controls: uniq(controls, 20),
    dialogs: uniq(dialogs, 6),
    walletLabels: uniq(walletLabels, 12),
    customTags: uniq(customTags, 12),
    iframes: uniq(iframes, 8),
  };
})()`;

/**
 * Read-only ancestry signature of the visible wallet option labelled with one
 * of `labels` (default: our own EIP-6963 name): for up to 14 ancestors —
 * crossing shadow-root boundaries — record tag, id, role, data-* attribute
 * names (data-testid with its value) and the first class tokens. This is the
 * evidence used to attribute an unrecognised connect modal to a library.
 */
export const walletOptionAncestryProbe = (
  labels: string[] = ['igris canary wallet'],
): string => `(() => {
  ${HELPERS}
  const wanted = ${JSON.stringify(labels.map((l) => l.toLowerCase()))};
  const leaf = deepAll(document, '*').find((el) => el.children.length === 0 && isVisible(el) &&
    wanted.includes((el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase()));
  if (!leaf) return null;
  const chain = [];
  let el = leaf;
  for (let i = 0; el && i < 14; i++) {
    if (el.nodeType === 1) {
      const attrs = [...el.attributes].map((a) => a.name)
        .filter((n) => n.startsWith('data-') || n === 'role' || n.startsWith('aria-modal'))
        .map((n) => (n === 'data-testid' ? n + '=' + el.getAttribute(n) : n));
      chain.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        attrs: attrs.slice(0, 8),
        classes: String(el.getAttribute('class') || '').split(/\\s+/).filter(Boolean).slice(0, 3),
        shadowHost: Boolean(el.shadowRoot),
      });
    }
    const parent = el.parentNode;
    el = parent && parent.nodeType === 11 ? parent.host : el.parentElement;
  }
  return chain;
})()`;
