/**
 * The website served by the API from the same origin (static.ts): index.html
 * and hashed assets with their cache headers and CSP, /api routes never
 * shadowed, and nothing outside the website directory reachable.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPublicAddress, scan } from '@igris/scanner';
import { LocalSiteRegistry, diffVersions } from '@igris/registry';
import { createApp } from './app.js';
import { DEFAULT_STATIC_DIR, loadConfig } from './config.js';
import { SiteScanService } from './jobs.js';
import { JobQueue } from './limits.js';
import { WEBSITE_CSP } from './static.js';

const INDEX = '<!doctype html><title>igris test site</title>';

let server: Server | undefined;
const dirs: string[] = [];
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'igris-static-'));
  dirs.push(d);
  return d;
}

/** A website dir inside a parent that also holds a file that must stay private. */
function website(): string {
  const parent = tempDir();
  writeFileSync(join(parent, 'secret.txt'), 'outside the website');
  const site = join(parent, 'site');
  mkdirSync(join(site, 'assets'), { recursive: true });
  writeFileSync(join(site, 'index.html'), INDEX);
  writeFileSync(join(site, 'assets', 'index-abc123.js'), 'console.log(1);');
  writeFileSync(join(site, '.hidden'), 'dotfile');
  return site;
}

async function start(staticDir: string | null) {
  const dataDir = tempDir();
  const registry = new LocalSiteRegistry({
    file: join(dataDir, 'registry.json'),
    publisher: 'local',
    trustedOwners: ['local'],
  });
  const config = { ...loadConfig({ IGRIS_STATIC_DIR: 'off' }), dataDir, staticDir };
  const app = createApp(config, {
    registry,
    registryInfo: {
      mode: 'local',
      publisher: 'local',
      network: 'local',
      trustedOwners: ['local'],
      ready: true,
    },
    jobs: new SiteScanService({
      dataDir,
      queue: new JobQueue(1, 1, 10_000),
      scan,
      registry,
      egress: { mode: 'public-only', allowedPorts: [80, 443] },
      dwellMs: 1000,
    }),
    isPublicAddress,
    diffVersions,
    log: () => {},
  });
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  return (server.address() as AddressInfo).port;
}

/** Raw GET: the path goes out exactly as given (fetch would normalise '..'). */
function rawGet(
  port: number,
  path: string,
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('website served from the same origin', () => {
  it('serves index.html at / with no-cache and a same-origin CSP', async () => {
    const port = await start(website());
    const r = await rawGet(port, '/');
    expect(r.status).toBe(200);
    expect(r.body).toBe(INDEX);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(r.headers['content-security-policy']).toBe(WEBSITE_CSP);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(WEBSITE_CSP).not.toMatch(/https?:|\*/);
  });

  it('serves hashed assets with a long immutable cache', async () => {
    const port = await start(website());
    const r = await rawGet(port, '/assets/index-abc123.js');
    expect(r.status).toBe(200);
    expect(r.body).toBe('console.log(1);');
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('never shadows the API: /api/health is still JSON, unknown /api paths 404 as JSON', async () => {
    const site = website();
    // A file that would collide with an API path if static serving came first.
    mkdirSync(join(site, 'api'));
    writeFileSync(join(site, 'api', 'health'), 'not the API');
    writeFileSync(join(site, 'api', 'other'), 'not the API');
    const port = await start(site);
    const health = await rawGet(port, '/api/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true });
    const other = await rawGet(port, '/api/other');
    expect(other.status).toBe(404);
    expect(JSON.parse(other.body)).toEqual({ error: 'not found' });
  });

  it('refuses path traversal, dotfiles and directory listings', async () => {
    const port = await start(website());
    for (const path of [
      '/../secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/.hidden',
    ]) {
      const r = await rawGet(port, path);
      expect(r.status, path).toBe(404);
      expect(r.body, path).not.toContain('outside the website');
      expect(r.body, path).not.toContain('dotfile');
    }
    const listing = await rawGet(port, '/assets/');
    expect(listing.status).toBe(404);
    expect(listing.body).not.toContain('index-abc123.js');
  });

  it('is off without a static dir: / is a JSON 404', async () => {
    const port = await start(null);
    const r = await rawGet(port, '/');
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'not found' });
  });
});

describe('IGRIS_STATIC_DIR', () => {
  it('"off" disables the website; a dir without index.html is refused', () => {
    expect(loadConfig({ IGRIS_STATIC_DIR: 'off' }).staticDir).toBeNull();
    expect(() => loadConfig({ IGRIS_STATIC_DIR: tempDir() })).toThrow(/index\.html/);
    const site = website();
    expect(loadConfig({ IGRIS_STATIC_DIR: site }).staticDir).toBe(site);
  });

  it('defaults to apps/app/dist of this checkout', () => {
    expect(DEFAULT_STATIC_DIR.replace(/\\/g, '/')).toMatch(/\/apps\/app\/dist$/);
  });
});

describe('blank values (a copied .env.example) mean "not set"', () => {
  it('loadConfig with every variable blank equals the defaults', () => {
    const blank = Object.fromEntries(
      [
        'PORT',
        'IGRIS_STATIC_DIR',
        'IGRIS_ALLOWED_ORIGINS',
        'IGRIS_TRUST_PROXY',
        'IGRIS_DATA_DIR',
        'IGRIS_CONCURRENCY',
        'IGRIS_MAX_QUEUED',
        'IGRIS_JOB_TIMEOUT_MS',
        'IGRIS_DWELL_MS',
        'IGRIS_ALLOWED_PORTS',
        'IGRIS_RATE_LIMIT_MAX',
        'IGRIS_READ_RATE_LIMIT_MAX',
        'IGRIS_RATE_LIMIT_WINDOW_MS',
        'IGRIS_WORKER',
        'IGRIS_WORKER_POLL_MS',
        'IGRIS_REQUEST_WINDOW_S',
        'IGRIS_REQUESTS_PER_CREATOR',
        'IGRIS_BLOCKED_REQUESTERS',
      ].map((k) => [k, '']),
    );
    expect(loadConfig(blank)).toEqual(loadConfig({}));
  });
});
