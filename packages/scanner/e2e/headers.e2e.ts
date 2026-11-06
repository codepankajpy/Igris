/**
 * P0-1 / P0-3 end to end: security headers are read from the main document's
 * final response (through redirects), and an HTTP error page is never scored.
 * Fully offline: a local server answers for *.test via the host-resolver rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { DocumentHeadersEvidence, ScanResult } from '@igris/core';
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

function scanPath(path: string): Promise<ScanResult> {
  return scan({ url: `${BASE}${path}`, hostResolverRules: HOST_RULES, dwellMs: 200 });
}

/** The single document-headers evidence item of a result, if any. */
function docHeaders(r: ScanResult): DocumentHeadersEvidence | undefined {
  return Object.values(r.bundle.items).find(
    (i): i is DocumentHeadersEvidence => i.type === 'document-headers',
  );
}
const checks = (r: ScanResult) => r.report.security.observations.map((o) => o.title).sort();

describe('security headers (main document)', () => {
  it('positive: CSP, HSTS and XFO sent by the page are recorded as evidence; no risk raised', async () => {
    const r = await scanPath('/secure');
    expect(docHeaders(r)).toMatchObject({
      documentUrl: `${BASE}/secure`,
      status: 200,
      headers: {
        'content-security-policy': "default-src 'self'",
        'strict-transport-security': 'max-age=31536000',
        'x-frame-options': 'DENY',
      },
    });
    // Only the always-present summary observation (info).
    expect(r.report.security.observations.map((o) => o.kind)).toEqual(['observation']);
  });

  it('negative: a page without them raises CSP and framing risks', async () => {
    const r = await scanPath('/plain');
    expect(docHeaders(r)?.headers['content-security-policy']).toBeNull();
    expect(checks(r)).toEqual(
      expect.arrayContaining([
        'No Content-Security-Policy on the main document',
        'Page can be embedded by any site (clickjacking)',
      ]),
    );
    // Never scored.
    expect(r.report.security.observations.every((o) => !o.countsTowardPrivacyScore)).toBe(true);
  });

  it('redirect chain: the final document decides, not the redirect hop', async () => {
    const r = await scanPath('/redirect');
    expect(docHeaders(r)).toMatchObject({
      documentUrl: `${BASE}/secure`,
      headers: { 'content-security-policy': "default-src 'self'" },
    });
  });
});

describe('HTTP error pages are not scored', () => {
  it('a 404 main document → page-load-failed, score null, no security claims', async () => {
    const r = await scanPath('/missing');
    expect(r.report.scan.status).toBe('page-load-failed');
    expect(r.report.privacy.score).toBeNull();
    expect(r.report.privacy.coverage).toBe('none');
    expect(r.report.security.observations).toEqual([]);
    expect(r.report.scan.notes.join(' ')).toMatch(/HTTP 404/);
  });

  it('a page with no wallet flow is scored with coverage pre-connect-only', async () => {
    const r = await scanPath('/plain');
    expect(r.report.scan.status).toBe('wallet-connect-failed');
    expect(r.report.privacy.coverage).toBe('pre-connect-only');
    expect(typeof r.report.privacy.score).toBe('number');
  });
});
