/**
 * Connect-modal probe (diagnostics): for each URL, open the connect UI with
 * strict scoring, then record what is visible and clickable INSIDE the open
 * dialog(s) — including open shadow roots — plus a screenshot. One click
 * (the connect control); no wallet entry is selected and nothing is signed.
 * Traffic goes through the scanner's public-only egress proxy, and the
 * injected wallet uses a fresh throwaway address per run.
 *
 * Usage: pnpm exec tsx scripts/connect-probe.ts <out-dir> <url> [url…]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { randomBytes } from 'node:crypto';
import {
  buildWalletInitScript,
  egressChromiumArgs,
  openConnectUi,
  startEgressProxy,
} from '@igris/scanner';

const [outDir, ...urls] = process.argv.slice(2);
if (!outDir || urls.length === 0) {
  console.error('usage: connect-probe.ts <out-dir> <url> [url…]');
  process.exit(3);
}
mkdirSync(outDir, { recursive: true });

// Fresh random address per run: no key exists for it, so nothing can be signed.
const ADDRESS = `0x${randomBytes(20).toString('hex')}`;

const DIALOG_PROBE = `(() => {
  const deepAll = (root, sel) => { const out = []; const walk = (r) => { for (const el of r.querySelectorAll(sel)) out.push(el); for (const el of r.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot); }; walk(root); return out; };
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01; };
  const name = (el) => ((el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 80);
  const dialogs = deepAll(document, '[role="dialog"], [aria-modal="true"], dialog[open], #privy-modal-content, w3m-modal, appkit-modal, [data-testid*="modal" i]').filter(vis);
  const roots = dialogs.length ? dialogs : [];
  const inRoot = (el) => roots.some((d) => { let n = el; while (n) { if (n === d) return true; const p = n.parentNode; n = p && p.nodeType === 11 ? p.host : n.parentElement; } return false; });
  const clickables = deepAll(document, 'button, [role="button"], [role="option"], [role="menuitem"], a, li, wui-list-wallet, wui-list-select-wallet, [data-testid]')
    .filter((el) => vis(el) && inRoot(el))
    .map((el) => ({ tag: el.tagName.toLowerCase(), testid: el.getAttribute('data-testid'), name: name(el) }))
    .filter((c) => c.name || c.testid);
  const seen = new Set(); const uniq = clickables.filter((c) => { const k = c.tag + '|' + c.testid + '|' + c.name; if (seen.has(k)) return false; seen.add(k); return true; });
  return {
    dialogs: dialogs.map((d) => ({ tag: d.tagName.toLowerCase(), id: d.id || null, testid: d.getAttribute('data-testid'), text: name(d).slice(0, 160) })).slice(0, 6),
    clickables: uniq.slice(0, 60),
    canaryVisible: deepAll(document, '*').some((el) => el.children.length === 0 && vis(el) && /igris canary wallet/i.test(el.textContent || '')),
  };
})()`;

const results: unknown[] = [];
for (const url of urls) {
  const proxy = await startEgressProxy({});
  const browser = await chromium.launch({ headless: true, args: egressChromiumArgs(proxy.url) });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    serviceWorkers: 'block',
  });
  await context.exposeFunction('__igrisWalletRead', async () => ({ result: '0x0' }));
  await context.exposeFunction('__igrisSign', async () => {
    throw new Error('probe never signs');
  });
  await context.exposeFunction('__igrisWalletEvent', async () => {});
  await context.addInitScript(
    buildWalletInitScript({ address: ADDRESS, chainId: 1, spoofMetaMask: true }),
  );
  const hosts = new Set<string>();
  context.on('request', (r: { url(): string }) => {
    try {
      hosts.add(new URL(r.url()).hostname);
    } catch {
      /* ignore */
    }
  });
  const page = await context.newPage();
  const slug = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_');
  const rec: Record<string, unknown> = { url };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const open = await openConnectUi(page, { hosts: () => hosts });
    rec.open = {
      outcome: open.outcome,
      clicked: open.clicked?.name ?? null,
      kit: open.fingerprint,
      detail: open.detail,
      topCandidates: open.candidates.slice(0, 5).map((c) => `${c.name} (${c.score})`),
    };
    await page.waitForTimeout(1500);
    rec.modal = await page.evaluate(DIALOG_PROBE);
    await page.screenshot({ path: join(outDir, `${slug}.png`) });
  } catch (err) {
    rec.error = String(err).slice(0, 300);
  }
  results.push(rec);
  console.log(JSON.stringify(rec, null, 1).slice(0, 4000));
  await browser.close();
  await proxy.close();
}
writeFileSync(join(outDir, 'probe.json'), JSON.stringify(results, null, 2) + '\n');
