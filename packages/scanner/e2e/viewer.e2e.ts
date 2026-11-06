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

/** A valid record whose free-text label carries markup, plus hostile/malformed rows. */
function hostileSnapshot() {
  const base = SNAPSHOT.records[0]!;
  return {
    version: 1,
    records: [
      {
        ...base,
        id: '0x' + 'ab'.repeat(32),
        scanner: '0x' + 'cd'.repeat(20),
        hostname: 'labelled.test',
        summary: {
          ...base.summary,
          ledger: [
            {
              rule: 'leak.analytics',
              points: 25,
              label: '<img src=x onerror="window.__xss1=1">label',
            },
          ],
        },
      },
      // Markup in a numeric field: must be rejected by validation.
      {
        ...base,
        id: 'local-hostile-1',
        hostname: 'hostile.test',
        summary: {
          ...base.summary,
          ledger: [
            { rule: 'leak.analytics', points: '<img src=x onerror="window.__xss2=1">', label: 'x' },
          ],
        },
      },
      // Markup in the hostname attribute: rejected.
      { ...base, id: 'local-hostile-2', hostname: '<svg onload="window.__xss3=1">' },
      // Not even an object.
      'junk',
    ],
  };
}

describe('registry viewer — untrusted data and provenance (P0-4, P0-8)', () => {
  it('hostile entities render inert; malformed rows are dropped and counted', async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem('igris:mode', 'snapshot'));
    const page = await context.newPage();
    await page.route('**/snapshot.json', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(hostileSnapshot()) }),
    );
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('tbody tr');
    expect(await page.locator('tbody tr').count()).toBe(1);
    expect(await page.textContent('body')).toContain('3 malformed entities ignored');

    await page.click('tbody tr');
    const xss = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return [w.__xss1, w.__xss2, w.__xss3];
    });
    expect(xss).toEqual([undefined, undefined, undefined]);
    expect(await page.locator('img[src="x"], svg[onload]').count()).toBe(0);
    // The label is shown as text, not markup.
    expect(await page.textContent('body')).toContain('<img src=x onerror=');
    await context.close();
  });

  it('snapshot rows are labelled as unchecked snapshot data, never "trusted"', async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem('igris:mode', 'snapshot'));
    const page = await context.newPage();
    await page.route('**/snapshot.json', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(hostileSnapshot()) }),
    );
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('tbody tr');
    expect(await page.textContent('tbody')).toContain('(snapshot)');
    expect(await page.textContent('tbody')).toContain('not pinned');
    await page.click('tbody tr');
    const body = (await page.textContent('body')) ?? '';
    expect(body).toContain('not checked against Arkiv');
    expect(body).not.toMatch(/trusted/i);
    expect(body).not.toContain('Read live from Arkiv');
    await context.close();
  });

  it('an API scan result is shown as "Unpublished — not on Arkiv" with no scanner attribution', async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem('igris:mode', 'snapshot'));
    const page = await context.newPage();
    const preview = { ...SNAPSHOT.records[1]!, hostname: 'scanned-via-api.test' } as Record<
      string,
      unknown
    >;
    delete preview.id;
    delete preview.scanner;
    await page.route('**/api/scan', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          provenance: 'unpublished',
          preview,
          report: { score: 97, status: 'completed', errors: [] },
        }),
      }),
    );
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
    await page.fill('#scan-url-input', 'https://scanned-via-api.test/');
    await page.click('#btn-start-scan');
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Unpublished — not on Arkiv'),
    );
    const body = (await page.textContent('body')) ?? '';
    expect(body).toContain('scanned-via-api.test');
    expect(body).not.toMatch(/trusted/i);
    expect(body).not.toContain('Read live from Arkiv');
    expect(body).not.toContain('0xDbd0309b80f71E12d45Ac8321DBA637156a4198B');
    await context.close();
  });

  it('an API scan that measured nothing shows "Not scored" and adds no result', async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem('igris:mode', 'snapshot'));
    const page = await context.newPage();
    await page.route('**/api/scan', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          provenance: 'unpublished',
          preview: null,
          report: {
            score: null,
            status: 'page-load-failed',
            errors: ['page load failed: HTTP 404'],
          },
        }),
      }),
    );
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
    await page.fill('#scan-url-input', 'https://down.test/');
    await page.click('#btn-start-scan');
    await page.waitForFunction(() => document.body.textContent?.includes('Not scored'));
    expect(await page.textContent('body')).not.toContain('Your unpublished scans');
    await context.close();
  });
});
