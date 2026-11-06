/**
 * Offline browser tests of the connect-UI open step (strict candidate
 * selection, shadow DOM, navigation guard, condition-based modal wait).
 * The "modal" here is a test double carrying a kit's modal marker; real kit
 * DOM is covered by snapshot fixtures (P1 workstream 2).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type Server } from 'node:http';
import { openConnectUi } from '../src/index.js';
import { HOST_RULES, PAGE_PORT } from './helpers.js';

const PORT = PAGE_PORT + 40;
const BASE = `http://open.test:${PORT}`;
const OTHER = `http://elsewhere.test:${PORT}`;

const MODAL = `document.body.insertAdjacentHTML('beforeend', '<div id="privy-modal-content" style="width:300px;height:200px">Continue with a wallet</div>')`;
const PAGES: Record<string, string> = {
  // The real misclick bait from family.co / demo.privy.io, plus the real
  // connect control inside an open shadow root.
  shadow: `<a href="/connectkit">ConnectKit Connecting a wallet, made simple.</a>
    <button>Get started now</button>
    <x-connect></x-connect>
    <script>
      customElements.define('x-connect', class extends HTMLElement {
        constructor() { super(); const r = this.attachShadow({ mode: 'open' });
          r.innerHTML = '<button id="b">Connect Wallet</button>';
          r.getElementById('b').addEventListener('click', () => setTimeout(() => { ${MODAL} }, 300)); }
      });
    </script>`,
  navonly: `<a href="${OTHER}/">Connect wallet</a>`,
  navigates: `<button onclick="location.href='${OTHER}/'">Connect Wallet</button>`,
  nomodal: `<button>Connect Wallet</button>`,
  late: `<button onclick="setTimeout(() => { ${MODAL.replaceAll('"', '&quot;')} }, 2500)">Connect Wallet</button>`,
  // app.ens.domains: a Material Symbols ligature ("login") inside the button
  // is an icon, not part of its name; same for an icon font named by style
  // and for aria-hidden decorations. <i> without an icon class stays text.
  icons: `<button onclick="${MODAL.replaceAll('"', '&quot;')}">Connect <span class="material-symbol">login</span></button>
    <button>Connect wallet <span style="font-family:'Material Symbols Outlined'">account_balance_wallet</span></button>
    <button><span aria-hidden="true">→</span> Log in</button>
    <button>Connect <i>now</i></button>`,
  hidden: `<button style="display:none">Connect Wallet</button><button onclick="${MODAL.replaceAll('"', '&quot;')}">Log in</button>`,
};

let server: Server;
let browser: Browser;

beforeAll(async () => {
  server = createServer((req, res) => {
    const v = new URL(req.url ?? '/', BASE).searchParams.get('v') ?? '';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>${v}</title><body>${PAGES[v] ?? 'elsewhere'}</body>`);
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));
  browser = await chromium.launch({ args: [`--host-resolver-rules=${HOST_RULES}`] });
});
afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server.close(() => r(undefined)));
});

async function open(
  v: string,
  modalTimeoutMs = 4000,
): Promise<{ page: Page; r: Awaited<ReturnType<typeof openConnectUi>> }> {
  const page = await browser.newPage();
  await page.goto(`${BASE}/?v=${v}`);
  const r = await openConnectUi(page, { modalTimeoutMs });
  return { page, r };
}

describe('openConnectUi (offline)', () => {
  it('ignores bait (nav link, "Get started now") and clicks the real control inside shadow DOM', async () => {
    const { page, r } = await open('shadow');
    expect(r.outcome).toBe('modal-opened');
    expect(r.clicked?.name).toBe('Connect Wallet');
    expect(r.candidates.map((c) => c.name)).toEqual(['Connect Wallet']);
    expect(r.fingerprint).toMatchObject({ id: 'privy', confidence: 'high' });
    expect(r.urlChanges).toEqual([]);
    await page.close();
  });

  it('names controls without their icon text (Material Symbols, icon fonts, aria-hidden)', async () => {
    const { page, r } = await open('icons');
    expect(r.candidates.map((c) => c.name).sort()).toEqual(['Connect', 'Connect wallet', 'Log in']);
    expect(r.clicked?.name).toBe('Connect wallet');
    await page.close();
  });

  it('a navigating link is never a candidate → no-connect-control', async () => {
    const { page, r } = await open('navonly');
    expect(r.outcome).toBe('no-connect-control');
    expect(page.url()).toBe(`${BASE}/?v=navonly`);
    await page.close();
  });

  it('a click that navigates to another origin is aborted as unexpected-navigation', async () => {
    const { page, r } = await open('navigates');
    expect(r.outcome).toBe('unexpected-navigation');
    expect(r.urlChanges[0]).toBe(`${OTHER}/`);
    await page.close();
  });

  it('no modal within the bound → modal-not-opened (bounded, with the clicked control named)', async () => {
    const t0 = Date.now();
    const { page, r } = await open('nomodal', 1200);
    expect(r.outcome).toBe('modal-not-opened');
    expect(r.detail).toMatch(/1200 ms after clicking "Connect Wallet"/);
    expect(Date.now() - t0).toBeLessThan(8000);
    await page.close();
  });

  it('waits on the condition: a modal appearing after 2.5 s is found within a 5 s bound', async () => {
    const { page, r } = await open('late', 5000);
    expect(r.outcome).toBe('modal-opened');
    await page.close();
  });

  it('hidden controls are skipped; the visible "Log in" is used', async () => {
    const { page, r } = await open('hidden');
    expect(r.clicked?.name).toBe('Log in');
    expect(r.outcome).toBe('modal-opened');
    await page.close();
  });
});
