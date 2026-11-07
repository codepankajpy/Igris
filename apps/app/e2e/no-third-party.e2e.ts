/**
 * CROPS requirement: "No third-party trackers or analytics in the client".
 *
 * Proof, in two parts:
 *  1. Runtime — the BUILT app (apps/app/dist) is served from a local static
 *     server on 127.0.0.1:<random port>; every /api call is stubbed with
 *     realistic fixtures; every route is visited in a fresh browser context
 *     (cold cache, so every document/script/style/font/fetch/SSE request is
 *     made and seen), lightly exercised, then held until the network has been
 *     genuinely quiet for QUIET_MS (so timer/debounce/idle-callback trackers
 *     fired after an interaction are still seen), and EVERY request the
 *     context makes must be same-origin (or data:/blob:). Requests to any
 *     other origin are recorded and aborted — the suite never touches the
 *     network.
 *  2. Static — dist/index.html and every built JS/CSS file are scanned for
 *     URLs the browser would fetch from another origin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
} from 'playwright';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Job } from '../src/api.js';
import {
  CACHE_PROBLEM,
  FAILED_ID,
  HOST as SITE,
  NEW_HOST,
  OTHER_HOST,
  PUBLISH_ERROR,
  RUNNING_ID,
  UNPUBLISHED_ID,
  cachedVersionBody,
  citedEvidenceId,
  failedJob,
  flowsTo,
  registry,
  republishedJob,
  runningDoneJob,
  runningJob,
  runningProgress,
  scanStarted,
  siteBody,
  sites,
  sseBody,
  summaryV2,
  summaryV3,
  unpublishedJob,
  unpublishedReport,
  versionBodies,
  walletEvidenceId,
} from './fixtures.js';
import { EMPTY_TEXT, KIND_LABEL } from '../src/report/wallet-requests.js';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(APP_DIR, 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

let server: Server;
let browser: Browser;
let ORIGIN = '';

beforeAll(async () => {
  // Build exactly what ships (tsc --noEmit && vite build). Opt out to reuse dist.
  if (!process.env.IGRIS_E2E_SKIP_BUILD) {
    execFileSync('pnpm', ['run', 'build'], { cwd: APP_DIR, stdio: 'pipe', timeout: 170_000 });
  }
  server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    const file = normalize(join(DIST, path === '/' ? 'index.html' : path));
    if (!file.startsWith(DIST + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(() => r(undefined)));
  if (perRoute.length) {
    const w = Math.max(...perRoute.map((r) => r.route.length));
    const lines = perRoute.map(
      (r) =>
        `  ${r.route.padEnd(w)} ${String(r.total).padStart(3)} requests  ` +
        `(quiet after ${String(r.settledMs).padStart(4)} ms)  ` +
        Object.entries(r.byType)
          .sort()
          .map(([t, n]) => `${t}:${n}`)
          .join(' '),
    );
    console.log(
      `[no-third-party] requests checked per route (all same-origin):\n${lines.join('\n')}\n` +
        `  total: ${perRoute.reduce((a, r) => a + r.total, 0)}`,
    );
  }
});

// ---------------------------------------------------------------- API stub

interface Visit {
  context: BrowserContext;
  page: Page;
  requests: Array<{ url: string; type: string }>;
  unstubbed: string[];
  /** Requests started but not yet finished/failed, and the time of the last start/end. */
  net: { inflight: Set<Request>; lastActivity: number };
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * Fresh context (cold cache) with the API stubbed and all requests recorded.
 * `bypassCSP`: ignore the build's Content-Security-Policy (the negative
 * control only, so injected requests reach the recorder).
 */
async function open(
  viewport?: { width: number; height: number },
  opts: { bypassCSP?: boolean } = {},
): Promise<Visit> {
  const context = await browser.newContext({
    acceptDownloads: true,
    ...(viewport ? { viewport } : {}),
    ...(opts.bypassCSP ? { bypassCSP: true } : {}),
  });
  const visit: Visit = {
    context,
    page: undefined as unknown as Page,
    requests: [],
    unstubbed: [],
    net: { inflight: new Set(), lastActivity: Date.now() },
  };
  // The running scan flips to completed once its event stream has been served;
  // the unpublished scan flips to published once its publish is retried.
  let runningDone = false;
  let republished = false;
  const jobFor = (id: string): Job | undefined =>
    id === FAILED_ID
      ? failedJob
      : id === RUNNING_ID
        ? runningDone
          ? runningDoneJob
          : runningJob
        : id === UNPUBLISHED_ID
          ? republished
            ? republishedJob
            : unpublishedJob
          : undefined;

  // Context-level: also catches popups, workers and anything not tied to a page.
  context.on('request', (r) => {
    visit.requests.push({ url: r.url(), type: r.resourceType() });
    visit.net.inflight.add(r);
    visit.net.lastActivity = Date.now();
  });
  // Aborted third-party requests end in 'requestfailed'; fulfilled/continued ones
  // in 'requestfinished'. A Set (not a counter) cannot drift on a duplicate event.
  const done = (r: Request) => {
    visit.net.inflight.delete(r);
    visit.net.lastActivity = Date.now();
  };
  context.on('requestfinished', done);
  context.on('requestfailed', done);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin !== ORIGIN) return route.abort('blockedbyclient'); // recorded above; never sent
    if (!u.pathname.startsWith('/api/')) return route.continue(); // static dist server
    const m = req.method();
    const p = u.pathname;
    let mm: RegExpExecArray | null;
    if (m === 'GET' && p === '/api/health') return json(route, 200, { ok: true });
    if (m === 'GET' && p === '/api/registry') return json(route, 200, registry);
    if (m === 'GET' && p === '/api/sites') {
      const limit = Number(u.searchParams.get('limit') ?? 20);
      return json(route, 200, { sites: sites.slice(0, limit) });
    }
    if (m === 'GET' && (mm = /^\/api\/sites\/([^/]+)$/.exec(p))) {
      return json(route, 200, siteBody(decodeURIComponent(mm[1]!)));
    }
    if (m === 'GET' && (mm = /^\/api\/sites\/([^/]+)\/versions\/(\d+)$/.exec(p))) {
      const h = decodeURIComponent(mm[1]!);
      const n = Number(mm[2]);
      const body =
        h === SITE ? versionBodies[n] : h === OTHER_HOST && n === 1 ? cachedVersionBody : undefined;
      return body ? json(route, 200, body) : json(route, 404, { error: 'no such version' });
    }
    if (m === 'POST' && (mm = /^\/api\/sites\/([^/]+)\/scans$/.exec(p))) {
      // Retest of the scanned site → the running scan; a first scan → the failed one.
      return json(route, 202, scanStarted(decodeURIComponent(mm[1]!)));
    }
    if (m === 'GET' && (mm = /^\/api\/scans\/([0-9a-f-]{36})$/.exec(p))) {
      const job = jobFor(mm[1]!);
      return job ? json(route, 200, { scan: job }) : json(route, 404, { error: 'not found' });
    }
    if (m === 'GET' && (mm = /^\/api\/scans\/([0-9a-f-]{36})\/report$/.exec(p))) {
      // Same contract as apps/api: 404 unknown/nothing cached, 409 not completed.
      const job = jobFor(mm[1]!);
      if (!job) return json(route, 404, { error: 'not found' });
      if (job.state !== 'completed') return json(route, 409, { error: 'scan not completed' });
      return mm[1] === UNPUBLISHED_ID
        ? json(route, 200, unpublishedReport)
        : json(route, 404, { error: 'nothing cached' });
    }
    if (m === 'POST' && p === `/api/scans/${UNPUBLISHED_ID}/publish`) {
      republished = true;
      return json(route, 200, { publish: republishedJob.publish });
    }
    if (m === 'GET' && p === `/api/scans/${RUNNING_ID}/events`) {
      runningDone = true;
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: sseBody(runningProgress),
      });
    }
    if (m === 'GET' && (mm = /^\/api\/recipients\/([^/]+)$/.exec(p)))
      return json(route, 200, { flows: flowsTo(decodeURIComponent(mm[1]!)) });
    visit.unstubbed.push(`${m} ${p}`);
    return json(route, 404, { error: 'not stubbed' });
  });
  visit.page = await context.newPage();
  visit.page.on('websocket', (ws) => visit.requests.push({ url: ws.url(), type: 'websocket' }));
  return visit;
}

/**
 * Quiet window. page.waitForLoadState('networkidle') is NOT enough: it resolves
 * immediately after a same-document (hash) navigation or a click, because the
 * page's load state was reached long before — so a tracker fired from a
 * setTimeout/debounce/requestIdleCallback after an interaction would start
 * after the context is closed and never be seen. Instead we watch the
 * context's own request lifecycle and only return once NO request is in
 * flight AND none has started or ended for QUIET_MS (and at least QUIET_MS
 * has passed in total). The app does not poll fast: its intervals are the
 * live scan's clock (no request) and the header's same-origin registry check
 * every 20 s (test/styles.test.ts keeps it that way); the site page re-checks
 * a site every 20 s only while a scan of it is running (Site.tsx). Every
 * event stream the stub serves is finite, so a page does go quiet;
 * SETTLE_MAX_MS bounds one that never does (reported, not hidden).
 */
const QUIET_MS = 1500;
const SETTLE_MAX_MS = 12_000;

async function settle(v: Visit): Promise<{ ms: number; quiet: boolean }> {
  const t0 = Date.now();
  await v.page.evaluate(() => document.fonts.ready.then(() => undefined));
  for (;;) {
    const now = Date.now();
    if (v.net.inflight.size === 0 && now - v.net.lastActivity >= QUIET_MS && now - t0 >= QUIET_MS)
      return { ms: now - t0, quiet: true };
    if (now - t0 >= SETTLE_MAX_MS) {
      console.warn(
        `[no-third-party] network not quiet after ${SETTLE_MAX_MS} ms ` +
          `(${v.net.inflight.size} in flight: ${[...v.net.inflight].map((r) => r.url()).join(', ')})`,
      );
      return { ms: now - t0, quiet: false };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function isAllowed(url: string): boolean {
  if (url.startsWith('data:') || url.startsWith('blob:')) return true;
  try {
    return new URL(url).origin === ORIGIN;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- routes

const perRoute: Array<{
  route: string;
  total: number;
  settledMs: number;
  byType: Record<string, number>;
}> = [];

const V2 = `#/site/${SITE}/v/2`;

const ROUTES: Array<{
  hash: string;
  exercise: (page: Page) => Promise<void>;
}> = [
  {
    hash: '#/',
    exercise: async (page) => {
      // Recently scanned comes from GET /api/sites; search normalises a URL to its host.
      await page.getByText(SITE).first().waitFor();
      await page
        .getByLabel('Search a site or paste a URL')
        .fill('https://App.Example.org/swap?x=1');
      await page.getByRole('button', { name: 'Search' }).click();
      await page.waitForURL(`**/#/site/${SITE}`);
      await page.getByText(summaryV3.headline).first().waitFor();
    },
  },
  {
    hash: `#/site/${SITE}`,
    exercise: async (page) => {
      // Latest version (v3) with its history rail: every version, newest first.
      await page.getByText(summaryV3.headline).first().waitFor();
      const rail = page.getByRole('navigation', { name: 'Version history' });
      await expect.poll(() => rail.locator('a.rail-item').count()).toBe(3);
      expect(await rail.locator('a.rail-item b.mono').allTextContents()).toEqual([
        'v3',
        'v2',
        'v1',
      ]);
      expect(await page.locator('nav.rail').textContent()).not.toMatch(
        /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/,
      );
      // Open v1 from the rail (migrated: not recorded).
      await rail.getByText('v1', { exact: true }).click();
      await page.waitForURL(`**/#/site/${SITE}/v/1`);
      await page.getByText('Not recorded').first().waitFor();
      // Retest → POST → the live scan → the new version.
      await page.getByRole('button', { name: 'Retest' }).click();
      await page.waitForURL(`**/#/scan/${RUNNING_ID}`);
      await page.waitForURL(`**/#/site/${SITE}/v/2`, { timeout: 15_000 });
      await page.getByText(summaryV2.headline).first().waitFor();
    },
  },
  {
    hash: `#/site/${NEW_HOST}`,
    exercise: async (page) => {
      await page.getByText('Not scanned yet').waitFor();
      await page.getByRole('button', { name: 'Scan this site' }).click();
      await page.waitForURL(`**/#/scan/${FAILED_ID}`);
      await page.getByText('What happened').waitFor();
    },
  },
  {
    hash: V2,
    exercise: async (page) => {
      await page.getByText(summaryV2.headline).first().waitFor();
      await page.getByText('Published on Arkiv').first().waitFor();
      // Timeline rows are focusable and show their details.
      await page.locator('button.tl-row').first().focus();
      await page.locator('.tl-detail .kv').waitFor();
      // Wallet-request markers are focusable buttons on the same timeline.
      await expect.poll(() => page.locator('button.tl-wr').count()).toBe(4);
      await page.locator('button.tl-wr').nth(1).focus();
      await page.locator('.tl-detail').getByText(KIND_LABEL.siwe).waitFor();
      // A marker with a risk finding says so, and the hidden table lists the findings.
      expect(await page.locator('button.tl-wr').nth(2).getAttribute('aria-label')).toMatch(
        /Permit2.*; risk finding: Asked for an unlimited token permit to 0x3fC9…7FAD\.$/,
      );
      const wrTable = page.locator('table.sr-only', {
        hasText: 'Wallet requests during the visit',
      });
      expect(await wrTable.locator('thead th').allTextContents()).toContain('Findings');
      expect(await wrTable.locator('tbody tr').nth(2).locator('td').last().textContent()).toMatch(
        /^risk finding: Asked for an unlimited token permit to 0x3fC9…7FAD$/,
      );
      expect(await wrTable.locator('tbody tr').nth(0).locator('td').last().textContent()).toBe(
        'none',
      );
      // What the site asked the wallet: one card per request, backend flags, evidence.
      const wr = page.locator('#wallet-requests');
      await wr.scrollIntoViewIfNeeded();
      await expect.poll(() => wr.locator('.wr-card').count()).toBe(4);
      await wr.getByText('Sign-in message is for evil.example, not the page that asked').waitFor();
      await wr
        .locator('.wr-card', { hasText: KIND_LABEL.permit2 })
        .getByText('unlimited', { exact: true })
        .waitFor();
      await wr.getByText('Names Polygon (137), not the chain the wallet was on').first().waitFor();
      await wr.getByText('Rejected by the throwaway wallet').waitFor();
      expect(await wr.locator('a.evidence-link').nth(1).getAttribute('href')).toBe(
        `#/site/${SITE}/v/2/evidence/${walletEvidenceId}`,
      );
      // Wallet-request risks use the neutral emphasis, never the signal red.
      const reds = await wr.locator('.wr-flag, .wr-card.risk, .wr-emph').evaluateAll((els) =>
        els
          .map((e) => getComputedStyle(e))
          .map((c) => `${c.color} ${c.borderColor} ${c.boxShadow} ${c.backgroundColor}`)
          .filter((x) => /239, 75, 75|255, 138, 138|255, 179, 179/.test(x)),
      );
      expect(reds).toEqual([]);
      // Cross-site flows load lazily as the recipients scroll into view.
      await page.locator('#recipients').scrollIntoViewIfNeeded();
      await page
        .getByText(/Also on 2 other scanned sites/)
        .first()
        .waitFor();
      // Findings expand; the in-browser integrity check passes.
      const head = page.locator('button.finding-head[aria-expanded="false"]').first();
      await head.click();
      await page.getByText('Report hashes to the published scanId').waitFor();
      await expect.poll(() => page.locator('#integrity .check.bad').count()).toBe(0);
      // report.json download goes through a blob: URL, never the network.
      const [dl] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'report.json' }).click(),
      ]);
      expect(dl.suggestedFilename()).toMatch(/report\.json$/);
    },
  },
  {
    hash: `#/site/${SITE}/v/1`,
    exercise: async (page) => {
      // Migrated report: no timeline, no RPC inventory, no wallet requests — said plainly.
      await page.getByText('Not recorded').first().waitFor();
      await expect.poll(() => page.locator('.not-recorded').count()).toBeGreaterThanOrEqual(4);
      await page
        .locator('#wallet-requests .not-recorded')
        .getByText('does not record what the site asked the wallet', { exact: false })
        .waitFor();
      await page.getByText('first published version').first().waitFor();
    },
  },
  {
    hash: `${V2}/evidence`,
    exercise: async (page) => {
      await page.locator('button.evidence-item').first().waitFor();
      await page.locator('button.chip.filter').nth(1).click();
      await page.locator('button.evidence-item').first().click();
      await page.getByText(/matches its id/).waitFor();
    },
  },
  {
    hash: `${V2}/evidence/${citedEvidenceId}`,
    exercise: async (page) => {
      await page.getByText(citedEvidenceId).first().waitFor();
      await page.getByText(/matches its id/).waitFor();
      await page.getByLabel('Search evidence').fill('segment');
    },
  },
  {
    hash: `${V2}/evidence/${walletEvidenceId}`,
    exercise: async (page) => {
      await page.getByText(walletEvidenceId).first().waitFor();
      await page.getByText(/matches its id/).waitFor();
      await page.locator('.kv').getByText(KIND_LABEL.siwe, { exact: false }).first().waitFor();
      await page.getByText('evil.example', { exact: true }).waitFor();
    },
  },
  {
    hash: `#/scan/${RUNNING_ID}`,
    exercise: async (page) => {
      // SSE replay renders in the scanner log; `done` (published) opens the version.
      await expect.poll(() => page.locator('.log-line').count()).toBe(runningProgress.length);
      await page.getByText(/Published on Arkiv · v2 · tx/).waitFor();
      // Elapsed = the re-fetched job's finishedAt − startedAt (both server clock): 15.0 s.
      await page.locator('.live-clock .num').getByText('15.0 s').waitFor();
      await page.waitForURL(`**${V2}`, { timeout: 15_000 });
      await page.getByText(summaryV2.headline).first().waitFor();
    },
  },
  {
    hash: `#/scan/${FAILED_ID}`,
    exercise: async (page) => {
      await page.getByText('Scan failed').waitFor();
      await page.getByText(failedJob.error!).waitFor();
      await page.getByRole('button', { name: 'Retry scan' }).waitFor();
    },
  },
  {
    hash: `#/scan/${UNPUBLISHED_ID}`,
    exercise: async (page) => {
      await page.getByText(`Not published: ${PUBLISH_ERROR}`).waitFor();
      const view = page.getByRole('link', { name: 'View report (not published yet)' });
      expect(await view.getAttribute('href')).toBe(`#/scan/${UNPUBLISHED_ID}/report`);
      await page.getByRole('button', { name: 'Retry publish' }).click();
      await page.waitForURL(`**${V2}`, { timeout: 15_000 });
      await page.getByText(summaryV2.headline).first().waitFor();
    },
  },
  {
    hash: `#/scan/${UNPUBLISHED_ID}/report`,
    exercise: async (page) => {
      // The cached report of a completed scan whose publish failed: same view, clear banner.
      await page.getByText('Not published on Arkiv yet', { exact: true }).waitFor();
      await page.getByText(summaryV2.headline).first().waitFor();
      await page
        .getByText('Not published on Arkiv yet · served from this server’s cache')
        .waitFor();
      await page
        .getByText('Evidence bundle hashes to the reported sha256', { exact: false })
        .waitFor();
      await expect.poll(() => page.locator('#integrity .check.bad').count()).toBe(0);
      // Evidence links stay inside the unpublished scan.
      const ev = page.locator('a.evidence-link').first();
      expect(await ev.getAttribute('href')).toMatch(
        new RegExp(`^#/scan/${UNPUBLISHED_ID}/report/evidence/ev_[0-9a-f]{24}$`),
      );
      // Retry publish → the published version.
      await page.getByRole('button', { name: 'Retry publish' }).click();
      await page.waitForURL(`**${V2}`, { timeout: 15_000 });
      await page.getByText(summaryV2.headline).first().waitFor();
    },
  },
  {
    hash: `#/scan/${UNPUBLISHED_ID}/report/evidence/${citedEvidenceId}`,
    exercise: async (page) => {
      await page.getByText(citedEvidenceId).first().waitFor();
      await page.getByText(/matches its id/).waitFor();
      await page.getByText('not published yet · served from this server’s cache').waitFor();
      await page.getByRole('link', { name: 'unpublished scan' }).waitFor();
    },
  },
  {
    hash: `#/site/${OTHER_HOST}`,
    exercise: async (page) => {
      // Published on Arkiv but served from the API's cache, with a problem: both said.
      await page.getByText('Published on Arkiv · served from this server’s cache').waitFor();
      await page
        .locator('.proof-meta')
        .getByText(/verified · 1 problem$/)
        .waitFor();
      expect(await page.locator('.proof-meta').textContent()).not.toContain('✓');
      await page.locator('.proof-problems').getByText(CACHE_PROBLEM).waitFor();
      await page
        .getByRole('navigation', { name: 'Version history' })
        .getByText('first version')
        .waitFor();
      // Wallet requests were recorded, and there were none.
      await page.locator('#wallet-requests').getByText(EMPTY_TEXT).waitFor();
    },
  },
  {
    hash: '#/no-such-page',
    exercise: async (page) => {
      await page.getByText('Nothing here.').waitFor();
    },
  },
];

describe('web app makes no third-party requests', () => {
  for (const { hash, exercise } of ROUTES) {
    it(`${hash} — every request is same-origin`, async () => {
      const v = await open();
      try {
        await v.page.goto(`${ORIGIN}/${hash}`);
        await exercise(v.page);
        const settled = await settle(v);
        expect(settled.quiet, `${hash} network never went quiet`).toBe(true);

        const offenders = v.requests.filter((r) => !isAllowed(r.url));
        if (offenders.length)
          console.error(
            `[no-third-party] ${hash} made ${offenders.length} third-party request(s):\n` +
              offenders.map((r) => `  ${r.type} ${r.url}`).join('\n'),
          );
        expect(offenders.map((r) => r.url)).toEqual([]);
        expect(v.unstubbed).toEqual([]);

        // Non-vacuous: the page really loaded its code, styles, fonts and data.
        const types = new Set(v.requests.map((r) => r.type));
        for (const t of ['document', 'script', 'stylesheet', 'font', 'fetch'])
          expect(types, `${hash} should request a ${t}`).toContain(t);
        if (hash === `#/scan/${RUNNING_ID}` || hash === `#/site/${SITE}`)
          expect(types).toContain('eventsource');

        const byType: Record<string, number> = {};
        for (const r of v.requests) byType[r.type] = (byType[r.type] ?? 0) + 1;
        perRoute.push({
          route: hash,
          total: v.requests.length,
          settledMs: settled.ms,
          byType,
        });
      } finally {
        await v.context.close();
      }
    });
  }

  it('negative control: injected tracker requests, immediate AND delayed, ARE recorded (never sent)', async () => {
    // The build's CSP would block these in the page before any request
    // exists (asserted below); bypassed here so the recorder itself is tested.
    const v = await open(undefined, { bypassCSP: true });
    const thirdParty = () =>
      v.requests
        .filter((r) => !isAllowed(r.url))
        .map((r) => r.url)
        .sort();
    try {
      await v.page.goto(`${ORIGIN}/#/`);
      await v.page.getByText(SITE).first().waitFor();
      await v.page.evaluate(() => {
        // Immediate beacons.
        new Image().src = 'https://tracker.invalid/pixel.gif?e=connect';
        void fetch('https://analytics.invalid/collect', { method: 'POST', mode: 'no-cors' }).catch(
          () => undefined,
        );
        // Delayed beacons, 1200 ms after an interaction — the debounce/timer
        // pattern real analytics SDKs use, which networkidle alone misses.
        addEventListener(
          'hashchange',
          () =>
            setTimeout(() => {
              new Image().src = 'https://late-tracker.invalid/pixel.gif?e=route';
            }, 1200),
          { once: true },
        );
        addEventListener(
          'input',
          () =>
            setTimeout(() => {
              void fetch('https://late-analytics.invalid/collect?e=typed', {
                mode: 'no-cors',
              }).catch(() => undefined);
            }, 1200),
          { once: true },
        );
      });
      await v.page.getByLabel('Search a site or paste a URL').fill('app.uniswap.org');
      await v.page.locator(`a[href="#/site/${SITE}"]`).first().click();
      await v.page.getByText(summaryV3.headline).first().waitFor();

      // The old settle() — networkidle — returns before the delayed beacons start.
      await v.page.waitForLoadState('networkidle');
      expect(thirdParty().filter((u) => u.includes('late-'))).toEqual([]);

      const settled = await settle(v);
      expect(settled.quiet).toBe(true);
      expect(settled.ms).toBeGreaterThanOrEqual(QUIET_MS);
      expect(thirdParty()).toEqual([
        'https://analytics.invalid/collect',
        'https://late-analytics.invalid/collect?e=typed',
        'https://late-tracker.invalid/pixel.gif?e=route',
        'https://tracker.invalid/pixel.gif?e=connect',
      ]);
    } finally {
      await v.context.close();
    }
  });

  it("the build's CSP stops a third-party fetch in the page: no request is ever made", async () => {
    const v = await open();
    try {
      await v.page.goto(`${ORIGIN}/#/`);
      await v.page.getByText(SITE).first().waitFor();
      const csp = await v.page
        .locator('meta[http-equiv="Content-Security-Policy"]')
        .getAttribute('content');
      expect(csp).toContain("connect-src 'self'");
      await v.page.evaluate(() =>
        fetch('https://analytics.invalid/collect', { mode: 'no-cors' }).catch(() => undefined),
      );
      await settle(v);
      expect(v.requests.map((r) => r.url).filter((u) => !isAllowed(u))).toEqual([]);
    } finally {
      await v.context.close();
    }
  });
});

// ---------------------------------------------------------------- 360 px

/** At phone width nothing may widen the page (charts and tables scroll in their own frames). */
describe('360 px layout: no horizontal page scroll', () => {
  const PAGES: Array<{ hash: string; ready: (page: Page) => Promise<void> }> = [
    {
      hash: V2,
      ready: async (page) => {
        await page.locator('#wallet-requests .wr-card').first().waitFor();
        await page.locator('button.tl-wr').first().waitFor();
      },
    },
    {
      hash: `#/site/${SITE}`,
      ready: async (page) => {
        await page.getByRole('navigation', { name: 'Version history' }).waitFor();
        await page.locator('#wallet-requests .wr-card').first().waitFor();
      },
    },
    {
      hash: `#/site/${OTHER_HOST}`,
      ready: async (page) => {
        await page.locator('#wallet-requests').getByText(EMPTY_TEXT).waitFor();
      },
    },
    {
      hash: `#/site/${SITE}/v/1`,
      ready: async (page) => {
        await page.locator('#wallet-requests .not-recorded').waitFor();
      },
    },
  ];
  for (const { hash, ready } of PAGES)
    it(`${hash} fits 360 px`, async () => {
      const v = await open({ width: 360, height: 780 });
      try {
        await v.page.goto(`${ORIGIN}/${hash}`);
        await ready(v.page);
        const { scroll, inner } = await v.page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          inner: window.innerWidth,
        }));
        expect(scroll, `${hash} is ${scroll}px wide at ${inner}px`).toBeLessThanOrEqual(inner);
        expect(v.requests.filter((r) => !isAllowed(r.url))).toEqual([]);
        expect(v.unstubbed).toEqual([]);
      } finally {
        await v.context.close();
      }
    });
});

// ---------------------------------------------------------------- static

/**
 * Static rule. We only flag URLs a browser would FETCH from another origin:
 *  - HTML: src/href/srcset/poster/data/action attributes of resource-loading
 *    tags (script, link, img, iframe, source, video, audio, embed, object,
 *    track, form) and meta refresh — absolute (http/https/ws) or
 *    protocol-relative (//host) values. <a href> is navigation, not a fetch.
 *  - CSS: @import (string or url()) and every url(...) whose value starts
 *    with a scheme or //. Inline data: URLs are fine even when their payload
 *    contains text like xmlns='http://www.w3.org/2000/svg' — the url() value
 *    itself starts with "data:", so it never reaches the network.
 *  - JS: minified bundles have no reliable syntax for "this string is
 *    fetched", so EVERY absolute http(s)/ws(s) URL literal is treated as
 *    fetch-able, and so are the two ways to spell one without a literal
 *    "scheme://host": a protocol-relative string literal that names a host
 *    ("//www.googletagmanager.com/gtm.js") and a bare scheme literal
 *    concatenated with a host literal ("https://"+"api.segment.io", or
 *    "https://"+k+".ingest.sentry.io"). Only these non-dereferenced kinds are
 *    allowed (see jsOffenders for the exact rule behind each):
 *      * W3C XML namespace URIs (preact's createElementNS namespaces) —
 *        identifiers by spec, never requested;
 *      * JSON-Schema `$id` / `$schema` values (core's contract schemas, used
 *        by ajv as identifiers; no remote $ref loading is configured);
 *      * a scheme whose WHOLE host is runtime data (`https://${h}`,
 *        `https://${h}/path`, `https://${h}:${port}`, or a bare "https://"
 *        not glued to a host literal): the host is the user's scan target
 *        (normaliseUrl(), POSTed to our own API as JSON) — covered by the
 *        runtime test above. Any literal host text after the interpolation
 *        (`https://${k}.ingest.sentry.io`) pins a third party and is flagged;
 *      * the reviewed list in JS_REVIEWED below, each with a reason.
 *    Anything new fails the test until someone reviews it, which is the safe
 *    direction for a "no third-party requests" guarantee.
 */
const XML_NAMESPACES = new Set([
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/1998/Math/MathML',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/XML/1998/namespace',
  'http://www.w3.org/2000/xmlns/',
]);
const JS_REVIEWED: Record<string, string> = {
  // viem's BaseError.getDocsUrl(): composes a docs link into error MESSAGE text.
  'https://viem.sh': 'viem error-message docs base URL (string only, never fetched)',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const ABS = /^(?:(?:https?|wss?):)?\/\//i;

function htmlOffenders(html: string): string[] {
  const out: string[] = [];
  const tag =
    /<(script|link|img|iframe|source|video|audio|embed|object|track|form|image|use)\b[^>]*>/gi;
  const attr =
    /\b(src|href|srcset|poster|data|action|xlink:href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const t of html.matchAll(tag))
    for (const a of t[0].matchAll(attr)) {
      const val = (a[3] ?? a[4] ?? a[5] ?? '').trim();
      const urls = a[1]!.toLowerCase() === 'srcset' ? val.split(',').map((s) => s.trim()) : [val];
      for (const u of urls) if (ABS.test(u)) out.push(`<${t[1]} ${a[1]}=${u}>`);
    }
  for (const m of html.matchAll(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi))
    if (/url\s*=\s*(?:(?:https?:)?\/\/)/i.test(m[0])) out.push(m[0]);
  // Inline <style> blocks are CSS.
  for (const s of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
    out.push(...cssOffenders(s[1]!));
  return out;
}

function cssOffenders(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi))
    if (ABS.test(m[1]!)) out.push(`@import ${m[1]}`);
  for (const m of css.matchAll(/url\(\s*(["']?)([^"')]*)/gi))
    if (ABS.test(m[2]!.trim())) out.push(`url(${m[2]})`);
  return out;
}

/** A DNS name with at least one dot and an alphabetic TLD (`api.segment.io`). */
const HOST = String.raw`(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}`;
/**
 * Allow rule "whole host is dynamic": scheme, ONE interpolation as the entire
 * host, then an optional port (digits or another interpolation), then nothing
 * or a path/query/fragment. Literal text right after the closing brace (".x",
 * "-x", "x", another "${...}") means part of the host is fixed → not allowed.
 */
const DYNAMIC_HOST = /^(?:https?|wss?):\/\/\$\{[^{}]*\}(?::(?:\d+|\$\{[^{}]*\}))?(?:[/?#]|$)/i;
/** `"https://"` closed, then `+ "host.tld…"` — a literal host glued on. */
const CONCAT_HOST = new RegExp(String.raw`^["'\x60]\s*\+\s*["'\x60]${HOST}(?![a-z0-9-])`, 'i');
/** `"https://"` closed, then `+ expr + ".host.tld…"` — a dynamic label of a fixed host. */
const CONCAT_SUFFIX = new RegExp(
  String.raw`^["'\x60]\s*\+\s*[A-Za-z_$][\w$.]*(?:\([^()"'\x60]*\))?\s*\+\s*["'\x60][.-]?${HOST}(?![a-z0-9-])`,
  'i',
);
/** `"//host.tld…"` — protocol-relative literal (resolves against our page's scheme). */
const PROTOCOL_RELATIVE = new RegExp(
  String.raw`["'\x60]\/\/${HOST}(?::\d+)?(?=[/?#"'\x60])[^\s"'\x60\\]*`,
  'gi',
);

function jsOffenders(js: string): string[] {
  const out: string[] = [];
  for (const m of js.matchAll(/(?:https?|wss?):\/\/[^\s"'`)\\]*/gi)) {
    const url = m[0];
    const before = js.slice(Math.max(0, m.index - 12), m.index);
    const after = js.slice(m.index + url.length, m.index + url.length + 200);
    // Namespace URIs are compared, never requested (exact match only).
    if (XML_NAMESPACES.has(url)) continue;
    // `$id`/`$schema` keys of JSON-Schema objects: ajv identifiers, not fetched.
    if (/\$(?:id|schema)["']?\s*:\s*["'`]$/.test(before)) continue;
    // Bare scheme ("https://" then the string ends): allowed unless a host
    // literal is concatenated onto it, directly or after one dynamic label.
    if (/^(?:https?|wss?):\/\/$/i.test(url)) {
      if (CONCAT_HOST.test(after) || CONCAT_SUFFIX.test(after))
        out.push(`${url} + ${after.slice(0, 60)}`);
      continue;
    }
    // Template literal whose entire host is one interpolation.
    if (DYNAMIC_HOST.test(url)) continue;
    // Reviewed one-offs (exact URL).
    if (url in JS_REVIEWED) continue;
    out.push(url);
  }
  for (const m of js.matchAll(PROTOCOL_RELATIVE)) out.push(m[0].slice(1));
  return out;
}

describe('built assets reference no third-party resources', () => {
  it('dist/index.html, JS and CSS contain no fetchable external URLs; fonts are self-hosted', () => {
    const files = walk(DIST);
    const offenders: string[] = [];
    let checked = 0;
    for (const f of files) {
      const rel = relative(DIST, f);
      const ext = extname(f);
      if (!['.html', '.js', '.mjs', '.css'].includes(ext)) continue;
      checked += 1;
      const text = readFileSync(f, 'utf8');
      const found =
        ext === '.html'
          ? htmlOffenders(text)
          : ext === '.css'
            ? cssOffenders(text)
            : jsOffenders(text);
      offenders.push(...found.map((x) => `${rel}: ${x}`));
    }
    if (offenders.length)
      console.error(`[no-third-party] external URLs in dist:\n  ${offenders.join('\n  ')}`);
    expect(offenders).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(3); // index.html + ≥1 JS + ≥1 CSS

    // Fonts ship inside dist and the CSS points at them by relative/root path.
    const fonts = files.filter((f) => /\.(woff2?|ttf|otf)$/.test(f));
    expect(fonts.length).toBeGreaterThan(0);
    const css = files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(f, 'utf8'));
    const fontFaces = css.flatMap((c) => [...c.matchAll(/@font-face\s*{[^}]*}/g)].map((m) => m[0]));
    expect(fontFaces.length).toBeGreaterThan(0);
    for (const ff of fontFaces) expect(ff).not.toMatch(/url\(\s*["']?(?:https?:)?\/\//i);
    console.log(
      `[no-third-party] static: ${checked} html/js/css files, ${fonts.length} self-hosted font files, ${fontFaces.length} @font-face rules`,
    );
  });

  it('the static rules catch what they claim to (self-test)', () => {
    expect(htmlOffenders('<script src="https://cdn.example.com/a.js"></script>')).toHaveLength(1);
    expect(htmlOffenders('<link rel="stylesheet" href="//fonts.googleapis.com/css">')).toHaveLength(
      1,
    );
    expect(
      htmlOffenders('<script src="/assets/index.js"></script><a href="https://x.org">'),
    ).toEqual([]);
    expect(cssOffenders('@import "https://fonts.googleapis.com/css2?family=X";')).toHaveLength(1);
    expect(cssOffenders('src: url(https://fonts.gstatic.com/a.woff2)')).toHaveLength(1);
    expect(
      cssOffenders(
        `background:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>")`,
      ),
    ).toEqual([]);
    expect(jsOffenders('fetch("https://api.segment.io/v1/t")')).toEqual([
      'https://api.segment.io/v1/t',
    ]);
    expect(
      jsOffenders(
        'o=`http://www.w3.org/2000/svg`;Q={$schema:`https://json-schema.org/draft/2020-12/schema`};t?t:`https://${t}`',
      ),
    ).toEqual([]);
  });

  it('JS rule: dynamic-host, protocol-relative and concatenated URLs (self-test)', () => {
    // Must flag: a third-party host is fixed somewhere in the literal(s).
    const mustFlag = [
      'fetch(`https://${k}.ingest.sentry.io/api/1/envelope/`)',
      'fetch(`https://${k}-ingest.example.com/e`)',
      'x=`https://${a}${".sentry.io"}`',
      'x=`https://${a}x.io`',
      's.src="//www.googletagmanager.com/gtm.js?id="+i',
      "s.src='//cdn.segment.com/analytics.js'",
      's.src=`//static.hotjar.com:443/c/hotjar.js`',
      'u="https://"+"api.segment.io"',
      "u='http://' + 'api.segment.io/v1'",
      'u=`wss://`+`relay.example.com`',
      'u="https://"+k+".ingest.sentry.io"',
      'u="https://"+cfg.key+".ingest.sentry.io/api"',
      'u="https://"+id()+"-dsn.example.com"',
      'x="http://"+"www.w3.org/2000/svg"',
      'x=`https://json-schema.org/x`',
    ];
    for (const js of mustFlag) expect(jsOffenders(js), js).toHaveLength(1);
    // Must allow: identifiers, or a host that is entirely runtime data.
    const mustAllow = [
      'o=`http://www.w3.org/2000/svg`',
      'n="http://www.w3.org/1999/xlink"',
      'Q={$schema:`https://json-schema.org/draft/2020-12/schema`}',
      'Q={"$id":"https://igris.dev/schemas/report.json"}',
      't?t:`https://${t}`',
      'u=`https://${h}/api/v1?x=1`',
      'u=`wss://${h}:${p}/ws`',
      'u=`http://${h}:8545`',
      'u=`https://${h}#frag`',
      'u="https://"+h',
      'u="https://"+h+"/path"',
      'u="https://"+h+":"+p',
      '/^https?:\/\//.test(s)?s:"https://"+s',
      'r=/^\/\//;c="//"+location.host',
      '// a.b.example.com comment',
      'm=`${b}/docs${p}`;b="https://viem.sh"',
      's="a//b.c"',
    ];
    for (const js of mustAllow) expect(jsOffenders(js), js).toEqual([]);
  });
});
