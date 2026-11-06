/**
 * P0-1 / P0-3 end to end: security headers are read from the main document's
 * final response (through redirects), and an HTTP error page is never scored.
 * Fully offline: a local server answers for *.test via the host-resolver rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Report } from '@igris/core';
import { scan } from '../src/index.js';
import { HOST_RULES, PAGE_PORT } from './helpers.js';

const PORT = PAGE_PORT + 10; // own port: avoid cross-file EADDRINUSE
const BASE = `http://headers.test:${PORT}`;
const PAGE = '<!doctype html><title>t</title><p>no wallet here</p>';

let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    switch (req.url) {
      case '/secure':
        res.writeHead(200, {
          'content-type': 'text/html',
          'content-security-policy': "default-src 'self'",
          'strict-transport-security': 'max-age=31536000',
          'x-frame-options': 'DENY',
        });
        return res.end(PAGE);
      case '/plain':
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(PAGE);
      case '/redirect':
        // The redirect hop deliberately carries NO security headers: only the
        // final document's headers may count.
        res.writeHead(302, { location: '/secure' });
        return res.end();
      default:
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<!doctype html><title>404</title>');
    }
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));
});

afterAll(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
});

function scanPath(path: string): Promise<Report> {
  return scan({ url: `${BASE}${path}`, hostResolverRules: HOST_RULES, dwellMs: 200 });
}

describe('security headers (main document)', () => {
  it('positive: CSP, HSTS and XFO sent by the page are detected', async () => {
    const r = await scanPath('/secure');
    expect(r.securityHeaders).toMatchObject({
      documentUrl: `${BASE}/secure`,
      documentStatus: 200,
      cspPresent: true,
      hstsPresent: true,
      xFrameOptions: 'DENY',
    });
  });

  it('negative: a page without them is reported as missing', async () => {
    const r = await scanPath('/plain');
    expect(r.securityHeaders).toMatchObject({ cspPresent: false, hstsPresent: false });
  });

  it('redirect chain: the final document decides, not the redirect hop', async () => {
    const r = await scanPath('/redirect');
    expect(r.securityHeaders).toMatchObject({
      documentUrl: `${BASE}/secure`,
      cspPresent: true,
      hstsPresent: true,
    });
  });
});

describe('HTTP error pages are not scored', () => {
  it('a 404 main document → page-load-failed, score null, no headers claimed', async () => {
    const r = await scanPath('/missing');
    expect(r.status).toBe('page-load-failed');
    expect(r.score).toBeNull();
    expect(r.coverage).toBe('none');
    expect(r.errors.join(' ')).toMatch(/HTTP 404/);
  });

  it('a page with no wallet flow is scored with coverage pre-connect-only', async () => {
    const r = await scanPath('/plain');
    expect(r.status).toBe('wallet-connect-failed');
    expect(r.coverage).toBe('pre-connect-only');
    expect(typeof r.score).toBe('number');
  });
});
