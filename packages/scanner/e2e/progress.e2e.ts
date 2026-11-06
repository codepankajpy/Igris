/**
 * Scan progress events must describe what actually happened (the web app
 * shows them live). Offline, against the leaky fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { scan, SCAN_STAGES, type ScanProgressEvent } from '../src/index.js';
import {
  buildFixture,
  HOST_RULES,
  PAGE_PORT,
  REPO_ROOT,
  serveDist,
  startSinkServer,
} from './helpers.js';

const FIXTURE = join(REPO_ROOT, 'fixtures/leaky-dapp');
const PORT = PAGE_PORT + 50;
let pageServer: Server;
let sink: { close: () => Promise<void> };

beforeAll(async () => {
  buildFixture(FIXTURE);
  pageServer = await serveDist(join(FIXTURE, 'dist'), PORT);
  sink = await startSinkServer();
}, 180_000);
afterAll(async () => {
  await new Promise((r) => pageServer.close(() => r(undefined)));
  await sink.close();
});

describe('scan progress events', () => {
  it('a completed scan reports every stage in execution order with truthful counters', async () => {
    const events: ScanProgressEvent[] = [];
    const result = await scan({
      url: `http://leaky-dapp.test:${PORT}/`,
      hostResolverRules: HOST_RULES,
      dwellMs: 1500,
      onProgress: (e) => events.push(e),
    });
    expect(result.report.scan.status).toBe('completed');

    // Stage order: the first event of each stage follows the order of SCAN_STAGES.
    const firstSeen = [...new Set(events.map((e) => e.stage))];
    expect(firstSeen).toEqual([...SCAN_STAGES]);

    // Every stage that started also completed, after it started.
    for (const st of SCAN_STAGES) {
      const started = events.findIndex((e) => e.stage === st && e.status === 'started');
      const done = events.findIndex((e) => e.stage === st && e.status === 'completed');
      expect(done, st).toBeGreaterThan(-1);
      if (started !== -1) expect(done, st).toBeGreaterThan(started);
    }
    expect(events.some((e) => e.status === 'failed' || e.status === 'skipped')).toBe(false);

    // Live counters (raw capture, incl. data: URLs) only grow.
    const reqs = events.filter((e) => e.counters).map((e) => e.counters!.requests);
    expect(reqs.length).toBeGreaterThan(2);
    for (let i = 1; i < reqs.length; i++) expect(reqs[i]!).toBeGreaterThanOrEqual(reqs[i - 1]!);

    // The report stage states the real score.
    const report = events.find((e) => e.stage === 'report' && e.status === 'completed')!;
    expect(report.detail).toBe(`privacy score ${result.report.privacy.score}/100`);
    // The wallet stage reports the real connection.
    expect(events.find((e) => e.stage === 'wallet' && e.status === 'completed')!.detail).toMatch(
      /^connected/,
    );
  }, 180_000);

  it('an unreachable target: navigation failed, dependent stages skipped, report not scored', async () => {
    const events: ScanProgressEvent[] = [];
    const result = await scan({
      url: 'http://nothing-here.test:1/',
      hostResolverRules: HOST_RULES,
      dwellMs: 300,
      onProgress: (e) => events.push(e),
    });
    expect(result.report.privacy.score).toBeNull();
    const nav = events.filter((e) => e.stage === 'navigation').map((e) => e.status);
    expect(nav).toEqual(['started', 'failed']);
    for (const st of ['observe-pre-connect', 'wallet', 'observe-post-connect'] as const) {
      expect(events.filter((e) => e.stage === st).map((e) => e.status)).toEqual(['skipped']);
    }
    expect(events.find((e) => e.stage === 'report')!.detail).toBe('not scored');
  }, 120_000);
});
