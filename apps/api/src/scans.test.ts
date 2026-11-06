/**
 * Web-application scan jobs: lifecycle, real progress, persistence,
 * verification on read, restart behaviour and dashboard aggregates.
 * The scanner is a fake that emits progress and returns a real engine result.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScanResult } from '@igris/core';
import { sampleResult } from '@igris/core/testing';
import { isPublicAddress, type ScanOptions } from '@igris/scanner';
import { recordFromReport } from '@igris/registry';
import { aggregateStats, createApp } from './app.js';
import { loadConfig } from './config.js';
import { JobQueue } from './limits.js';
import { ScanService, summarize, type ScanFn, type ScanMeta } from './scans.js';

const fakeScan =
  (result: ScanResult = sampleResult(), gate?: Promise<void>): ScanFn =>
  async (o: ScanOptions) => {
    o.onProgress?.({ stage: 'browser', status: 'started', at: '2026-11-06T00:00:00.000Z' });
    if (gate) await gate;
    o.onProgress?.({ stage: 'browser', status: 'completed', at: '2026-11-06T00:00:01.000Z' });
    o.onProgress?.({
      stage: 'report',
      status: 'completed',
      at: '2026-11-06T00:00:02.000Z',
      detail: 'x',
    });
    return result;
  };

let server: Server | undefined;
afterEach(async () => {
  await new Promise((r) => (server ? server.close(() => r(undefined)) : r(undefined)));
  server = undefined;
});

function service(
  scan: ScanFn,
  dataDir = mkdtempSync(join(tmpdir(), 'igris-scans-')),
  queue = new JobQueue(1, 2, 60_000),
) {
  return new ScanService({
    dataDir,
    queue,
    scan,
    scanDefaults: { egress: { mode: 'public-only' } },
  });
}

async function start(scans: ScanService) {
  const app = createApp(loadConfig({ IGRIS_RATE_LIMIT_MAX: '100' }), {
    scan: async () => sampleResult(),
    fix: () => ({ diff: '', changedFiles: [], notes: [] }),
    recordFromReport,
    isPublicAddress,
    log: () => {},
    scans,
  });
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function until(f: () => boolean | Promise<boolean>, ms = 5000) {
  const t0 = Date.now();
  while (!(await f())) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/api/scans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('scan jobs', () => {
  it('submit → completed: summary, verified report, events, egress forced', async () => {
    let seen: ScanOptions | undefined;
    const svc = service(async (o) => {
      seen = o;
      return fakeScan()(o);
    });
    const base = await start(svc);
    const res = await post(base, {
      url: 'https://app.example.org/',
      egress: { mode: 'unrestricted' },
    });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    await until(() => svc.get(id)?.state === 'completed');
    expect(seen?.egress).toEqual({ mode: 'public-only' });

    const { scan } = (await (await fetch(`${base}/api/scans/${id}`)).json()) as { scan: ScanMeta };
    expect(scan.events.map((e) => `${e.stage}:${e.status}`)).toEqual([
      'browser:started',
      'browser:completed',
      'report:completed',
    ]);
    expect(scan.summary).toMatchObject({
      score: sampleResult().report.privacy.score,
      addressLeaks: 3,
    });
    expect(scan.summary!.leakDomains).toEqual(['infura.io', 'segment.io', 'sentry.io']);

    const rep = (await (await fetch(`${base}/api/scans/${id}/report`)).json()) as {
      report: { reportVersion: string };
      verification: unknown;
      evidence: { items: object };
    };
    expect(rep.verification).toEqual({ schema: true, integrity: true });
    expect(Object.keys(rep.evidence.items).length).toBe(sampleResult().report.evidence.itemCount);
  });

  it('SSE replays real events then done (finished scan)', async () => {
    const svc = service(fakeScan());
    const base = await start(svc);
    const { id } = (await (await post(base, { url: 'https://app.example.org/' })).json()) as {
      id: string;
    };
    await until(() => svc.get(id)?.state === 'completed');
    const text = await (await fetch(`${base}/api/scans/${id}/events`)).text();
    const events = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(events).toEqual(['state', 'progress', 'progress', 'progress', 'done']);
  });

  it('SSE streams live events for a running scan, sending state only on transitions', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const svc = service(fakeScan(sampleResult(), gate));
    const base = await start(svc);
    const { id } = (await (await post(base, { url: 'https://app.example.org/' })).json()) as {
      id: string;
    };
    await until(() => svc.get(id)?.state === 'running');
    const pending = fetch(`${base}/api/scans/${id}/events`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 50));
    release();
    const text = await pending;
    const events = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(events.filter((e) => e === 'state')).toHaveLength(1);
    expect(events.at(-1)).toBe('done');
    expect(events.filter((e) => e === 'progress')).toHaveLength(3);
  });

  it('queue full → 503 and no job is created', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const svc = service(fakeScan(sampleResult(), gate), undefined, new JobQueue(1, 0, 60_000));
    const base = await start(svc);
    expect((await post(base, { url: 'https://a.example.org/' })).status).toBe(202);
    expect((await post(base, { url: 'https://b.example.org/' })).status).toBe(503);
    expect(svc.list()).toHaveLength(1);
    release();
  });

  it('a scanner error → failed with the error recorded', async () => {
    const svc = service(async () => {
      throw new Error('engine refused its output');
    });
    const base = await start(svc);
    const { id } = (await (await post(base, { url: 'https://app.example.org/' })).json()) as {
      id: string;
    };
    await until(() => svc.get(id)?.state === 'failed');
    expect(svc.get(id)!.error).toMatch(/engine refused its output/);
    expect((await fetch(`${base}/api/scans/${id}/report`)).status).toBe(409);
  });

  it('internal targets and bad ids are rejected', async () => {
    const base = await start(service(fakeScan()));
    expect((await post(base, { url: 'http://169.254.169.254/' })).status).toBe(400);
    expect((await fetch(`${base}/api/scans/not-a-uuid`)).status).toBe(404);
    expect(
      (await fetch(`${base}/api/scans/00000000-0000-4000-8000-000000000000/report`)).status,
    ).toBe(404);
  });
});

describe('persistence', () => {
  it('a restart keeps completed scans (re-verified) and marks in-flight scans interrupted', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'igris-scans-'));
    const a = service(fakeScan(), dataDir);
    const done = a.submit('https://app.example.org/', 1000);
    await until(() => a.get(done.id)?.state === 'completed');
    const stuck = service(() => new Promise<ScanResult>(() => {}), dataDir).submit(
      'https://b.example.org/',
      1000,
    );

    const b = service(fakeScan(), dataDir); // "restart"
    expect(b.get(done.id)!.state).toBe('completed');
    expect(b.artifacts(done.id)!.verification).toEqual({ schema: true, integrity: true });
    expect(b.get(stuck.id)!.state).toBe('failed');
    expect(b.get(stuck.id)!.error).toMatch(/interrupted/);
  });

  it('evidence tampered with on disk is refused, not served', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'igris-scans-'));
    const svc = service(fakeScan(), dataDir);
    const base = await start(svc);
    const { id } = (await (await post(base, { url: 'https://app.example.org/' })).json()) as {
      id: string;
    };
    await until(() => svc.get(id)?.state === 'completed');
    const ev = join(dataDir, 'scans', id, 'evidence.json');
    writeFileSync(ev, readFileSync(ev, 'utf8').replace('segment.io', 'example.io'));
    const res = await fetch(`${base}/api/scans/${id}/report`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/failed verification/);
  });
});

describe('dashboard aggregates', () => {
  it('count only completed scans; not-scored scans are separated; average over scored only', () => {
    const base = sampleResult();
    const meta = (id: string, state: ScanMeta['state'], score: number | null): ScanMeta => ({
      id,
      url: 'https://x.org/',
      hostname: `${id}.org`,
      createdAt: '2026-11-06T00:00:00.000Z',
      state,
      events: [],
      ...(state === 'completed' ? { summary: { ...summarize(base), score } } : {}),
    });
    const stats = aggregateStats([
      meta('a', 'completed', 80),
      meta('b', 'completed', null),
      meta('c', 'failed', null),
      meta('d', 'running', null),
    ]);
    expect(stats.totals).toMatchObject({
      scans: 4,
      completed: 2,
      failed: 1,
      inProgress: 1,
      scored: 1,
      notScored: 1,
    });
    expect(stats.averageScore).toBe(80);
    // sampleResult carries no connection diagnostics → no kit is claimed.
    expect(stats.kits).toEqual([]);
    expect(stats.topLeakDomains.map((d) => d.domain)).toEqual([
      'infura.io',
      'segment.io',
      'sentry.io',
    ]);
  });

  it('kits are counted by confidence, so a low-confidence guess is never shown as identified', () => {
    const base = summarize(sampleResult());
    const meta = (id: string, kit: { id: string; confidence: string } | null): ScanMeta => ({
      id,
      url: 'https://x.org/',
      hostname: `${id}.org`,
      createdAt: '2026-11-06T00:00:00.000Z',
      state: 'completed',
      events: [],
      summary: { ...base, kit },
    });
    const stats = aggregateStats([
      meta('a', { id: 'privy', confidence: 'low' }),
      meta('b', { id: 'connectkit', confidence: 'high' }),
      meta('c', { id: 'privy', confidence: 'high' }),
      meta('d', null),
    ]);
    expect(stats.kits).toEqual([
      { id: 'privy', high: 1, medium: 0, low: 1 },
      { id: 'connectkit', high: 1, medium: 0, low: 0 },
    ]);
  });

  it('a re-scanned dApp counts once, with its latest result', () => {
    const base = summarize(sampleResult());
    const meta = (id: string, createdAt: string, score: number): ScanMeta => ({
      id,
      url: 'https://app.example.org/',
      hostname: 'app.example.org',
      createdAt,
      state: 'completed',
      events: [],
      summary: { ...base, score },
    });
    const stats = aggregateStats([
      meta('old', '2026-11-06T00:00:00.000Z', 5),
      meta('new', '2026-11-06T01:00:00.000Z', 44),
    ]);
    expect(stats.totals).toMatchObject({ scans: 2, completed: 2, dapps: 1, scored: 1 });
    expect(stats.averageScore).toBe(44);
    expect(stats.topLeakDomains.every((d) => d.scans === 1)).toBe(true);
  });
});
