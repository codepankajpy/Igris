/**
 * CLI contract e2e: exit codes and --json purity, against the offline fixture.
 * Lives in the scanner package to reuse the sink + fixture plumbing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  buildFixture,
  HOST_RULES,
  PAGE_PORT,
  REPO_ROOT,
  serveDist,
  startSinkServer,
} from './helpers.js';

const FIXTURE = join(REPO_ROOT, 'fixtures/leaky-dapp');
const CLI_PAGE_PORT = PAGE_PORT + 1; // own port: avoid cross-file EADDRINUSE
const PAGE_URL = `http://leaky-dapp.test:${CLI_PAGE_PORT}/`;
const TSX = join(REPO_ROOT, 'node_modules/.bin/tsx');
const CLI = join(REPO_ROOT, 'packages/cli/src/main.ts');

let pageServer: Server;
let sink: { close: () => Promise<void> };

/**
 * Async on purpose: the fixture's page server and sink run in THIS process,
 * so a synchronous execFileSync would block the event loop and starve them —
 * the scanned page would hang forever on its own test servers.
 */
function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      TSX,
      [CLI, ...args],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 150_000 },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? -1) : 0;
        resolve({ code: typeof code === 'number' ? code : -1, stdout, stderr });
      },
    );
  });
}

beforeAll(async () => {
  buildFixture(FIXTURE);
  pageServer = await serveDist(join(FIXTURE, 'dist'), CLI_PAGE_PORT);
  sink = await startSinkServer();
}, 180_000);

afterAll(async () => {
  await new Promise((r) => pageServer.close(() => r(undefined)));
  await sink.close();
});

describe('igris CLI', () => {
  it('exit 3 on invalid args, 0 on help', async () => {
    expect((await runCli(['scan'])).code).toBe(3);
    expect((await runCli(['nonsense'])).code).toBe(3);
    expect((await runCli(['--help'])).code).toBe(0);
  });

  it('exit 2 when the page fails to load', async () => {
    const r = await runCli([
      'scan',
      `http://does-not-exist.test:1/`,
      '--host-resolver-rules',
      HOST_RULES,
      '--dwell',
      '300',
      '--json',
    ]);
    expect(r.code).toBe(2);
    const { report } = JSON.parse(r.stdout);
    expect(report.scan.status).toBe('page-load-failed');
    // P0-1: nothing was measured, so there is no score (was 100 before).
    expect(report.privacy.score).toBeNull();
    expect(report.privacy.coverage).toBe('none');
    expect(report.privacy.ledger).toEqual([]);
  });

  it('publish refuses an unscored report (exit 2, nothing written)', async () => {
    const r = await runCli([
      'scan',
      `http://does-not-exist.test:1/`,
      '--host-resolver-rules',
      HOST_RULES,
      '--dwell',
      '300',
      '--json',
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'igris-unpub-'));
    const reportPath = join(dir, 'report.json');
    const parsed = JSON.parse(r.stdout);
    writeFileSync(reportPath, JSON.stringify(parsed.report));
    writeFileSync(join(dir, 'evidence.json'), JSON.stringify(parsed.evidence));
    const registryPath = join(dir, 'registry.json');
    const pub = await runCli([
      'publish',
      reportPath,
      '--registry',
      'local',
      '--local-file',
      registryPath,
    ]);
    expect(pub.code).toBe(2);
    expect(pub.stderr).toMatch(/refusing to publish/);
    expect(existsSync(registryPath)).toBe(false);
  });

  it('leaky fixture: --fail-under 90 exits 1; --json prints only the report; artifacts written', async () => {
    // Both local servers must answer before the scan: the fixture's deferred
    // sink scripts block DOMContentLoaded, so a dead sink reads as a dead page.
    const sinkAlive = await fetch('http://127.0.0.1:38545/').then(
      (r) => r.ok,
      () => false,
    );
    const pageAlive = await fetch(PAGE_URL.replace('leaky-dapp.test', '127.0.0.1')).then(
      (r) => r.ok,
      () => false,
    );
    expect({ sinkAlive, pageAlive }).toEqual({ sinkAlive: true, pageAlive: true });
    const outDir = mkdtempSync(join(tmpdir(), 'igris-cli-'));
    const r = await runCli([
      'scan',
      PAGE_URL,
      '--host-resolver-rules',
      HOST_RULES,
      '--dwell',
      '1500',
      '--fail-under',
      '90',
      '--json',
    ]);
    // --json: stdout must be exactly one JSON document: {report, evidence}.
    const { report, evidence } = JSON.parse(r.stdout);
    expect(
      report.scan.status,
      `status=${report.scan.status} notes=${JSON.stringify(report.scan.notes)} stderr=${r.stderr.slice(0, 300)}`,
    ).toBe('completed');
    expect(r.code).toBe(1);
    expect(report.privacy.score).toBeLessThan(90);
    expect(evidence.bundleVersion).toBe('igris.evidence.v1');

    // Default mode writes report.json + report.html.
    const r2 = await runCli([
      'scan',
      PAGE_URL,
      '--host-resolver-rules',
      HOST_RULES,
      '--dwell',
      '1500',
      '--out',
      outDir,
      '--explain',
    ]);
    expect(r2.code).toBe(0); // no --fail-under
    expect(r2.stdout).toContain('penalty ledger');
    expect(existsSync(join(outDir, 'report.json'))).toBe(true);
    expect(existsSync(join(outDir, 'evidence.json'))).toBe(true);
    const html = readFileSync(join(outDir, 'report.html'), 'utf8');
    expect(html).toContain('IGRIS scan');
    expect(html).toContain('<CANARY>'.replace('<', '&lt;').replace('>', '&gt;'));

    // The written artifacts verify, and publish (local) accepts them and
    // records the evidence hash.
    const v = await runCli(['verify', join(outDir, 'report.json')]);
    expect(v.code, v.stderr).toBe(0);
    expect(v.stdout).toMatch(/^OK /);
    const registryPath = join(outDir, 'registry.json');
    const pub = await runCli([
      'publish',
      join(outDir, 'report.json'),
      '--registry',
      'local',
      '--local-file',
      registryPath,
    ]);
    expect(pub.code, pub.stderr).toBe(0);
    const reg = JSON.parse(readFileSync(registryPath, 'utf8'));
    const written = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
    expect(reg.records[0].summary.evidenceSha256).toBe(written.evidence.sha256);

    // Tampering with the evidence makes verify AND publish refuse.
    writeFileSync(
      join(outDir, 'evidence.json'),
      '{"bundleVersion":"igris.evidence.v1","items":{}}',
    );
    expect((await runCli(['verify', join(outDir, 'report.json')])).code).toBe(2);
    const pub2 = await runCli([
      'publish',
      join(outDir, 'report.json'),
      '--registry',
      'local',
      '--local-file',
      registryPath,
    ]);
    expect(pub2.code).toBe(2);
    expect(pub2.stderr).toMatch(/evidence does not match/);
  }, 400_000);
});
