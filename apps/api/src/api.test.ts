/**
 * The backend's one flow, end to end over real HTTP (ephemeral port):
 * search → versions → scan/retest → cache → publish → verified versions.
 *
 * Scanning is a fake that emits progress and returns a real engine result
 * (core's sampleResult). The registry is a small in-memory SiteRegistry
 * defined here, so these tests never launch a browser, touch the network or
 * depend on a particular registry backend.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EVIDENCE_BUNDLE_VERSION,
  EVIDENCE_BUNDLE_VERSION_V3,
  bundleHash,
  canonicalize,
  contentHash,
  summarise,
  verifyReportIntegrity,
  type EvidenceBundle,
  type ReportV3,
  type ScanResult,
} from '@igris/core';
import { sampleResult } from '@igris/core/testing';
import { isPublicAddress, type ScanOptions } from '@igris/scanner';
import { LocalSiteRegistry, PublishRefusedError, diffVersions } from '@igris/registry';
import type {
  Changes,
  FlowEntity,
  LoadedScan,
  LoadedScanner,
  PublishResult,
  PublishedScan,
  ScannerProfile,
  SiteRegistry,
  WalletRequestEntity,
} from '@igris/registry';
import { Lru, createApp } from './app.js';
import { DRAFT_NOTE, readCachedScan, writeCachedScan } from './artifacts.js';
import { loadConfig, type ApiConfig } from './config.js';
import { SiteScanService, type Job, type ScanFn } from './jobs.js';
import { JobQueue, JobTimeoutError, QueueFullError, RateLimiter } from './limits.js';
import { createRegistry, type RegistryFactories, type RegistryInfo } from './registry.js';
import { scanTarget, validateHostname, validateScanUrl } from './validate.js';

// ---------------------------------------------------------------------------
// In-memory SiteRegistry (test double; same contract as site-registry.ts)
// ---------------------------------------------------------------------------

const PUBLISHER = '0x1111111111111111111111111111111111111111';
/** Another trusted scanner key (IGRIS_TRUSTED_SCANNERS). */
const OTHER = '0x2222222222222222222222222222222222222222';

/** A valid Arkiv entity key (32 bytes). */
const entityKey = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

class FakeRegistry implements SiteRegistry {
  readonly mode = 'arkiv' as const;
  publisher: string | null = PUBLISHER;
  readonly scans: PublishedScan[] = [];
  readonly payloads = new Map<string, { report: ReportV3; bundle: EvidenceBundle }>();
  readonly flows: FlowEntity[] = [];
  failPublish: Error | null = null;
  readonly failLoad = new Set<string>();
  failReads: Error | null = null;
  /** The write lands, then the call fails (e.g. the response was lost). */
  failAfterPublish: Error | null = null;
  failFind: Error | null = null;
  published = 0;
  publishCalls = 0;
  loads = 0;
  readonly findCalls: Array<[string, string]> = [];
  readonly byKeyCalls: string[] = [];
  statusCalls = 0;
  statusImpl: () => Promise<{ ready: boolean; reason?: string }> = async () => ({ ready: true });
  // Wallet requests (igris.walletreq.v1).
  walletRows: WalletRequestEntity[] = [];
  readonly walletCalls: Array<Parameters<SiteRegistry['walletRequests']>[0]> = [];

  private check(): void {
    if (this.failReads) throw this.failReads;
  }
  async status() {
    this.statusCalls += 1;
    return this.statusImpl();
  }
  async findByScanId(hostname: string, scanId: string) {
    this.findCalls.push([hostname, scanId]);
    if (this.failFind) throw this.failFind;
    this.check();
    return (
      this.scans
        .filter((s) => s.hostname === hostname && s.scanId === scanId)
        .sort((a, b) => b.version - a.version)[0] ?? null
    );
  }
  async byKey(key: string) {
    this.byKeyCalls.push(key);
    this.check();
    return this.scans.find((s) => s.key === key) ?? null;
  }
  async versions(hostname: string, opts?: { limit?: number }) {
    this.check();
    return this.scans
      .filter((s) => s.hostname === hostname)
      .sort((a, b) => b.version - a.version)
      .slice(0, opts?.limit ?? 1000);
  }
  async latest(hostname: string) {
    return (await this.versions(hostname))[0] ?? null;
  }
  async version(hostname: string, version: number) {
    this.check();
    return this.scans.find((s) => s.hostname === hostname && s.version === version) ?? null;
  }
  async recentSites(opts?: { limit?: number }) {
    this.check();
    const latest = new Map<string, PublishedScan>();
    for (const s of this.scans) {
      const p = latest.get(s.hostname);
      if (!p || p.version < s.version) latest.set(s.hostname, s);
    }
    return [...latest.values()]
      .sort((a, b) => b.scannedAt - a.scannedAt)
      .slice(0, opts?.limit ?? 20);
  }
  async load(scan: PublishedScan): Promise<LoadedScan> {
    this.loads += 1;
    if (this.failLoad.has(scan.key)) throw new Error('arkiv node unreachable');
    const p = this.payloads.get(scan.key)!;
    const problems = [...verifyReportIntegrity(p.report, p.bundle).problems];
    if (contentHash(p.report) !== scan.scanId) problems.push('scanId mismatch');
    if (bundleHash(p.bundle) !== scan.evidenceSha256) problems.push('evidence mismatch');
    return { ...p, verified: problems.length === 0, problems };
  }
  async publish(report: ReportV3, bundle: EvidenceBundle): Promise<PublishResult> {
    this.publishCalls += 1;
    if (this.failPublish) throw this.failPublish;
    return this.publishAs(PUBLISHER, report, bundle);
  }
  /** What a publish by another trusted scanner key would leave on the registry. */
  async publishAs(owner: string, report: ReportV3, bundle: EvidenceBundle): Promise<PublishResult> {
    const host = new URL(report.scan.target).hostname;
    // Same contract as the real backends: idempotent per scanId, and history
    // never runs backwards.
    const same = this.scans.find((x) => x.hostname === host && x.scanId === contentHash(report));
    if (same) return { scan: same, evidenceKey: '', flowKeys: [], txHash: null };
    const prev = await this.latest(host);
    if (prev && Math.floor(Date.parse(report.scan.scannedAt) / 1000) < prev.scannedAt) {
      throw new PublishRefusedError('older than the latest version');
    }
    const s = summarise(report, bundle);
    const key = `0xkey${this.scans.length + 1}`;
    const scan: PublishedScan = {
      key,
      owner,
      hostname: host,
      version: (prev?.version ?? 0) + 1,
      previous: prev?.key ?? null,
      scannedAt: Math.floor(Date.parse(report.scan.scannedAt) / 1000),
      scanId: contentHash(report),
      evidenceSha256: bundleHash(bundle),
      findingSetSha256: report.findingSet.sha256,
      state: s.state,
      coverage: report.privacy.coverage as 'full' | 'pre-connect-only',
      recipients: report.recipients.length,
      addressRecipients: report.recipients.filter((r) => r.learned.address !== 'none').length,
      trackingRecipients: report.recipients.filter(
        (r) => r.verdict === 'tracking' || r.verdict === 'unidentified',
      ).length,
      usesAnonRpc: report.wallet.usesAnonRpc,
      scannerVersion: report.scan.scannerVersion,
      reportVersion: report.reportVersion,
      expiresAtBlock: null,
    };
    this.scans.push(scan);
    this.payloads.set(key, { report, bundle });
    const flowKeys = report.recipients.map((r, i) => {
      const fk = `${key}-flow${i}`;
      this.flows.push({
        key: fk,
        owner,
        hostname: host,
        recipient: r.registrableDomain,
        class: r.class,
        verdict: r.verdict,
        address: r.learned.address,
        preConnect: r.learned.ip.includes('pre-connect'),
        version: scan.version,
        scanId: scan.scanId,
        scannedAt: scan.scannedAt,
      });
      return fk;
    });
    this.published += 1;
    if (this.failAfterPublish) throw this.failAfterPublish;
    return { scan, evidenceKey: `${key}-evidence`, flowKeys, txHash: `0xtx${this.published}` };
  }
  async flowsTo(recipient: string, opts?: { limit?: number }) {
    this.check();
    return this.flows.filter((f) => f.recipient === recipient).slice(0, opts?.limit ?? 100);
  }
  async walletRequests(opts: Parameters<SiteRegistry['walletRequests']>[0]) {
    this.walletCalls.push(opts);
    this.check();
    return this.walletRows
      .filter((w) => opts.kind === undefined || w.kind === opts.kind)
      .filter((w) => opts.unlimited === undefined || w.unlimited === opts.unlimited)
      .filter((w) => opts.hostname === undefined || w.hostname === opts.hostname)
      .slice(0, opts.limit ?? 50);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ORIGIN = 'http://localhost:5180';
const HOST = 'app.example.org'; // sampleResult's target host

function result(scannedAt = '2026-11-06T00:00:00.000Z', over = {}): ScanResult {
  return sampleResult({ scannedAt, ...over });
}

function fakeScan(results: ScanResult[], gate?: Promise<void>) {
  const calls: ScanOptions[] = [];
  let i = 0;
  const fn: ScanFn = async (o) => {
    calls.push(o);
    o.onProgress?.({ stage: 'browser', status: 'started', at: '2026-11-06T00:00:00.000Z' });
    if (gate) await gate;
    o.onProgress?.({ stage: 'report', status: 'completed', at: '2026-11-06T00:00:02.000Z' });
    return results[Math.min(i++, results.length - 1)]!;
  };
  return { fn, calls };
}

const diffCalls: Array<[ReportV3, ReportV3]> = [];
function fakeDiff(prev: ReportV3, next: ReportV3): Changes {
  diffCalls.push([prev, next]);
  return {
    sameBehaviour: prev.findingSet.sha256 === next.findingSet.sha256,
    added: [],
    removed: [],
    changed: [],
  };
}

/** What GET /api/registry returns: no publisher or trusted-owner addresses. */
function publicView(info: RegistryInfo) {
  return {
    mode: info.mode,
    network: info.network,
    explorer: info.mode === 'arkiv' ? 'https://rabdi.explorer.arkiv.network' : null,
    publishing: info.publisher !== null,
    ready: info.ready,
    ...(info.reason !== undefined ? { reason: info.reason } : {}),
  };
}

const READY: RegistryInfo = {
  mode: 'arkiv',
  publisher: PUBLISHER,
  network: 'arkiv-rabdi-testnet',
  trustedOwners: [PUBLISHER],
  ready: true,
};

let server: Server | undefined;
const bodies: unknown[] = [];
afterEach(async () => {
  await new Promise((r) => (server ? server.close(() => r(undefined)) : r(undefined)));
  server = undefined;
});

interface StartOpts<R extends SiteRegistry> {
  registry?: R;
  diff?: (prev: ReportV3, next: ReportV3) => Changes;
  scan?: ScanFn;
  cfg?: Partial<ApiConfig>;
  info?: RegistryInfo;
  queue?: JobQueue;
  dataDir?: string;
  probe?: { timeoutMs?: number; ttlMs?: number; now?: () => number };
  log?: (m: string) => void;
}

async function start<R extends SiteRegistry = FakeRegistry>(o: StartOpts<R> = {}) {
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), 'igris-api-'));
  const cfg: ApiConfig = {
    ...loadConfig({ IGRIS_RATE_LIMIT_MAX: '100' }),
    dataDir,
    ...o.cfg,
  };
  const registry = (o.registry ?? new FakeRegistry()) as R;
  const scan = o.scan ?? fakeScan([result()]).fn;
  const jobs = new SiteScanService({
    dataDir,
    queue: o.queue ?? new JobQueue(1, 4, 60_000),
    scan,
    registry,
    egress: { mode: 'public-only', allowedPorts: cfg.allowedPorts },
    dwellMs: 1000,
    chromiumSandbox: cfg.chromiumSandbox,
    ...(o.log ? { log: o.log } : {}),
  });
  const app = createApp(cfg, {
    registry,
    registryInfo: o.info ?? READY,
    jobs,
    isPublicAddress,
    diffVersions: o.diff ?? fakeDiff,
    log: o.log ?? (() => {}),
    ...(o.probe ? { probe: o.probe } : {}),
  });
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = async (path: string, init?: RequestInit) => {
    const res = await fetch(base + path, init);
    const body = (await res.json()) as Record<string, unknown>;
    bodies.push(body);
    return { status: res.status, body, headers: res.headers };
  };
  const get = (path: string, headers?: Record<string, string>) =>
    json(path, headers ? { headers } : undefined);
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    json(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const sse = async (id: string) => {
    const text = await (await fetch(`${base}/api/scans/${id}/events`)).text();
    return text
      .split('\n\n')
      .filter((b) => b.startsWith('event: '))
      .map((b) => {
        const [ev, data] = b.split('\n');
        return { event: ev!.slice(7), data: JSON.parse(data!.slice(6)) as Record<string, unknown> };
      });
  };
  const waitDone = async (id: string): Promise<Job> => {
    const t0 = Date.now();
    for (;;) {
      const { body } = await get(`/api/scans/${id}`);
      const job = body.scan as Job;
      if (job.state === 'completed' || job.state === 'failed') return job;
      if (Date.now() - t0 > 5000) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await jobs.reconciled;
  return { base, get, post, sse, waitDone, registry, jobs, dataDir };
}

/** Recursively assert that no object in a JSON value has a "score" key. */
function assertNoScore(v: unknown, path = '$'): void {
  if (Array.isArray(v)) v.forEach((x, i) => assertNoScore(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      expect(k.toLowerCase().includes('score'), `${path}.${k}`).toBe(false);
      assertNoScore(x, `${path}.${k}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validateHostname / scanTarget (fail-fast; the egress proxy is the real control)', () => {
  const ok = ['app.example.org', 'Example.ORG', 'www.bungee.exchange', 'xn--bcher-kva.example'];
  const bad = [
    '127.0.0.1',
    '8.8.8.8',
    '2130706433',
    '0x7f.1',
    '::1',
    '[::1]',
    'localhost',
    'foo.localhost',
    'printer.local',
    'metadata.google.internal',
    'example.org:8080',
    'example',
    '-bad.example.org',
    'a..b',
    'exa mple.org',
    'example.org.',
    'bücher.example',
    '',
    'a'.repeat(254),
  ];
  for (const h of ok) it(`accepts ${h}`, () => expect(validateHostname(h)).toBe(h.toLowerCase()));
  for (const h of bad)
    it(`rejects "${h.slice(0, 40)}"`, () => expect(() => validateHostname(h)).toThrow());

  it('default target is https://<hostname>/; a url must be on that exact hostname', () => {
    expect(scanTarget('Example.org', undefined, [80, 443], isPublicAddress)).toEqual({
      hostname: 'example.org',
      url: 'https://example.org/',
    });
    expect(
      scanTarget('example.org', 'https://example.org/swap?x=1', [80, 443], isPublicAddress).url,
    ).toBe('https://example.org/swap?x=1');
    for (const url of [
      'https://evil.org/',
      'https://www.example.org/',
      'https://example.org.evil.org/',
      'https://example.org:8443/',
      'ftp://example.org/',
      'https://user:pw@example.org/',
    ]) {
      expect(() => scanTarget('example.org', url, [80, 443], isPublicAddress), url).toThrow();
    }
  });

  it('validateScanUrl rejects internal and non-public targets', () => {
    for (const u of [
      'http://localhost/',
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'not a url',
      42,
    ]) {
      expect(() => validateScanUrl(u, [80, 443], isPublicAddress), String(u)).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('GET /api/health and /api/registry', () => {
  it('GET /api/registry never exposes the publisher or trusted-owner addresses', async () => {
    const { get } = await start({ info: READY });
    const body = JSON.stringify((await get('/api/registry')).body);
    expect(body).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(body).toContain('rabdi.explorer.arkiv.network');
  });

  it('health is { ok: true }; registry reports its readiness as configured', async () => {
    const info: RegistryInfo = {
      mode: 'arkiv',
      publisher: null,
      network: 'arkiv-rabdi-testnet',
      trustedOwners: [],
      ready: false,
      reason: 'no scanner profile on this machine',
    };
    const { get } = await start({ info });
    expect((await get('/api/health')).body).toEqual({ ok: true });
    expect((await get('/api/registry')).body).toEqual(publicView(info));
  });
});

describe('scan → publish → versions (the flow)', () => {
  it('first scan publishes v1; retest publishes v2 linked to v1; versions route verifies and diffs', async () => {
    diffCalls.length = 0;
    const r1 = result('2026-11-06T00:00:00.000Z');
    const r2 = result('2026-11-06T01:00:00.000Z');
    const { fn, calls } = fakeScan([r1, r2]);
    const { get, post, waitDone, registry, sse } = await start({ scan: fn });

    // Not scanned yet: empty history, nothing running.
    expect((await get(`/api/sites/${HOST}`)).body).toEqual({
      hostname: HOST,
      versions: [],
      scanning: null,
    });

    const a = await post(`/api/sites/${HOST}/scans`);
    expect(a.status).toBe(202);
    expect(Object.keys(a.body)).toEqual(['id']);
    const job1 = await waitDone(a.body.id as string);
    expect(job1).toMatchObject({
      hostname: HOST,
      url: `https://${HOST}/`,
      state: 'completed',
      version: 1,
      publish: { ok: true, mode: 'arkiv', scanKey: '0xkey1', txHash: '0xtx1' },
    });
    expect(job1.events.map((e) => e.stage)).toEqual(['browser', 'report']);
    // Egress forced to public-only, never taken from the request.
    expect(calls[0]!.egress).toEqual({ mode: 'public-only', allowedPorts: [80, 443] });
    expect(calls[0]!.url).toBe(`https://${HOST}/`);

    // SSE replay of a finished job: state, progress…, done with version + publish.
    const events = await sse(job1.id);
    expect(events[0]).toEqual({ event: 'state', data: { state: 'completed' } });
    expect(events.at(-1)).toEqual({
      event: 'done',
      data: {
        state: 'completed',
        hostname: HOST,
        version: 1,
        error: null,
        publish: job1.publish,
      },
    });

    // Retest with an explicit URL on the same host.
    const b = await post(`/api/sites/${HOST}/scans`, { url: `https://${HOST}/swap` });
    expect(b.status).toBe(202);
    const job2 = await waitDone(b.body.id as string);
    expect(job2.version).toBe(2);
    expect(calls[1]!.url).toBe(`https://${HOST}/swap`);
    expect(registry.scans[1]!.previous).toBe(registry.scans[0]!.key);

    const site = await get(`/api/sites/${HOST}`);
    expect((site.body.versions as PublishedScan[]).map((v) => v.version)).toEqual([2, 1]);

    const v2 = await get(`/api/sites/${HOST}/versions/2`);
    expect(v2.status).toBe(200);
    expect(Object.keys(v2.body).sort()).toEqual(
      ['changes', 'evidence', 'problems', 'report', 'scan', 'source', 'summary', 'verified'].sort(),
    );
    expect(v2.body).toMatchObject({ verified: true, problems: [], source: 'arkiv' });
    expect(v2.body.summary).toEqual(summarise(r2.report, r2.bundle));
    expect(v2.body.changes).toEqual({ sameBehaviour: true, added: [], removed: [], changed: [] });
    expect(contentHash(diffCalls[0]![0])).toBe(contentHash(r1.report));
    expect(contentHash(diffCalls[0]![1])).toBe(contentHash(r2.report));

    const v1 = await get(`/api/sites/${HOST}/versions/1`);
    expect(v1.body.changes).toBeNull();
    expect(contentHash(v1.body.report)).toBe(contentHash(r1.report));

    expect((await get(`/api/sites/${HOST}/versions/3`)).status).toBe(404);
    expect((await get(`/api/sites/${HOST}/versions/0`)).status).toBe(400);
    expect((await get(`/api/sites/${HOST}/versions/abc`)).status).toBe(400);

    // Recent sites and the cross-site recipient view.
    const sites = await get('/api/sites?limit=5');
    expect((sites.body.sites as PublishedScan[]).map((s) => [s.hostname, s.version])).toEqual([
      [HOST, 2],
    ]);
    expect((await get('/api/sites?limit=0')).status).toBe(400);
    const recipient = r2.report.recipients[0]!.registrableDomain;
    const flows = await get(`/api/recipients/${recipient}`);
    expect((flows.body.flows as FlowEntity[]).length).toBeGreaterThan(0);
    expect((await get('/api/recipients/127.0.0.1')).status).toBe(400);
  });

  it('versions route reports unverified content honestly', async () => {
    const { get, post, waitDone, registry } = await start();
    await waitDone((await post(`/api/sites/${HOST}/scans`)).body.id as string);
    // Tamper with what the registry returns: the report no longer matches its hashes.
    const p = registry.payloads.get('0xkey1')!;
    p.report = { ...p.report, scan: { ...p.report.scan, scannedAt: '2020-01-01T00:00:00.000Z' } };
    const v1 = await get(`/api/sites/${HOST}/versions/1`);
    expect(v1.body.verified).toBe(false);
    expect(v1.body.problems).toContain('scanId mismatch');
  });

  it('registry load failure → served from the verified local cache with source "local"', async () => {
    const { get, post, waitDone, registry, dataDir } = await start();
    await waitDone((await post(`/api/sites/${HOST}/scans`)).body.id as string);
    registry.failLoad.add('0xkey1');
    const v1 = await get(`/api/sites/${HOST}/versions/1`);
    expect(v1.status).toBe(200);
    expect(v1.body.source).toBe('local');
    expect(v1.body.verified).toBe(true);
    expect((v1.body.problems as string[])[0]).toMatch(/local cache.*could not be loaded/);
    // No cache either → 502, nothing invented.
    rmSync(join(dataDir, 'cache'), { recursive: true });
    expect((await get(`/api/sites/${HOST}/versions/1`)).status).toBe(502);
  });

  it('registry read failure → 502 with the reason (addresses elided)', async () => {
    const registry = new FakeRegistry();
    registry.failReads = new Error(`arkiv rpc down (caller ${OTHER})`);
    const { get } = await start({ registry });
    const r = await get(`/api/sites/${HOST}`);
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/arkiv rpc down/);
    expect((await get('/api/sites')).status).toBe(502);
  });
});

describe('POST /api/sites/:hostname/scans', () => {
  it('400 on IPs, localhost, internal names, ports and URLs on another host', async () => {
    const { post, get } = await start();
    for (const h of [
      '127.0.0.1',
      '8.8.8.8',
      'localhost',
      'metadata.google.internal',
      'example.org:8443',
      'nodots',
    ]) {
      const r = await post(`/api/sites/${encodeURIComponent(h)}/scans`);
      expect(r.status, h).toBe(400);
    }
    for (const url of [
      'https://evil.org/',
      'http://169.254.169.254/',
      `https://${HOST}:8443/`,
      'file:///etc/passwd',
    ]) {
      const r = await post(`/api/sites/${HOST}/scans`, { url });
      expect(r.status, url).toBe(400);
    }
    expect((await post(`/api/sites/${HOST}/scans`, '{bad')).status).toBe(400);
    expect((await post(`/api/sites/${HOST}/scans`, { url: 'x'.repeat(20_000) })).status).toBe(413);
    expect((await get(`/api/sites/localhost`)).status).toBe(400);
  });

  it('409 with the running id while a scan of the same hostname is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { post, get, waitDone } = await start({ scan: fakeScan([result()], gate).fn });
    const a = await post(`/api/sites/${HOST}/scans`);
    expect(a.status).toBe(202);
    const dup = await post(`/api/sites/${HOST}/scans`);
    expect(dup.status).toBe(409);
    expect(dup.body.id).toBe(a.body.id);
    const site = await get(`/api/sites/${HOST}`);
    expect(site.body.scanning).toEqual({
      id: a.body.id,
      state: expect.stringMatching(/queued|running/),
    });
    release();
    await waitDone(a.body.id as string);
    expect((await get(`/api/sites/${HOST}`)).body.scanning).toBeNull();
  });

  it('live SSE: state transitions, progress, then done', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { post, sse } = await start({ scan: fakeScan([result()], gate).fn });
    const id = (await post(`/api/sites/${HOST}/scans`)).body.id as string;
    const stream = sse(id);
    await new Promise((r) => setTimeout(r, 50));
    release();
    const events = await stream;
    expect(events.map((e) => e.event)).toEqual(['state', 'progress', 'progress', 'done']);
    expect(events.at(-1)!.data).toMatchObject({ state: 'completed', version: 1, error: null });
  });

  it('coverage none → job failed with the scanner reason; nothing cached or published', async () => {
    const failed = result('2026-11-06T00:00:00.000Z', {
      status: 'page-load-failed',
      failure: { category: 'site-unavailable', detail: 'net::ERR_NAME_NOT_RESOLVED' },
    });
    const { post, waitDone, registry, sse } = await start({ scan: fakeScan([failed]).fn });
    const job = await waitDone((await post(`/api/sites/${HOST}/scans`)).body.id as string);
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/site unavailable \(net::ERR_NAME_NOT_RESOLVED\)/);
    expect(job.version).toBeNull();
    expect(job.publish).toBeNull();
    expect(registry.scans).toHaveLength(0);
    expect((await sse(job.id)).at(-1)!.data).toEqual({
      state: 'failed',
      hostname: HOST,
      version: null,
      error: job.error,
      publish: null,
    });
  });

  it('a scan that throws or times out is failed with the reason', async () => {
    const { post, waitDone } = await start({
      scan: async () => {
        throw new Error('chromium crashed');
      },
    });
    const job = await waitDone((await post(`/api/sites/${HOST}/scans`)).body.id as string);
    expect(job).toMatchObject({ state: 'failed', version: null, publish: null });
    expect(job.error).toMatch(/chromium crashed/);
  });

  it('publish failure → completed with publish.ok false; retry endpoint publishes from the cache', async () => {
    const registry = new FakeRegistry();
    registry.failPublish = new Error('arkiv: insufficient funds for gas');
    const { post, get, waitDone, sse } = await start({ registry });
    const id = (await post(`/api/sites/${HOST}/scans`)).body.id as string;
    const job = await waitDone(id);
    expect(job).toMatchObject({
      state: 'completed',
      version: null,
      publish: { ok: false, error: 'arkiv: insufficient funds for gas', mode: 'arkiv' },
    });
    expect((await sse(id)).at(-1)!.data).toMatchObject({
      state: 'completed',
      version: null,
      publish: { ok: false },
    });

    // Still failing → 200 with ok:false (the attempt happened).
    const again = await post(`/api/scans/${id}/publish`);
    expect(again.status).toBe(200);
    expect(again.body.publish).toMatchObject({ ok: false });

    registry.failPublish = null;
    const retry = await post(`/api/scans/${id}/publish`);
    expect(retry.status).toBe(200);
    expect(retry.body.publish).toMatchObject({ ok: true, scanKey: '0xkey1', mode: 'arkiv' });
    expect((await get(`/api/scans/${id}`)).body.scan).toMatchObject({ version: 1 });
    expect((await get(`/api/sites/${HOST}/versions/1`)).body.verified).toBe(true);

    expect((await post(`/api/scans/${id}/publish`)).status).toBe(409); // already published
    expect((await post(`/api/scans/00000000-0000-4000-8000-000000000000/publish`)).status).toBe(
      404,
    );
  });

  it('retry publish is 409 for a failed scan', async () => {
    const { post, waitDone } = await start({
      scan: async () => {
        throw new Error('boom');
      },
    });
    const id = (await post(`/api/sites/${HOST}/scans`)).body.id as string;
    await waitDone(id);
    expect((await post(`/api/scans/${id}/publish`)).status).toBe(409);
  });

  it('503 when the registry cannot publish (not ready) or the queue is full', async () => {
    const notReady = await start({
      info: { ...READY, ready: false, publisher: null, reason: 'no scanner key' },
    });
    const r = await notReady.post(`/api/sites/${HOST}/scans`);
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/no scanner key/);
    await new Promise((res) => server!.close(() => res(undefined)));
    server = undefined;

    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const busy = await start({
      scan: fakeScan([result()], gate).fn,
      queue: new JobQueue(1, 0, 60_000),
    });
    expect((await busy.post(`/api/sites/${HOST}/scans`)).status).toBe(202);
    expect((await busy.post('/api/sites/other.example.org/scans')).status).toBe(503);
    release();
  });

  it('rate limits per client (429)', async () => {
    const { post } = await start({ cfg: { rateLimitMax: 2 }, scan: fakeScan([result()]).fn });
    await post('/api/sites/a.example.org/scans');
    await post('/api/sites/b.example.org/scans');
    expect((await post('/api/sites/c.example.org/scans')).status).toBe(429);
  });

  it('CORS: only configured origins get an allow-origin header; never "*"', async () => {
    const { base } = await start();
    const ok = await fetch(`${base}/api/health`, { headers: { origin: ORIGIN } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const evil = await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.org' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('legacy routes are gone', async () => {
    const { base } = await start();
    for (const [method, path] of [
      ['POST', '/api/scan'],
      ['POST', '/api/scan-repo'],
      ['GET', '/api/scans'],
      ['GET', '/api/stats'],
      ['POST', '/api/scans'],
      // the removed multi-node network: node labels and per-request rounds
      ['GET', '/api/nodes'],
      ['GET', `/api/sites/${HOST}/rounds/${'0x' + 'a'.repeat(64)}`],
    ] as const) {
      expect((await fetch(base + path, { method })).status, path).toBe(404);
    }
  });

  it('GET /api/scans/:id → 404 for unknown or malformed ids', async () => {
    const { get } = await start();
    expect((await get('/api/scans/nope')).status).toBe(404);
    expect((await get('/api/scans/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

describe('restart behaviour', () => {
  it('a scan cut short while publishing becomes retryable; one cut short while scanning is failed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'igris-api-'));
    const r = result();
    const scanId = writeCachedScan(dataDir, r.report, r.bundle);
    mkdirSync(join(dataDir, 'jobs'), { recursive: true });
    const base: Job = {
      id: '',
      hostname: HOST,
      url: `https://${HOST}/`,
      state: 'running',
      createdAt: '2026-11-06T00:00:00.000Z',
      events: [],
      version: null,
      publish: null,
    };
    const publishing = { ...base, id: '11111111-1111-4111-8111-111111111111' };
    const scanning = { ...base, id: '22222222-2222-4222-8222-222222222222' };
    writeFileSync(
      join(dataDir, 'jobs', `${publishing.id}.json`),
      JSON.stringify({ job: publishing, scanId }),
    );
    writeFileSync(
      join(dataDir, 'jobs', `${scanning.id}.json`),
      JSON.stringify({ job: scanning, scanId: null }),
    );
    const { get, post } = await start({ dataDir });
    expect((await get(`/api/scans/${scanning.id}`)).body.scan).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/interrupted/),
    });
    expect((await get(`/api/scans/${publishing.id}`)).body.scan).toMatchObject({
      state: 'completed',
      publish: { ok: false, error: expect.stringMatching(/interrupted/) },
    });
    const retry = await post(`/api/scans/${publishing.id}/publish`);
    expect(retry.body.publish).toMatchObject({ ok: true });
  });
});

describe('local cache', () => {
  it('round-trips byte-exact and detects tampering', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'igris-cache-'));
    const r = result();
    const id = writeCachedScan(dataDir, r.report, r.bundle);
    expect(id).toBe(contentHash(r.report));
    expect(readCachedScan(dataDir, id)!.problems).toEqual([]);
    expect(readCachedScan(dataDir, 'f'.repeat(64))).toBeNull();
    expect(readCachedScan(dataDir, '../../etc')).toBeNull();
    const tampered = { ...r.report, scan: { ...r.report.scan, target: 'https://evil.org/' } };
    writeFileSync(join(dataDir, 'cache', id, 'report.json'), JSON.stringify(tampered));
    expect(readCachedScan(dataDir, id)!.problems.join(' ')).toMatch(/hashes to/);
  });
});

// ---------------------------------------------------------------------------
// Registry selection from the environment
// ---------------------------------------------------------------------------

describe('createRegistry (env)', () => {
  const profile: ScannerProfile = {
    schema: 'igris.scanner.v1',
    address: PUBLISHER,
    name: 'main',
    nodeId: '33333333-3333-4333-8333-333333333333',
    createdAt: '',
    origin: 'generated',
  };
  function factories(profiles: ScannerProfile[], loadError?: string) {
    const made: Array<{ kind: string; opts: unknown }> = [];
    const f: RegistryFactories = {
      listScanners: () => profiles,
      loadScanner: () => {
        if (loadError) throw new Error(loadError);
        return { profile, privateKey: '0x00', address: PUBLISHER } as LoadedScanner;
      },
      local: (opts) => (made.push({ kind: 'local', opts }), new FakeRegistry()),
      arkiv: (opts) => (made.push({ kind: 'arkiv', opts }), new FakeRegistry()),
    };
    return { f, made };
  }

  it('defaults to local (<dataDir>/registry.json) when no scanner profile exists', () => {
    const { f, made } = factories([]);
    const { info } = createRegistry({}, '/data', f);
    expect(info).toMatchObject({ mode: 'local', ready: true, network: 'local' });
    expect(made[0]).toMatchObject({ kind: 'local', opts: { file: '/data/registry.json' } });
  });

  it('defaults to arkiv when a profile exists; publisher is trusted; access key passed, never exposed', () => {
    const { f, made } = factories([profile]);
    const { info } = createRegistry(
      {
        ARKIV_ACCESS_KEY: 'secret-key',
        IGRIS_TRUSTED_SCANNERS: '0x2222222222222222222222222222222222222222',
      },
      '/data',
      f,
    );
    expect(info).toEqual({
      mode: 'arkiv',
      publisher: PUBLISHER,
      network: 'arkiv-rabdi-testnet',
      trustedOwners: [PUBLISHER, '0x2222222222222222222222222222222222222222'],
      ready: true,
    });
    expect(made[0]!.opts).toMatchObject({ accessKey: 'secret-key', expiryDays: 180 });
    expect(JSON.stringify(info)).not.toContain('secret-key');
  });

  it('arkiv without a scanner profile (or with an unloadable key) is read-only: ready false + reason', () => {
    const none = createRegistry({ IGRIS_REGISTRY: 'arkiv' }, '/data', factories([]).f).info;
    expect(none).toMatchObject({ mode: 'arkiv', publisher: null, ready: false });
    expect(none.reason).toMatch(/no scanner profile/);
    const bad = createRegistry({}, '/data', factories([profile], 'mode 644').f).info;
    expect(bad).toMatchObject({ ready: false, publisher: null });
    expect(bad.reason).toMatch(/mode 644/);
  });

  it('local mode always publishes as "local", never under a real scanner address', () => {
    for (const env of [
      { IGRIS_REGISTRY: 'local' },
      { IGRIS_REGISTRY: 'local', IGRIS_SCANNER: 'main' },
      { IGRIS_REGISTRY: 'local', IGRIS_SCANNER: 'MAIN' },
      { IGRIS_REGISTRY: 'local', IGRIS_SCANNER: PUBLISHER },
    ]) {
      const { f, made } = factories([profile]);
      const { info } = createRegistry(env, '/data', f);
      expect(info, JSON.stringify(env)).toMatchObject({
        mode: 'local',
        publisher: 'local',
        trustedOwners: ['local'],
        ready: true,
      });
      expect(made[0]!.opts).toMatchObject({ publisher: 'local' });
    }
  });

  it('rejects bad configuration', () => {
    const { f } = factories([profile]);
    expect(() => createRegistry({ IGRIS_REGISTRY: 'ipfs' }, '/d', f)).toThrow();
    expect(() => createRegistry({ ARKIV_EXPIRY_DAYS: '0' }, '/d', f)).toThrow();
    expect(() => createRegistry({ IGRIS_TRUSTED_SCANNERS: 'bob' }, '/d', f)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Abuse controls and config
// ---------------------------------------------------------------------------

describe('config', () => {
  it('rejects wildcard CORS and bad limits', () => {
    expect(() => loadConfig({ IGRIS_ALLOWED_ORIGINS: '*' })).toThrow();
    expect(() => loadConfig({ IGRIS_ALLOWED_ORIGINS: 'https://a.org/path' })).toThrow();
    expect(() => loadConfig({ IGRIS_CONCURRENCY: '0' })).toThrow();
    expect(() => loadConfig({ IGRIS_ALLOWED_PORTS: '80,abc' })).toThrow();
  });

  it('IGRIS_CHROMIUM_SANDBOX: 1 = on, 0 or unset = off, anything else is refused', () => {
    expect(loadConfig({}).chromiumSandbox).toBe(false);
    expect(loadConfig({ IGRIS_CHROMIUM_SANDBOX: '' }).chromiumSandbox).toBe(false);
    expect(loadConfig({ IGRIS_CHROMIUM_SANDBOX: '0' }).chromiumSandbox).toBe(false);
    expect(loadConfig({ IGRIS_CHROMIUM_SANDBOX: '1' }).chromiumSandbox).toBe(true);
    for (const v of ['true', 'yes', '2', 'on']) {
      expect(() => loadConfig({ IGRIS_CHROMIUM_SANDBOX: v }), v).toThrow(/IGRIS_CHROMIUM_SANDBOX/);
    }
  });

  it('the sandbox setting reaches every scan; unset, the option is not passed at all', async () => {
    const on = fakeScan([result()]);
    const a = await start({ scan: on.fn, cfg: { chromiumSandbox: true } });
    await a.waitDone((await a.post(`/api/sites/${HOST}/scans`)).body.id as string);
    expect(on.calls[0]!.chromiumSandbox).toBe(true);
    const off = fakeScan([result()]);
    const b = await start({ scan: off.fn });
    await b.waitDone((await b.post(`/api/sites/${HOST}/scans`)).body.id as string);
    expect(off.calls[0]!).not.toHaveProperty('chromiumSandbox');
  });
});

describe('JobQueue', () => {
  it('runs at most `concurrency` jobs and rejects beyond the queue bound', async () => {
    const q = new JobQueue(1, 1, 10_000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = q.run(() => gate.then(() => 'a'));
    const b = q.run(async () => 'b');
    await expect(q.run(async () => 'c')).rejects.toBeInstanceOf(QueueFullError);
    expect(q.stats).toEqual({ running: 1, queued: 1 });
    release();
    expect(await a).toBe('a');
    expect(await b).toBe('b');
  });

  it('times out, aborts the job, and holds the slot until the job settles', async () => {
    const q = new JobQueue(1, 5, 50);
    let sawAbort = false;
    let finish!: () => void;
    const stuck = q.run(
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => (sawAbort = true));
          finish = resolve;
        }),
    );
    await expect(stuck).rejects.toBeInstanceOf(JobTimeoutError);
    expect(sawAbort).toBe(true);
    expect(q.stats.running).toBe(1);
    finish();
    await new Promise((r) => setTimeout(r, 10));
    expect(q.stats.running).toBe(0);
  });
});

describe('RateLimiter', () => {
  it('fixed window per client, resets after the window', () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    expect([rl.take('a'), rl.take('a'), rl.take('a')]).toEqual([true, true, false]);
    expect(rl.take('b')).toBe(true);
    t = 1000;
    expect(rl.take('a')).toBe(true);
  });
});

describe('integration: the real LocalSiteRegistry', () => {
  it('scan, retest, history, verified versions with real diffVersions, recipient flows', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'igris-api-local-'));
    const registry = new LocalSiteRegistry({
      file: join(dataDir, 'registry.json'),
      publisher: 'local',
    });
    const r1 = result('2026-11-06T00:00:00.000Z');
    const r2 = result('2026-11-06T01:00:00.000Z');
    const { get, post, waitDone } = await start({
      registry,
      dataDir,
      diff: diffVersions,
      info: {
        ...READY,
        mode: 'local',
        publisher: 'local',
        network: 'local',
        trustedOwners: ['local'],
      },
      scan: fakeScan([r1, r2]).fn,
    });
    const j1 = await waitDone((await post(`/api/sites/${HOST}/scans`)).body.id as string);
    expect(j1).toMatchObject({
      state: 'completed',
      version: 1,
      publish: { ok: true, mode: 'local' },
    });
    const j2 = await waitDone((await post(`/api/sites/${HOST}/scans`)).body.id as string);
    expect(j2).toMatchObject({ state: 'completed', version: 2, publish: { ok: true } });

    const site = await get(`/api/sites/${HOST}`);
    const versions = site.body.versions as PublishedScan[];
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]!.previous).toBe(versions[1]!.key);

    const v2 = await get(`/api/sites/${HOST}/versions/2`);
    expect(v2.status).toBe(200);
    expect(v2.body).toMatchObject({ verified: true, problems: [], source: 'local' });
    expect(v2.body.changes).toEqual(diffVersions(r1.report, r2.report));
    expect((v2.body.changes as Changes).sameBehaviour).toBe(true);
    expect(v2.body.summary).toEqual(summarise(r2.report, r2.bundle));

    const sites = await get('/api/sites');
    expect((sites.body.sites as PublishedScan[]).map((s) => s.version)).toEqual([2]);
    const recipient = r2.report.recipients[0]!.registrableDomain;
    const flows = (await get(`/api/recipients/${recipient}`)).body.flows as FlowEntity[];
    expect(flows.some((f) => f.hostname === HOST)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regressions (reviewed defects)
// ---------------------------------------------------------------------------

/** A job record as the previous process left it (interrupted while publishing). */
function writeInterruptedPublish(dataDir: string, id: string, scanId: string): void {
  mkdirSync(join(dataDir, 'jobs'), { recursive: true });
  const job: Job = {
    id,
    hostname: HOST,
    url: `https://${HOST}/`,
    state: 'running',
    createdAt: '2026-11-06T00:00:00.000Z',
    events: [],
    version: null,
    publish: null,
  };
  writeFileSync(join(dataDir, 'jobs', `${id}.json`), JSON.stringify({ job, scanId }));
}

describe('retry publish never publishes a scan twice (findByScanId)', () => {
  it('a publish that landed but reported failure is adopted on retry, not re-published', async () => {
    const registry = new FakeRegistry();
    registry.failAfterPublish = new Error('arkiv: request timed out');
    const { post, get, waitDone } = await start({ registry });
    const id = (await post(`/api/sites/${HOST}/scans`)).body.id as string;
    expect(await waitDone(id)).toMatchObject({ version: null, publish: { ok: false } });
    expect(registry.scans).toHaveLength(1); // it did land
    registry.failAfterPublish = null;
    const calls = registry.publishCalls;

    const retry = await post(`/api/scans/${id}/publish`);
    expect(retry.status).toBe(200);
    expect(retry.body.publish).toEqual({ ok: true, mode: 'arkiv', scanKey: '0xkey1' });
    expect(registry.publishCalls).toBe(calls); // adopted: publish() never called again
    expect(registry.scans).toHaveLength(1);
    expect(registry.findCalls.at(-1)).toEqual([HOST, registry.scans[0]!.scanId]);
    expect((await get(`/api/scans/${id}`)).body.scan).toMatchObject({ version: 1 });
  });

  it('when the registry cannot be asked, nothing is published blind', async () => {
    const registry = new FakeRegistry();
    registry.failPublish = new Error('arkiv down');
    const { post, waitDone } = await start({ registry });
    const id = (await post(`/api/sites/${HOST}/scans`)).body.id as string;
    await waitDone(id);
    registry.failPublish = null;
    registry.failFind = new Error('rpc timeout');
    const calls = registry.publishCalls;
    const retry = await post(`/api/scans/${id}/publish`);
    expect(retry.body.publish).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /could not check whether this scan is already published.*rpc timeout/,
      ),
    });
    expect(registry.publishCalls).toBe(calls);
  });

  it('after a restart, a job cut short while publishing adopts the version that landed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'igris-api-'));
    const r = result();
    const scanId = writeCachedScan(dataDir, r.report, r.bundle);
    const registry = new FakeRegistry();
    await registry.publish(r.report, r.bundle); // landed before the crash
    const id = '33333333-3333-4333-8333-333333333333';
    writeInterruptedPublish(dataDir, id, scanId);

    const { get, post } = await start({ registry, dataDir });
    expect((await get(`/api/scans/${id}`)).body.scan).toMatchObject({
      state: 'completed',
      version: 1,
      publish: { ok: true, mode: 'arkiv', scanKey: '0xkey1' },
    });
    expect((await post(`/api/scans/${id}/publish`)).status).toBe(409); // already published
    expect(registry.publishCalls).toBe(1);
    expect(registry.scans).toHaveLength(1);
  });
});

describe('retry publish never puts an older scan over a newer version', () => {
  it('409 when a later job of the hostname is already published; the job keeps ok:false with why', async () => {
    const registry = new FakeRegistry();
    registry.failPublish = new Error('arkiv down');
    const { post, get, waitDone } = await start({
      registry,
      scan: fakeScan([result('2026-11-06T00:00:00.000Z'), result('2026-11-06T01:00:00.000Z')]).fn,
    });
    const old = (await post(`/api/sites/${HOST}/scans`)).body.id as string;
    await waitDone(old);
    registry.failPublish = null;
    const newer = (await post(`/api/sites/${HOST}/scans`)).body.id as string;
    expect(await waitDone(newer)).toMatchObject({ version: 1, publish: { ok: true } });

    const retry = await post(`/api/scans/${old}/publish`);
    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatch(/newer scan .* already published as v1/);
    const job = (await get(`/api/scans/${old}`)).body.scan as Job;
    expect(job.publish).toMatchObject({ ok: false, error: retry.body.error });
    expect(job.version).toBeNull();
    expect(registry.scans).toHaveLength(1);
  });

  it("409 when the registry's latest version was scanned at or after the cached scan", async () => {
    const registry = new FakeRegistry();
    registry.failPublish = new Error('arkiv down');
    const { post, waitDone } = await start({ registry });
    const id = (await post(`/api/sites/${HOST}/scans`)).body.id as string;
    await waitDone(id);
    registry.failPublish = null;
    // Another trusted scanner published a later scan meanwhile.
    const later = result('2026-11-06T05:00:00.000Z');
    await registry.publish(later.report, later.bundle);
    const calls = registry.publishCalls;

    const retry = await post(`/api/scans/${id}/publish`);
    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatch(/v1 was scanned at or after this scan/);
    expect(registry.publishCalls).toBe(calls);
  });
});

describe('versions route: changes only against the verified previous entity (byKey)', () => {
  async function twoVersions() {
    const h = await start({
      scan: fakeScan([result('2026-11-06T00:00:00.000Z'), result('2026-11-06T01:00:00.000Z')]).fn,
    });
    await h.waitDone((await h.post(`/api/sites/${HOST}/scans`)).body.id as string);
    await h.waitDone((await h.post(`/api/sites/${HOST}/scans`)).body.id as string);
    return h;
  }

  it('follows scan.previous via byKey', async () => {
    diffCalls.length = 0;
    const { get, registry } = await twoVersions();
    const v2 = await get(`/api/sites/${HOST}/versions/2`);
    expect(v2.body.changes).not.toBeNull();
    expect(registry.byKeyCalls).toEqual(['0xkey1']);
    expect(diffCalls).toHaveLength(1);
  });

  it('an unverified previous version → changes null with the reason in problems', async () => {
    diffCalls.length = 0;
    const { get, registry } = await twoVersions();
    const p = registry.payloads.get('0xkey1')!;
    p.report = { ...p.report, scan: { ...p.report.scan, scannedAt: '2020-01-01T00:00:00.000Z' } };
    const v2 = await get(`/api/sites/${HOST}/versions/2`);
    expect(v2.status).toBe(200);
    expect(v2.body.changes).toBeNull();
    expect(v2.body.verified).toBe(true); // v2 itself is fine
    expect(v2.body.problems).toEqual([
      expect.stringMatching(
        /^changes not shown: previous version v1 could not be verified: .*scanId mismatch/,
      ),
    ]);
    expect(diffCalls).toHaveLength(0);
  });

  it('a previous pointer that resolves to nothing (or to another entity) → no changes', async () => {
    diffCalls.length = 0;
    const { get, registry } = await twoVersions();
    registry.scans[1]!.previous = '0xmissing';
    const missing = await get(`/api/sites/${HOST}/versions/2`);
    expect(missing.body.changes).toBeNull();
    expect((missing.body.problems as string[])[0]).toMatch(/v1 could not be verified: .*not found/);
    // Points at v2 itself (not version n − 1): never diffed against it.
    registry.scans[1]!.previous = '0xkey2';
    const wrong = await get(`/api/sites/${HOST}/versions/2`);
    expect(wrong.body.changes).toBeNull();
    expect((wrong.body.problems as string[])[0]).toMatch(/is not app\.example\.org v1/);
    expect(diffCalls).toHaveLength(0);
  });
});

describe('GET /api/scans/:id/report (a scan viewable whatever its publish state)', () => {
  it('200 from the verified local cache for a completed scan whose publish failed', async () => {
    const registry = new FakeRegistry();
    registry.failPublish = new Error('arkiv down');
    const r = result();
    const { get, post, waitDone } = await start({ registry, scan: fakeScan([r]).fn });
    const id = (await post(`/api/sites/${HOST}/scans`)).body.id as string;
    await waitDone(id);
    const rep = await get(`/api/scans/${id}/report`);
    expect(rep.status).toBe(200);
    expect(Object.keys(rep.body).sort()).toEqual(
      ['evidence', 'problems', 'report', 'source', 'summary', 'verified'].sort(),
    );
    expect(rep.body).toMatchObject({ verified: true, problems: [], source: 'local' });
    expect(contentHash(rep.body.report)).toBe(contentHash(r.report));
    expect(bundleHash(rep.body.evidence as EvidenceBundle)).toBe(r.report.evidence.sha256);
    expect(rep.body.summary).toEqual(summarise(r.report, r.bundle));
  });

  it('re-verifies on every read: a tampered cache is served as unverified with the problems', async () => {
    const r = result();
    const { get, post, waitDone, dataDir } = await start({ scan: fakeScan([r]).fn });
    const id = (await post(`/api/sites/${HOST}/scans`)).body.id as string;
    await waitDone(id);
    const file = join(dataDir, 'cache', contentHash(r.report), 'report.json');
    const tampered = { ...r.report, scan: { ...r.report.scan, notes: ['edited on disk'] } };
    writeFileSync(file, JSON.stringify(tampered));
    const rep = await get(`/api/scans/${id}/report`);
    expect(rep.status).toBe(200);
    expect(rep.body.verified).toBe(false);
    expect(rep.body.problems).toContain('report hash does not match scanId');
  });

  it('404 unknown job or nothing cached; 409 when the job is not completed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { get, post, waitDone, dataDir } = await start({ scan: fakeScan([result()], gate).fn });
    expect((await get('/api/scans/nope/report')).status).toBe(404);
    expect((await get('/api/scans/00000000-0000-4000-8000-000000000000/report')).status).toBe(404);
    const id = (await post(`/api/sites/${HOST}/scans`)).body.id as string;
    const running = await get(`/api/scans/${id}/report`);
    expect(running.status).toBe(409);
    expect(running.body.error).toMatch(/queued|running/);
    release();
    await waitDone(id);
    expect((await get(`/api/scans/${id}/report`)).status).toBe(200);
    rmSync(join(dataDir, 'cache'), { recursive: true });
    expect((await get(`/api/scans/${id}/report`)).status).toBe(404);
  });

  it('409 for a failed scan (nothing observed is not a report)', async () => {
    const failed = result('2026-11-06T00:00:00.000Z', {
      status: 'page-load-failed',
      failure: { category: 'site-unavailable', detail: 'net::ERR_NAME_NOT_RESOLVED' },
    });
    const { get, post, waitDone } = await start({ scan: fakeScan([failed]).fn });
    const id = (await post(`/api/sites/${HOST}/scans`)).body.id as string;
    await waitDone(id);
    expect((await get(`/api/scans/${id}/report`)).status).toBe(409);
  });
});

describe('GET /api/registry probes the live registry (arkiv), bounded and cached', () => {
  it('merges the probe into ready/reason and reuses it for the ttl', async () => {
    const registry = new FakeRegistry();
    registry.statusImpl = async () => ({ ready: false, reason: 'Arkiv query failed: 503' });
    let t = 0;
    const { get } = await start({ registry, probe: { now: () => t } });
    const a = await get('/api/registry');
    expect(a.body).toEqual(
      publicView({ ...READY, ready: false, reason: 'Arkiv query failed: 503' }),
    );
    t = 29_000;
    await get('/api/registry');
    expect(registry.statusCalls).toBe(1); // cached
    registry.statusImpl = async () => ({ ready: true });
    t = 31_000;
    expect((await get('/api/registry')).body).toEqual(publicView(READY));
    expect(registry.statusCalls).toBe(2);
  });

  it('a configured problem (no key) wins over a healthy node', async () => {
    const info: RegistryInfo = {
      ...READY,
      publisher: null,
      ready: false,
      reason: 'no scanner key',
    };
    const { get } = await start({ info });
    expect((await get('/api/registry')).body).toEqual(publicView(info));
  });

  it('a node that never answers → not ready after the timeout; concurrent requests share one probe', async () => {
    const registry = new FakeRegistry();
    registry.statusImpl = () => new Promise(() => {});
    const { get } = await start({ registry, probe: { timeoutMs: 30 } });
    const [a, b] = await Promise.all([get('/api/registry'), get('/api/registry')]);
    for (const r of [a, b]) {
      expect(r.body).toMatchObject({
        ready: false,
        reason: expect.stringMatching(/did not answer/),
      });
    }
    expect(registry.statusCalls).toBe(1);
  });

  it('local mode is not probed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'igris-api-local-'));
    const registry = new LocalSiteRegistry({ file: join(dataDir, 'r.json'), publisher: 'local' });
    const info: RegistryInfo = {
      mode: 'local',
      publisher: 'local',
      network: 'local',
      trustedOwners: ['local'],
      ready: true,
    };
    const { get } = await start({ registry, info, dataDir });
    expect((await get('/api/registry')).body).toEqual(publicView(info));
  });
});

describe('rate-limit identity behind a proxy (IGRIS_TRUST_PROXY hops)', () => {
  it('a client cannot rotate the first X-Forwarded-For hop to escape the limit', async () => {
    const { post } = await start({ cfg: { rateLimitMax: 2, trustProxy: 1 } });
    const xff = (first: string, last: string) => ({ 'x-forwarded-for': `${first}, ${last}` });
    await post('/api/sites/a.example.org/scans', {}, xff('1.1.1.1', '203.0.113.7'));
    await post('/api/sites/b.example.org/scans', {}, xff('2.2.2.2', '203.0.113.7'));
    const third = await post('/api/sites/c.example.org/scans', {}, xff('3.3.3.3', '203.0.113.7'));
    expect(third.status).toBe(429);
    // A different client (as seen by our proxy) has its own budget.
    const other = await post('/api/sites/d.example.org/scans', {}, xff('1.1.1.1', '203.0.113.8'));
    expect(other.status).not.toBe(429);
  });

  it('without trust proxy the header is ignored entirely', async () => {
    const { post } = await start({ cfg: { rateLimitMax: 1 } });
    await post('/api/sites/a.example.org/scans', {}, { 'x-forwarded-for': '1.1.1.1' });
    const b = await post('/api/sites/b.example.org/scans', {}, { 'x-forwarded-for': '2.2.2.2' });
    expect(b.status).toBe(429);
  });

  it('IGRIS_TRUST_PROXY is a hop count', () => {
    expect(loadConfig({}).trustProxy).toBe(0);
    expect(loadConfig({ IGRIS_TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ IGRIS_TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(() => loadConfig({ IGRIS_TRUST_PROXY: 'true' })).toThrow();
    expect(() => loadConfig({ IGRIS_TRUST_PROXY: '-1' })).toThrow();
  });
});

describe('versions route: verified-load LRU and read rate limit', () => {
  it('a verified version is loaded from the registry once; an unverified one every time', async () => {
    const { get, post, waitDone, registry } = await start();
    await waitDone((await post(`/api/sites/${HOST}/scans`)).body.id as string);
    const before = registry.loads;
    await get(`/api/sites/${HOST}/versions/1`);
    await get(`/api/sites/${HOST}/versions/1`);
    expect(registry.loads - before).toBe(1);

    const r2 = result('2026-11-06T02:00:00.000Z');
    await registry.publish(r2.report, r2.bundle);
    const p = registry.payloads.get('0xkey2')!;
    p.report = { ...p.report, scan: { ...p.report.scan, notes: ['tampered'] } };
    const mid = registry.loads;
    expect((await get(`/api/sites/${HOST}/versions/2`)).body.verified).toBe(false);
    expect((await get(`/api/sites/${HOST}/versions/2`)).body.verified).toBe(false);
    // v2 twice (never cached) + v1 once as its previous (cached above → 0).
    expect(registry.loads - mid).toBe(2);
  });

  it('LRU evicts the least recently used entry', () => {
    const lru = new Lru<number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1); // a is now most recent
    lru.set('c', 3);
    expect(lru.get('b')).toBeUndefined();
    expect([lru.get('a'), lru.get('c'), lru.size]).toEqual([1, 3, 2]);
  });

  it('expensive reads are rate limited (429)', async () => {
    const { get, post, waitDone } = await start({ cfg: { readRateLimitMax: 2 } });
    const id = (await post(`/api/sites/${HOST}/scans`)).body.id as string;
    await waitDone(id);
    expect((await get(`/api/sites/${HOST}/versions/1`)).status).toBe(200);
    expect((await get(`/api/scans/${id}/report`)).status).toBe(200);
    expect((await get(`/api/sites/${HOST}/versions/1`)).status).toBe(429);
    expect((await get(`/api/scans/${id}/report`)).status).toBe(429);
    // A site read lists a site's whole history: an expensive read too.
    expect((await get(`/api/sites/${HOST}`)).status).toBe(429);
    expect((await get('/api/sites')).status).toBe(200); // cheap reads unaffected
    expect((await get('/api/health')).status).toBe(200);
  });
});

describe('scan hostnames must be publishable (isHostname)', () => {
  it('400 for a valid DNS name the registry cannot store; the scanner never runs', async () => {
    const { fn, calls } = fakeScan([result()]);
    const { post } = await start({ scan: fn });
    const long = `${'a'.repeat(60)}.${'b'.repeat(60)}.example.org`; // 133 chars, labels ≤ 63
    expect(validateHostname(long)).toBe(long);
    const r = await post(`/api/sites/${long}/scans`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/cannot be published/);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Single node: a scan is a local job; nothing is requested from other nodes
// ---------------------------------------------------------------------------

/** A 20-byte address on its own (not the prefix of a 32-byte entity key). */
const ADDRESS_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;

function expectNoAddressIn(lines: string[]): void {
  for (const l of lines) expect(l, l).not.toMatch(ADDRESS_RE);
}

/** This node (PUBLISHER) plus another trusted scanner key (IGRIS_TRUSTED_SCANNERS). */
const TWO_TRUSTED: RegistryInfo = { ...READY, trustedOwners: [OTHER, PUBLISHER] };

describe('POST /api/sites/:hostname/scans (single node)', () => {
  it('202 { id } only; the job publishes the next version; the site read is { hostname, versions, scanning }', async () => {
    const { post, get, waitDone, registry } = await start();
    const a = await post(`/api/sites/${HOST}/scans`, { url: `https://${HOST}/swap` });
    expect(a.status).toBe(202);
    expect(Object.keys(a.body)).toEqual(['id']);
    const job = await waitDone(a.body.id as string);
    expect(job).toMatchObject({ state: 'completed', version: 1, publish: { ok: true } });
    expect(job).not.toHaveProperty('request');
    expect(registry.publishCalls).toBe(1);
    const site = await get(`/api/sites/${HOST}`);
    expect(Object.keys(site.body).sort()).toEqual(['hostname', 'scanning', 'versions']);
    for (const v of site.body.versions as Array<Record<string, unknown>>) {
      expect(v).not.toHaveProperty('owner');
      expect(v).not.toHaveProperty('request');
    }
    const v1 = await get(`/api/sites/${HOST}/versions/1`);
    expect(v1.status).toBe(200);
    expect(v1.body).not.toHaveProperty('node');
    expect(v1.body.scan).not.toHaveProperty('owner');
  });

  it('one version sequence across trusted keys: changes are shown against the v(n−1) of another key', async () => {
    diffCalls.length = 0;
    const h = await start({ info: TWO_TRUSTED });
    const x = result('2026-11-06T00:00:00.000Z');
    const y = result('2026-11-06T00:10:00.000Z');
    await h.registry.publishAs(OTHER, x.report, x.bundle);
    await h.registry.publishAs(PUBLISHER, y.report, y.bundle);
    const v2 = await h.get(`/api/sites/${HOST}/versions/2`);
    expect(v2.body).toMatchObject({ problems: [] });
    expect(v2.body.changes).not.toBeNull();
    expect(diffCalls).toHaveLength(1);
  });
});

describe('job records of an earlier release', () => {
  it('load whether or not they carry a request; responses never include it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'igris-api-'));
    mkdirSync(join(dataDir, 'jobs'), { recursive: true });
    const legacy = (id: string, extra: object) => ({
      id,
      hostname: HOST,
      url: `https://${HOST}/`,
      state: 'failed',
      createdAt: '2026-11-06T00:00:00.000Z',
      error: 'boom',
      events: [],
      version: null,
      publish: null,
      ...extra,
    });
    const without = '44444444-4444-4444-8444-444444444444';
    const withKey = '77777777-7777-4777-8777-777777777777';
    writeFileSync(
      join(dataDir, 'jobs', `${without}.json`),
      JSON.stringify({ job: legacy(without, {}), scanId: null }),
    );
    writeFileSync(
      join(dataDir, 'jobs', `${withKey}.json`),
      JSON.stringify({
        job: legacy(withKey, { request: entityKey(1) }),
        scanId: null,
        unclaimed: entityKey(2),
      }),
    );
    const { get } = await start({ dataDir });
    for (const id of [without, withKey]) {
      const scan = (await get(`/api/scans/${id}`)).body.scan as Record<string, unknown>;
      expect(scan).toMatchObject({ id, state: 'failed', error: 'boom' });
      expect(scan).not.toHaveProperty('request');
    }
  });
});

describe('GET /api/wallet-requests', () => {
  const row = (over: Partial<WalletRequestEntity> = {}): WalletRequestEntity => ({
    key: entityKey(500),
    owner: PUBLISHER,
    hostname: HOST,
    kind: 'permit2',
    method: 'eth_signTypedData_v4',
    outcome: 'signed',
    unlimited: true,
    chainIdMismatch: false,
    domainMismatch: false,
    preConnect: false,
    verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    spender: '0x00000000000000000000000000000000DeaDBeef',
    version: 1,
    scanId: 'a'.repeat(64),
    scannedAt: 1_800_000_000,
    ...over,
  });

  it('proxies registry.walletRequests with validated filters; no signer address', async () => {
    const registry = new FakeRegistry();
    registry.walletRows = [row(), row({ key: entityKey(501), kind: 'eth-sign', unlimited: false })];
    const { get } = await start({ registry });
    const all = await get('/api/wallet-requests');
    expect(all.status).toBe(200);
    expect(registry.walletCalls.at(-1)).toEqual({ limit: 50 });
    const { owner: _o, ...expected } = row();
    expect((all.body.requests as unknown[])[0]).toEqual(expected);
    expect(all.body.requests as unknown[]).toHaveLength(2);

    const f = await get(
      `/api/wallet-requests?kind=permit2&unlimited=true&hostname=App.Example.ORG&limit=10`,
    );
    expect(registry.walletCalls.at(-1)).toEqual({
      limit: 10,
      kind: 'permit2',
      unlimited: true,
      hostname: HOST,
    });
    expect((f.body.requests as Array<{ kind: string }>).map((x) => x.kind)).toEqual(['permit2']);
    expect((await get('/api/wallet-requests?unlimited=false&kind=')).status).toBe(200);
    expect(registry.walletCalls.at(-1)).toEqual({ limit: 50, unlimited: false });
  });

  it('400 on bad filters (the registry is never asked)', async () => {
    const registry = new FakeRegistry();
    const { get } = await start({ registry });
    for (const q of [
      'kind=connect',
      'kind=bogus',
      'kind=permit&kind=permit2',
      'unlimited=yes',
      'unlimited=1',
      'hostname=127.0.0.1',
      'hostname=localhost',
      `hostname=${'a'.repeat(60)}.${'b'.repeat(60)}.example.org`,
      'limit=0',
      'limit=101',
      'limit=abc',
    ]) {
      expect((await get(`/api/wallet-requests?${q}`)).status, q).toBe(400);
    }
    expect(registry.walletCalls).toHaveLength(0);
  });

  it('registry failure → 502', async () => {
    const registry = new FakeRegistry();
    registry.failReads = new Error('arkiv rpc down');
    const { get } = await start({ registry });
    expect((await get('/api/wallet-requests')).status).toBe(502);
  });
});

describe('integration: history published earlier by another key (real LocalSiteRegistry)', () => {
  it('a retest here becomes the next version, linked to and diffed against it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'igris-api-trusted-'));
    const file = join(dataDir, 'registry.json');
    const trustedOwners = ['local', 'earlier-key'];
    const earlier = new LocalSiteRegistry({ file, publisher: 'earlier-key', trustedOwners });
    const here = new LocalSiteRegistry({ file, publisher: 'local', trustedOwners });
    const r1 = result('2026-11-06T00:00:00.000Z');
    const v1 = (await earlier.publish(r1.report, r1.bundle)).scan;
    const r2 = result('2026-11-06T00:05:00.000Z');
    const h = await start({
      registry: here,
      dataDir,
      diff: diffVersions,
      info: { ...READY, mode: 'local', publisher: 'local', network: 'local', trustedOwners },
      scan: fakeScan([r2]).fn,
    });
    const job = await h.waitDone((await h.post(`/api/sites/${HOST}/scans`)).body.id as string);
    expect(job).toMatchObject({ version: 2, publish: { ok: true, mode: 'local' } });
    const versions = (await h.get(`/api/sites/${HOST}`)).body.versions as PublishedScan[];
    expect(versions.map((v) => [v.version, v.previous])).toEqual([
      [2, v1.key],
      [1, null],
    ]);
    const v2 = await h.get(`/api/sites/${HOST}/versions/2`);
    expect(v2.body).toMatchObject({ verified: true, problems: [] });
    expect(v2.body.changes).toEqual(diffVersions(r1.report, r2.report));
  });
});

// ---------------------------------------------------------------------------
// Regressions: wallet-request audit review
// ---------------------------------------------------------------------------
describe('regression: job errors and logs never carry an address (errText)', () => {
  const leak = `insufficient funds for gas * price + value: address ${PUBLISHER} have 0 want 1`;

  it('a publish failing with an address → GET /api/scans/:id, SSE done, retry and logs elide it', async () => {
    const registry = new FakeRegistry();
    registry.failPublish = new Error(leak);
    const logs: string[] = [];
    const { get, post, sse, waitDone } = await start({ registry, log: (m) => logs.push(m) });
    const id = (await post(`/api/sites/${HOST}/scans`)).body.id as string;
    const job = await waitDone(id);
    expect(job.publish).toMatchObject({ ok: false, error: expect.stringContaining('0x…') });

    const scan = JSON.stringify((await get(`/api/scans/${id}`)).body);
    expect(scan).toContain('insufficient funds');
    expect(scan).not.toMatch(ADDRESS_RE);
    const done = (await sse(id)).filter((e) => e.event === 'done');
    expect(done).toHaveLength(1);
    expect(JSON.stringify(done)).toContain('insufficient funds');
    expect(JSON.stringify(done)).not.toMatch(ADDRESS_RE);

    // Retry fails the same way; then the registry cannot even be asked.
    const retry = await post(`/api/scans/${id}/publish`);
    expect(retry.status).toBe(200);
    expect(JSON.stringify(retry.body)).toContain('insufficient funds');
    expect(JSON.stringify(retry.body)).not.toMatch(ADDRESS_RE);
    registry.failFind = new Error(leak);
    const retry2 = await post(`/api/scans/${id}/publish`);
    expect(JSON.stringify(retry2.body)).toMatch(/could not check whether.*insufficient funds/);
    expect(JSON.stringify(retry2.body)).not.toMatch(ADDRESS_RE);
    expectNoAddressIn(logs);
  });

  it('a scan that throws with an address, and the restart reconcile log, elide it too', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'igris-api-'));
    const r = result();
    const scanId = writeCachedScan(dataDir, r.report, r.bundle);
    writeInterruptedPublish(dataDir, '44444444-4444-4444-8444-444444444444', scanId);
    const registry = new FakeRegistry();
    registry.failFind = new Error(leak);
    const logs: string[] = [];
    const failing: ScanFn = async () => {
      throw new Error(`wallet ${OTHER} rejected`);
    };
    const { post, waitDone } = await start({
      registry,
      dataDir,
      scan: failing,
      log: (m) => logs.push(m),
    });
    expect(logs.join('\n')).toMatch(/could not check the registry after restart/);
    const id = (await post(`/api/sites/${HOST}/scans`)).body.id as string;
    const job = await waitDone(id);
    expect(job).toMatchObject({ state: 'failed', error: 'scan failed: wallet 0x… rejected' });
    expectNoAddressIn(logs);
  });
});

describe('regression: GET /api/sites/:hostname is an expensive read', () => {
  it('site reads are rate limited like other expensive reads', async () => {
    const { get } = await start({ cfg: { readRateLimitMax: 1 } });
    expect((await get(`/api/sites/${HOST}`)).status).toBe(200);
    expect((await get(`/api/sites/${HOST}`)).status).toBe(429);
  });
});

describe('regression: a draft 3.0.0 scan in the cache (before walletRequests)', () => {
  /** What a scan cached before walletRequests existed looks like on disk. */
  function writeDraft(dataDir: string, r: ScanResult) {
    const { walletRequests: _w, ...rest } = r.report;
    const bundle = { ...r.bundle, bundleVersion: EVIDENCE_BUNDLE_VERSION_V3 };
    const report = {
      ...rest,
      evidence: {
        ...rest.evidence,
        bundleVersion: EVIDENCE_BUNDLE_VERSION_V3,
        sha256: contentHash(bundle),
      },
    };
    const scanId = contentHash(report);
    const dir = join(dataDir, 'cache', scanId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(dir, 'evidence.json'), canonicalize(bundle));
    return { scanId, evidenceSha256: contentHash(bundle), dir, report };
  }

  it('readCachedScan verifies the stored files, then upgrades for display with a problem note', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'igris-api-'));
    const d = writeDraft(dataDir, result());
    const cached = readCachedScan(dataDir, d.scanId)!;
    expect(cached).not.toBeNull();
    expect(cached.draft).toEqual({ evidenceSha256: d.evidenceSha256 });
    expect(cached.problems).toEqual([DRAFT_NOTE]);
    expect(cached.report.walletRequests).toBeNull();
    expect(cached.bundle.bundleVersion).toBe(EVIDENCE_BUNDLE_VERSION);
    expect(verifyReportIntegrity(cached.report, cached.bundle).ok).toBe(true);

    // Edited on disk: the stored report no longer hashes to its key.
    writeFileSync(
      join(d.dir, 'report.json'),
      JSON.stringify({ ...d.report, scan: { ...d.report.scan, notes: ['edited'] } }),
    );
    expect(readCachedScan(dataDir, d.scanId)!.problems[0]).toMatch(/cached report hashes to/);
  });

  it('served by GET /api/scans/:id/report (unverified, with the note) and never published', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'igris-api-'));
    const d = writeDraft(dataDir, result());
    const id = '55555555-5555-4555-8555-555555555555';
    writeInterruptedPublish(dataDir, id, d.scanId);
    const { get, post, registry } = await start({ dataDir });
    const rep = await get(`/api/scans/${id}/report`);
    expect(rep.status).toBe(200);
    expect(rep.body.verified).toBe(false);
    expect(rep.body.problems).toEqual([DRAFT_NOTE]);
    expect((rep.body.report as ReportV3).walletRequests).toBeNull();
    const retry = await post(`/api/scans/${id}/publish`);
    expect(retry.body.publish).toMatchObject({
      ok: false,
      error: expect.stringMatching(/draft 3\.0\.0 report .*never published/),
    });
    expect(registry.publishCalls).toBe(0);
  });

  it("a published draft whose registry copy cannot be loaded is served from the cache against the entity's hashes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'igris-api-'));
    const r = result();
    const d = writeDraft(dataDir, r);
    const { get, registry } = await start({ dataDir });
    const published = (await registry.publish(r.report, r.bundle)).scan;
    registry.scans[0] = { ...published, scanId: d.scanId, evidenceSha256: d.evidenceSha256 };
    registry.failLoad.add(published.key);
    const v1 = await get(`/api/sites/${HOST}/versions/1`);
    expect(v1.status).toBe(200);
    expect(v1.body.source).toBe('local');
    const problems = v1.body.problems as string[];
    expect(problems).toContain(DRAFT_NOTE);
    expect(problems.join('\n')).not.toMatch(/does not match/);
    // An entity attesting other evidence does not match the stored draft.
    registry.scans[0] = { ...registry.scans[0]!, evidenceSha256: 'f'.repeat(64) };
    const bad = await get(`/api/sites/${HOST}/versions/1`);
    expect(bad.body.problems).toContain('evidence hash does not match evidenceSha256');
  });
});

// Runs last (vitest runs tests in file order): every JSON body any route returned.
describe('no score anywhere', () => {
  it('no response body has a "score" key at any depth', () => {
    expect(bodies.length).toBeGreaterThan(20);
    for (const b of bodies) assertNoScore(b);
  });
});

/**
 * Walk a response body; report and evidence payloads are the scan's own
 * content (they carry the canary wallet), and a wallet request's
 * verifyingContract / spender are what the site asked to sign for — every
 * other field must be free of addresses and signer keys.
 */
function assertNoAddress(v: unknown, path = '$'): void {
  if (Array.isArray(v)) v.forEach((x, i) => assertNoAddress(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'report' || k === 'evidence') continue;
      if (k === 'verifyingContract' || k === 'spender') continue;
      expect(['owner', 'creator', 'publisher', 'trustedOwners'], `${path}.${k}`).not.toContain(k);
      assertNoAddress(x, `${path}.${k}`);
    }
  } else if (typeof v === 'string') {
    expect(v, path).not.toMatch(ADDRESS_RE);
  }
}

describe('no signer address in any response', () => {
  it('outside report / evidence payloads, no body carries an address or an owner/creator field', () => {
    expect(bodies.length).toBeGreaterThan(50);
    for (const b of bodies) assertNoAddress(b);
  });
});
