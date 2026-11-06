import { describe, expect, it } from 'vitest';
import { renderTable } from './table.js';
import { runScan } from './commands/scan.js';
import { coverageNote, renderHtmlReport, scoreLabel } from './html-report.js';
import { EXIT } from './exit-codes.js';
import { ArtifactError, loadScanArtifacts, writeScanArtifacts } from './artifacts.js';
import { runVerify } from './commands/verify.js';
import { runScanner } from './commands/scanner.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANARY_A, req, sampleCapture, sampleResult } from '@igris/core/testing';

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

describe('renderHtmlReport (v2)', () => {
  const xssCapture = () => {
    const cap = sampleCapture();
    cap.requests.push(
      req({
        phase: 'post-connect',
        url: 'https://api.segment.io/v1/x',
        method: 'POST',
        body: `{"user":"${CANARY_A}","note":"<script>alert(1)</script>"}`,
      }),
    );
    return cap;
  };

  it('is self-contained: no external URLs referenced', () => {
    const { report, bundle } = sampleResult();
    const html = renderHtmlReport(report, bundle);
    expect(html).not.toMatch(/src\s*=\s*"http/);
    expect(html).not.toMatch(/href\s*=\s*"http/);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/url\(/);
  });

  it('escapes page-controlled text from evidence snippets', () => {
    const { report, bundle } = sampleResult({ capture: xssCapture() });
    const html = renderHtmlReport(report, bundle);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert');
  });

  it('shows score, ledger, evidence snippets and the evidence hash', () => {
    const { report, bundle } = sampleResult();
    const html = renderHtmlReport(report, bundle);
    expect(html).toContain(`>${report.privacy.score}<`);
    expect(html).toContain('leak.analytics');
    expect(html).toContain('&lt;CANARY&gt;');
    expect(html).toContain(report.evidence.sha256);
  });

  it('keeps security observations in their own, unscored section', () => {
    const { report, bundle } = sampleResult();
    const html = renderHtmlReport(report, bundle);
    const sec = html.slice(html.indexOf('<h2>Security observations'));
    expect(sec).toContain('No Content-Security-Policy');
    expect(html.slice(0, html.indexOf('<h2>Security observations'))).not.toContain(
      'No Content-Security-Policy',
    );
    expect(sec).toContain('never affect the privacy score');
  });
});

describe('coverage and unscored reports render truthfully (P0-1, P0-2)', () => {
  it('full coverage: plain score, no note', () => {
    const { report, bundle } = sampleResult();
    expect(scoreLabel(report)).toBe(`${report.privacy.score}/100`);
    expect(coverageNote(report)).toBeNull();
    expect(renderHtmlReport(report, bundle)).not.toContain('PARTIAL');
  });
  it('wallet never connected: pre-connect only, PARTIAL note', () => {
    const { report, bundle } = sampleResult({ status: 'wallet-connect-failed' });
    expect(scoreLabel(report)).toMatch(/\(pre-connect only\)$/);
    expect(renderHtmlReport(report, bundle)).toContain(
      'post-connect address leaks were NOT tested',
    );
  });
  it('page never loaded: "not scored", no number shown as a score', () => {
    const { report, bundle } = sampleResult({ status: 'page-load-failed' });
    expect(scoreLabel(report)).toBe('not scored');
    const html = renderHtmlReport(report, bundle);
    expect(html).toContain('NOT SCORED');
    expect(html).toContain('>not scored<');
  });
});

describe('scan artifacts (report.json + canonical evidence.json)', () => {
  it('evidence.json is the exact canonical bytes: its sha256 equals report.evidence.sha256', () => {
    const dir = mkdtempSync(join(tmpdir(), 'igris-art-'));
    const result = sampleResult();
    const paths = writeScanArtifacts(dir, result);
    const sha = createHash('sha256').update(readFileSync(paths.evidence)).digest('hex');
    expect(sha).toBe(result.report.evidence.sha256);
    const loaded = loadScanArtifacts(paths.report);
    expect(loaded.report).toEqual(result.report);
    expect(loaded.bundle).toEqual(result.bundle);
  });

  it('a tampered evidence file is rejected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'igris-art-'));
    const paths = writeScanArtifacts(dir, sampleResult());
    writeFileSync(
      paths.evidence,
      readFileSync(paths.evidence, 'utf8').replace('segment.io', 'segment.xx'),
    );
    expect(() => loadScanArtifacts(paths.report)).toThrow(ArtifactError);
  });

  it('a missing evidence file is an error, not a silent pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'igris-art-'));
    const paths = writeScanArtifacts(dir, sampleResult());
    rmSync(paths.evidence);
    expect(() => loadScanArtifacts(paths.report)).toThrow(/evidence bundle not found/);
  });

  it('a v1 report is migrated on load', () => {
    const v1 = join(
      fileURLToPath(new URL('../../core/test-fixtures/v1/', import.meta.url)),
      'leaky-1.1.0.json',
    );
    const loaded = loadScanArtifacts(v1);
    expect(loaded.migratedFrom).toBe('1.1.0');
    expect(loaded.report.reportVersion).toBe('2.0.0');
  });
});

describe('igris verify / igris scanner (no browser)', () => {
  it('verify: exit 0 on a valid pair, 2 on tampering, 3 without args', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'igris-ver-'));
    const paths = writeScanArtifacts(dir, sampleResult());
    expect((await runVerify([paths.report])).exitCode).toBe(EXIT.OK);
    writeFileSync(paths.evidence, '{"bundleVersion":"igris.evidence.v1","items":{}}');
    expect((await runVerify([paths.report])).exitCode).toBe(EXIT.SCAN_ERROR);
    expect((await runVerify([])).exitCode).toBe(EXIT.INVALID_ARGS);
  });

  it('scanner init/list/show never print the key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igris-home-'));
    const prev = process.env.IGRIS_HOME;
    process.env.IGRIS_HOME = home;
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => (
      writes.push(String(c)),
      true
    )) as typeof process.stdout.write;
    try {
      expect((await runScanner(['init', '--name', 'primary'])).exitCode).toBe(EXIT.OK);
      expect((await runScanner(['list'])).exitCode).toBe(EXIT.OK);
      expect((await runScanner(['show'])).exitCode).toBe(EXIT.OK);
      expect((await runScanner(['init'])).exitCode).toBe(EXIT.INVALID_ARGS); // --name required
    } finally {
      process.stdout.write = orig;
      if (prev === undefined) delete process.env.IGRIS_HOME;
      else process.env.IGRIS_HOME = prev;
    }
    const out = writes.join('');
    const { listScanners } = await import('@igris/registry');
    const [p] = listScanners(home);
    const key = readFileSync(join(home, 'scanners', p!.address, 'key'), 'utf8').trim();
    expect(out).toContain(p!.address);
    expect(out).not.toContain(key.slice(2));
  });
});
