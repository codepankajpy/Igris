/**
 * Corpus discovery: identify which wallet kit a real dapp ACTUALLY uses for
 * connecting, by observation. For each URL: load it with the canary wallet
 * injected, classify the load (unavailable / bot-blocked / incompatible),
 * record static kit signals, open the connect UI with strict candidate
 * scoring, and record the kit whose MODAL appeared (signals + confidence).
 * Nothing is connected or signed here; one page load + one click per site.
 *
 * Usage: pnpm exec tsx scripts/corpus-discover.ts <urls.txt> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  buildWalletInitScript,
  classifyLoad,
  collectKitSignals,
  identifyKit,
  observeLoad,
  openConnectUi,
  INVENTORY_PROBE,
  walletOptionAncestryProbe,
} from '@igris/scanner';

const [urlsFile, outFile] = process.argv.slice(2);
if (!urlsFile || !outFile) {
  console.error('usage: corpus-discover.ts <urls.txt> <out.json>');
  process.exit(3);
}
const urls = readFileSync(urlsFile, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

// Throwaway, never funded; discovery never connects or signs.
const DISCOVERY_ADDRESS = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';

const results: unknown[] = [];
for (const url of urls) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    serviceWorkers: 'block',
  });
  await context.exposeFunction('__igrisWalletRead', async () => ({ result: '0x0' }));
  await context.exposeFunction('__igrisSign', async () => {
    throw new Error('discovery never signs');
  });
  await context.addInitScript(
    buildWalletInitScript({ address: DISCOVERY_ADDRESS, chainId: 1, spoofMetaMask: true }),
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
  const rec: Record<string, unknown> = { url, observedAt: new Date().toISOString() };
  try {
    let response = null;
    let error: string | undefined;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      error = String(err);
    }
    if (!error) await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
    const verdict = classifyLoad(error ? { error } : await observeLoad(page, response));
    rec.load = verdict.ok
      ? { ok: true, finalUrl: page.url(), title: (await page.title()).slice(0, 80) }
      : verdict;
    if (verdict.ok) {
      rec.staticFingerprint = identifyKit(await collectKitSignals(page, hosts));
      const inventory = async () =>
        page.evaluate(INVENTORY_PROBE).catch((e: unknown) => ({ error: String(e).slice(0, 120) }));
      const before = await inventory();
      const open = await openConnectUi(page, { hosts: () => hosts, modalTimeoutMs: 10_000 });
      rec.inventory = { beforeClick: before, afterClick: await inventory() };
      rec.walletOptionAncestry = await page
        .evaluate(walletOptionAncestryProbe())
        .catch((e: unknown) => ({ error: String(e).slice(0, 120) }));
      rec.open = {
        outcome: open.outcome,
        clicked: open.clicked?.name ?? null,
        topCandidates: open.candidates.slice(0, 3).map((c) => `${c.name} (${c.score})`),
        fingerprint: open.fingerprint,
        urlChanges: open.urlChanges,
        detail: open.detail,
      };
    }
  } catch (err) {
    rec.error = String(err).slice(0, 200);
  } finally {
    await browser.close().catch(() => {});
  }
  results.push(rec);
  const o = rec.open as
    { outcome?: string; fingerprint?: { id: string; confidence: string } } | undefined;
  console.log(
    `${url.padEnd(36)} ${(rec.load as { ok?: boolean; category?: string }).ok ? 'loaded' : (rec.load as { category?: string }).category} ` +
      `${o ? `${o.outcome} kit=${o.fingerprint?.id}/${o.fingerprint?.confidence}` : ''}`,
  );
}
writeFileSync(
  outFile,
  JSON.stringify({ version: 1, generatedBy: 'scripts/corpus-discover.ts', results }, null, 2) +
    '\n',
);
process.exit(0);
