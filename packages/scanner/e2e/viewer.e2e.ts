/**
 * Web viewer proofs:
 *  1. ZERO network requests beyond the page's own origin when pointed at a
 *     local snapshot (the registry viewer must not phone home).
 *  2. The snapshot renders: records appear, filters work, detail page shows
 *     findings — i.e. Arkiv-shaped reads drive the visible feature offline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOST_RULES, PAGE_PORT, REPO_ROOT, serveDist } from './helpers.js';

const WEB = join(REPO_ROOT, 'apps/web');
const VIEWER_PORT = PAGE_PORT + 3;
const ORIGIN = `http://igris-viewer.test:${VIEWER_PORT}`;

const SNAPSHOT = {
  version: 1,
  records: [
    {
      id: 'local-leaky-dapp.test-1-1',
      scanner: 'local',
      hostname: 'leaky-dapp.test',
      score: 12,
      scannedAt: 1_793_900_000,
      scannerVersion: '0.1.0',
      reportVersion: '1.0.0',
      chainId: 1,
      thirdPartyCount: 5,
      leakCount: 4,
      leakClasses: 'analytics,cdn,error-monitoring,rpc-provider',
      usesAnonRpc: false,
      reportSha256: 'ab'.repeat(32),
      summary: {
        v: 1,
        status: 'completed',
        spoofMetaMask: true,
        canaryAddress: '0x8ba1f109551bd432803012645ac136ddd64dba72',
        findings: [
          {
            class: 'analytics',
            location: 'request-body',
            encoding: 'checksummed',
            category: 'exact',
            host: 'ingest.igris-analytics.test',
            phase: 'post-connect',
            counted: true,
          },
        ],
        thirdParties: [
          { host: 'ingest.igris-analytics.test', class: 'analytics', phases: ['post-connect'] },
        ],
        ledger: [{ rule: 'leak.analytics', points: 25, label: 'address reached analytics' }],
        readsViaWallet: [],
      },
    },
    {
      id: 'local-clean-dapp.test-2-2',
      scanner: 'local',
      hostname: 'clean-dapp.test',
      score: 97,
      scannedAt: 1_793_910_000,
      scannerVersion: '0.1.0',
      reportVersion: '1.0.0',
      chainId: 1,
      thirdPartyCount: 0,
      leakCount: 0,
      leakClasses: '',
      usesAnonRpc: true,
      reportSha256: 'cd'.repeat(32),
      summary: {
        v: 1,
        status: 'completed',
        spoofMetaMask: true,
        canaryAddress: '0x52908400098527886e0f7030069857d2e4169ee7',
        findings: [],
        thirdParties: [],
        ledger: [],
        readsViaWallet: [{ method: 'eth_getBalance', count: 1 }],
      },
    },
  ],
};

let server: Server;
let browser: Browser;

beforeAll(async () => {
  if (!existsSync(join(WEB, 'dist/index.html')) || process.env.IGRIS_FORCE_BUILD) {
    execFileSync('pnpm', ['exec', 'vite', 'build'], { cwd: WEB, stdio: 'pipe', timeout: 120_000 });
  }
  writeFileSync(join(WEB, 'dist/snapshot.json'), JSON.stringify(SNAPSHOT));
  server = await serveDist(join(WEB, 'dist'), VIEWER_PORT);
  browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=${HOST_RULES}`],
  });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server.close(() => r(undefined)));
});

describe('registry viewer', () => {
  it('makes ZERO network requests outside its own origin (snapshot mode)', async () => {
    const context = await browser.newContext();
    const requests: string[] = [];
    context.on('request', (req) => requests.push(req.url()));
    const page = await context.newPage();
    // Pre-set snapshot mode the way a user would have it persisted.
    await context.addInitScript(() => localStorage.setItem('igris:mode', 'snapshot'));
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const offOrigin = requests.filter((u) => !u.startsWith(ORIGIN));
    expect(offOrigin).toEqual([]);
    await context.close();
  });

  it('renders records, filters them, and shows a detail page', async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem('igris:mode', 'snapshot'));
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });

    // Both records render; the anon-rpc badge shows on the clean dapp.
    await page.waitForSelector('tbody tr');
    expect(await page.locator('tbody tr').count()).toBe(2);
    expect(await page.textContent('body')).toContain('leaky-dapp.test');
    expect(await page.textContent('body')).toContain('anon-rpc');

    // Filter: min score 50 keeps only the clean dapp.
    await page.fill('#f-min', '50');
    await page.click('#apply');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
    expect(await page.textContent('tbody')).toContain('clean-dapp.test');

    // Filter by leak class brings the leaky one back alone.
    await page.fill('#f-min', '');
    await page.selectOption('#f-class', 'analytics');
    await page.click('#apply');
    await page.waitForFunction(
      () => document.querySelector('tbody')?.textContent?.includes('leaky-dapp.test') ?? false,
    );
    expect(await page.locator('tbody tr').count()).toBe(1);

    // Detail page lists findings and the ledger.
    await page.click('tbody tr');
    const body = await page.textContent('body');
    expect(body).toContain('report sha256');
    expect(body).toContain('leak.analytics');
    expect(body).toContain('ingest.igris-analytics.test');
    await context.close();
  });
});
