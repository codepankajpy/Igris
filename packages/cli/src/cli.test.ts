import { describe, expect, it } from 'vitest';
import { renderTable } from './table.js';
import { runScan } from './commands/scan.js';
import { renderHtmlReport } from './html-report.js';
import { EXIT } from './exit-codes.js';
import type { Report } from '@igris/core';

describe('renderTable', () => {
  it('aligns columns', () => {
    const t = renderTable(
      ['a', 'long header'],
      [
        ['x', 'y'],
        ['longer', 'z'],
      ],
    );
    const lines = t.split('\n');
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
    expect(lines[0]).toContain('long header');
  });
});

describe('scan arg validation (no browser launched)', () => {
  it('rejects a missing URL with exit 3', async () => {
    expect((await runScan([])).exitCode).toBe(EXIT.INVALID_ARGS);
  });
  it('rejects a non-http URL with exit 3', async () => {
    expect((await runScan(['ftp://nope'])).exitCode).toBe(EXIT.INVALID_ARGS);
  });
  it('rejects a non-numeric --fail-under with exit 3', async () => {
    expect((await runScan(['http://x.test', '--fail-under', 'high'])).exitCode).toBe(
      EXIT.INVALID_ARGS,
    );
  });
  it('rejects unknown flags with exit 3', async () => {
    expect((await runScan(['http://x.test', '--bogus'])).exitCode).toBe(EXIT.INVALID_ARGS);
  });
  it('rejects a missing recipe file with exit 3', async () => {
    expect((await runScan(['http://x.test', '--recipe', '/nope.json'])).exitCode).toBe(
      EXIT.INVALID_ARGS,
    );
  });
});

describe('renderHtmlReport', () => {
  const report: Report = {
    reportVersion: '1.0.0',
    scannerVersion: '0.1.0',
    target: 'http://example.test/',
    hostname: 'example.test',
    scannedAt: '2026-11-06T00:00:00.000Z',
    chainId: 1,
    status: 'completed',
    canaryAddress: '0x8ba1f109551bd432803012645ac136ddd64dba72',
    spoofMetaMask: true,
    findings: [
      {
        id: 'f1',
        category: 'exact',
        encoding: 'lowercase',
        location: 'request-body',
        url: 'http://a.test/x?q=<CANARY>&"quote"',
        method: 'POST',
        host: 'a.test',
        registrableDomain: 'a.test',
        class: 'analytics',
        phase: 'post-connect',
        snippet: '<CANARY> & <script>alert(1)</script>',
        countsTowardScore: true,
      },
    ],
    thirdParties: [
      {
        host: 'a.test',
        registrableDomain: 'a.test',
        class: 'analytics',
        phases: ['post-connect'],
        requestCount: 3,
      },
    ],
    readsViaWallet: [{ method: 'eth_getBalance', count: 2 }],
    usesAnonRpc: false,
    score: 75,
    ledger: [
      {
        id: 'p1',
        label: 'address reached a.test (analytics)',
        points: 25,
        rule: 'leak.analytics',
        findingIds: ['f1'],
      },
    ],
    errors: [],
  };

  it('is self-contained: no external URLs referenced', () => {
    const html = renderHtmlReport(report);
    expect(html).not.toMatch(/src\s*=\s*"http/);
    expect(html).not.toMatch(/href\s*=\s*"http/);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/url\(/);
  });

  it('escapes HTML in snippets', () => {
    const html = renderHtmlReport(report);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert');
  });

  it('shows the score and ledger', () => {
    const html = renderHtmlReport(report);
    expect(html).toContain('75');
    expect(html).toContain('leak.analytics');
  });
});
