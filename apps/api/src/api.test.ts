/**
 * P0-6/7/8 tests for the optional hosted scanner API. The HTTP layer runs
 * for real (listen on an ephemeral port); scanning, patching and cloning are
 * injected fakes so these tests never launch a browser or touch the network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Report } from '@igris/core';
import type { ScanOptions } from '@igris/scanner';
import { isPublicAddress } from '@igris/scanner';
import { recordFromReport } from '@igris/registry';
import { createApp, validateScanUrl, type ApiDeps } from './app.js';
import { loadConfig, type ApiConfig } from './config.js';
import { JobQueue, JobTimeoutError, QueueFullError, RateLimiter } from './limits.js';
import {
  RepoRejectedError,
  buildCloneArgs,
  enforceRepoLimits,
  gitEnv,
  validateRepoUrl,
} from './repo.js';

const ORIGIN = 'http://localhost:5173';

function config(over: Partial<ApiConfig> = {}): ApiConfig {
  return { ...loadConfig({}), ...over };
}

function fakeReport(over: Partial<Report> = {}): Report {
  return {
    reportVersion: '1.1.0',
    scannerVersion: 'test',
    target: 'https://app.example.org/',
    hostname: 'app.example.org',
    scannedAt: '2026-11-06T00:00:00.000Z',
    chainId: 1,
    status: 'completed',
    coverage: 'full',
    canaryAddress: '0x8ba1f109551bd432803012645ac136ddd64dba72',
    spoofMetaMask: true,
    findings: [],
    thirdParties: [],
    readsViaWallet: [],
    usesAnonRpc: false,
    score: 100,
    ledger: [],
    errors: [],
    ...over,
  };
}

let server: Server | undefined;
afterEach(async () => {
  await new Promise((r) => (server ? server.close(() => r(undefined)) : r(undefined)));
  server = undefined;
});

async function start(cfg: ApiConfig, deps: Partial<ApiDeps> = {}) {
  const calls: ScanOptions[] = [];
  const app = createApp(cfg, {
    scan: async (o) => {
      calls.push(o);
      return fakeReport();
    },
    fix: () => ({ diff: '', changedFiles: [], notes: [] }),
    recordFromReport,
    isPublicAddress,
    log: () => {},
    ...deps,
  });
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { base, post, calls };
}

describe('validateScanUrl (fail-fast layer; the egress proxy is the real control)', () => {
  const ok = ['https://app.uniswap.org/', 'http://example.org/path?q=1', 'https://8.8.8.8/'];
  const bad = [
    'ftp://example.org/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pw@example.org/',
    'https://example.org:8443/',
    'http://localhost/',
    'http://foo.localhost/',
    'http://printer.local/',
    'http://metadata.google.internal/',
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'not a url',
    42,
  ];
  for (const u of ok)
    it(`accepts ${u}`, () =>
      expect(() => validateScanUrl(u, [80, 443], isPublicAddress)).not.toThrow());
  for (const u of bad)
    it(`rejects ${String(u)}`, () =>
      expect(() => validateScanUrl(u, [80, 443], isPublicAddress)).toThrow());
});

describe('POST /api/scan', () => {
  it('scans with egress forced to public-only and returns unpublished provenance (P0-8)', async () => {
    const { post, calls } = await start(config());
    const res = await post('/api/scan', {
      url: 'https://app.example.org/',
      egress: { mode: 'unrestricted' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.provenance).toBe('unpublished');
    expect(JSON.stringify(body)).not.toMatch(/"scanner"/); // never attributed to a key
    expect(calls[0]!.egress).toEqual({ mode: 'public-only', allowedPorts: [80, 443] });
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('an unmeasured scan has preview null (never publishable)', async () => {
    const { post } = await start(config(), {
      scan: async () => fakeReport({ status: 'page-load-failed', coverage: 'none', score: null }),
    });
    const body = (await (await post('/api/scan', { url: 'https://down.example.org/' })).json()) as {
      preview: unknown;
      report: Report;
    };
    expect(body.preview).toBeNull();
    expect(body.report.score).toBeNull();
  });

  it('400 on internal targets, 400 on malformed JSON, 413 on oversized bodies', async () => {
    const { post } = await start(config());
    expect((await post('/api/scan', { url: 'http://169.254.169.254/' })).status).toBe(400);
    expect((await post('/api/scan', '{not json')).status).toBe(400);
    expect(
      (await post('/api/scan', { url: 'https://a.org/', pad: 'x'.repeat(20_000) })).status,
    ).toBe(413);
  });

  it('rate limits per client (429)', async () => {
    const { post } = await start(config({ rateLimitMax: 2 }));
    expect((await post('/api/scan', { url: 'https://a.example.org/' })).status).toBe(200);
    expect((await post('/api/scan', { url: 'https://a.example.org/' })).status).toBe(200);
    expect((await post('/api/scan', { url: 'https://a.example.org/' })).status).toBe(429);
  });

  it('503 when the queue is full', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { post } = await start(config({ concurrency: 1, maxQueued: 0, rateLimitMax: 100 }), {
      scan: async () => {
        await gate;
        return fakeReport();
      },
    });
    const first = post('/api/scan', { url: 'https://a.example.org/' });
    await new Promise((r) => setTimeout(r, 50));
    expect((await post('/api/scan', { url: 'https://b.example.org/' })).status).toBe(503);
    release();
    expect((await first).status).toBe(200);
  });

  it('504 when a job exceeds the hard timeout, and the scan receives the abort', async () => {
    let aborted = false;
    // config() bypasses loadConfig's 5 s floor so the test stays fast.
    const { post } = await start(config({ jobTimeoutMs: 100 }), {
      scan: (o) =>
        new Promise((_, reject) => {
          o.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    });
    const res = await post('/api/scan', { url: 'https://slow.example.org/' });
    expect(res.status).toBe(504);
    expect(aborted).toBe(true);
  });

  it('CORS: only configured origins get an allow-origin header; never "*"', async () => {
    const { base } = await start(config());
    const good = await fetch(`${base}/api/health`, { headers: { origin: ORIGIN } });
    expect(good.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const evil = await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('the old in-memory registry endpoints are gone (no fabricated records)', async () => {
    const { base } = await start(config());
    expect((await fetch(`${base}/api/reports`)).status).toBe(404);
    expect((await fetch(`${base}/api/reports/scan-1`)).status).toBe(404);
  });
});

describe('config', () => {
  it('rejects wildcard CORS and bad limits', () => {
    expect(() => loadConfig({ IGRIS_ALLOWED_ORIGINS: '*' })).toThrow();
    expect(() => loadConfig({ IGRIS_ALLOWED_ORIGINS: 'https://a.org/path' })).toThrow();
    expect(() => loadConfig({ IGRIS_CONCURRENCY: '0' })).toThrow();
    expect(() => loadConfig({ IGRIS_ALLOWED_PORTS: '80,abc' })).toThrow();
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
    expect(q.stats.running).toBe(1); // still occupied: the job ignored the abort
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

describe('repo intake (P0-6)', () => {
  const ok: Array<[string, string]> = [
    ['https://github.com/org/dapp', 'https://github.com/org/dapp.git'],
    ['https://github.com/org/dapp.git', 'https://github.com/org/dapp.git'],
    ['https://github.com/o-1/my_repo.v2/', 'https://github.com/o-1/my_repo.v2.git'],
  ];
  for (const [input, out] of ok)
    it(`accepts ${input}`, () => expect(validateRepoUrl(input)).toBe(out));
  const bad = [
    'file:///etc/.git',
    '/srv/repo.git',
    '--upload-pack=touch /tmp/pwned;x.git',
    '-c core.sshCommand=x.git',
    'ext::sh -c touch% /tmp/pwned.git',
    'git@github.com:org/dapp.git',
    'ssh://git@github.com/org/dapp.git',
    'http://github.com/org/dapp',
    'https://github.com.evil.org/org/dapp',
    'https://evil.org/github.com/org/dapp.git',
    'https://user:token@github.com/org/dapp',
    'https://github.com:8443/org/dapp',
    'https://github.com/org/dapp/tree/main',
    'https://github.com/org/../dapp',
    'https://github.com/org/.hidden',
    'https://github.com/org/dapp?x=1',
    'https://github.com/org/dapp#x',
    'https://github.com/org/da%2epp',
    'https://github.com/org',
    '',
    null,
  ];
  for (const input of bad)
    it(`rejects ${String(input)}`, () =>
      expect(() => validateRepoUrl(input)).toThrow(RepoRejectedError));

  it('clone args: hardened config, URL only after "--"', () => {
    const args = buildCloneArgs('https://github.com/o/r.git', '/tmp/x');
    const dd = args.indexOf('--');
    expect(dd).toBeGreaterThan(-1);
    expect(args.slice(dd + 1)).toEqual(['https://github.com/o/r.git', '/tmp/x']);
    for (const c of [
      'protocol.allow=never',
      'protocol.https.allow=always',
      'core.symlinks=false',
      'core.hooksPath=/dev/null',
      'http.followRedirects=false',
    ])
      expect(args).toContain(c);
    expect(gitEnv('/tmp/h')).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
  });

  it('git itself refuses a non-https transport under these settings', async () => {
    const { execFile } = await import('node:child_process');
    const src = mkdtempSync(join(tmpdir(), 'igris-src-'));
    const dest = join(mkdtempSync(join(tmpdir(), 'igris-dst-')), 'r');
    const code = await new Promise<number>((r) =>
      execFile('git', buildCloneArgs(`file://${src}`, dest), { env: gitEnv(src) }, (err) =>
        r(err ? 1 : 0),
      ),
    );
    expect(code).toBe(1);
  });

  const limits = { maxBytes: 1000, maxFiles: 5, maxSourceFileBytes: 100 };

  it('size walk: passes a small repo and never follows symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'igris-walk-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;');
    // A symlink to a huge/secret target must neither be followed nor counted.
    symlinkSync('/etc', join(root, 'src/etc-link'));
    expect(enforceRepoLimits(root, limits)).toEqual({ bytes: 19, files: 1 });
  });

  it('size walk: rejects too many files, too many bytes, oversized source files', () => {
    const many = mkdtempSync(join(tmpdir(), 'igris-many-'));
    for (let i = 0; i < 6; i++) writeFileSync(join(many, `f${i}.txt`), 'x');
    expect(() => enforceRepoLimits(many, limits)).toThrow(/files/);

    const big = mkdtempSync(join(tmpdir(), 'igris-big-'));
    writeFileSync(join(big, 'blob.bin'), 'x'.repeat(1001));
    expect(() => enforceRepoLimits(big, limits)).toThrow(/bytes/);

    const src = mkdtempSync(join(tmpdir(), 'igris-src-'));
    writeFileSync(join(src, 'huge.ts'), 'x'.repeat(101));
    expect(() => enforceRepoLimits(src, limits)).toThrow(/source file/);
  });

  it('POST /api/scan-repo: 400 on a rejected URL, 422 when limits are exceeded', async () => {
    const { post } = await start(config(), {
      clone: async (_url, dest) => {
        mkdirSync(dest, { recursive: true });
        writeFileSync(join(dest, 'huge.ts'), 'x'.repeat(2 * 1024 * 1024));
      },
    });
    expect((await post('/api/scan-repo', { repoUrl: 'file:///etc/x.git' })).status).toBe(400);
    expect((await post('/api/scan-repo', { repoUrl: 'https://github.com/o/r' })).status).toBe(422);
  });
});
