/**
 * The extension popup renders snapshot data (untrusted: anyone can publish
 * entities). This drives popup.html in Chromium with a stubbed `chrome` API
 * and a hostile snapshot, and checks nothing executes. It tests the popup's
 * rendering logic only — loading the MV3 extension in a real browser
 * remains UNVERIFIED (extension/README.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { PAGE_PORT, REPO_ROOT, serveDist } from './helpers.js';

const PORT = PAGE_PORT + 30;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let server: Server;
let browser: Browser;

beforeAll(async () => {
  server = await serveDist(join(REPO_ROOT, 'extension'), PORT);
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server.close(() => r(undefined)));
});

describe('extension popup with a hostile snapshot', () => {
  it('escapes every field; no script runs', async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      (window as unknown as { chrome: unknown }).chrome = {
        tabs: { query: async () => [{ url: 'https://victim.test/' }] },
        runtime: { getURL: (p: string) => `/${p}` },
      };
    });
    const page = await context.newPage();
    await page.route('**/snapshot.json', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          records: [
            {
              hostname: 'victim.test',
              score: 42,
              scannedAt: 1_793_900_000,
              leakCount: '<img src=x onerror="window.__x1=1">',
              thirdPartyCount: 3,
              leakClasses: '<img src=x onerror="window.__x2=1">',
              scanner: '<svg onload="window.__x3=1">',
              usesAnonRpc: false,
            },
            // score with markup: filtered out entirely
            { hostname: 'victim.test', score: '<img src=x onerror="window.__x4=1">', scannedAt: 1 },
          ],
        }),
      }),
    );
    await page.goto(`${ORIGIN}/popup.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.body.textContent?.includes('victim.test'));
    const flags = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return [w.__x1, w.__x2, w.__x3, w.__x4];
    });
    expect(flags).toEqual([undefined, undefined, undefined, undefined]);
    expect(await page.locator('img, svg').count()).toBe(0);
    const text = (await page.textContent('body')) ?? '';
    expect(text).toContain('42');
    expect(text).toContain('not checked against Arkiv');
    await context.close();
  });
});
