/**
 * P0-5 browser-level proof: a hostile page scanned in public-only mode
 * cannot reach an internal server by ANY route — subresource, redirect,
 * iframe, fetch, beacon, WebSocket, a hostname that resolves to a private
 * address, or the cloud-metadata IP — and a scan target that is itself
 * internal never loads. The internal server counts every hit; it must stay 0.
 *
 * A control run of the same page WITHOUT the proxy proves the page really
 * does reach the internal server otherwise (so a 0 is meaningful).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import type { Report } from '@igris/core';
import { scan } from '../src/index.js';
import { HOST_RULES, PAGE_PORT } from './helpers.js';

const SECRET_PORT = PAGE_PORT + 20;
const TARGET_PORT = PAGE_PORT + 21;
const STUN_PORT = PAGE_PORT + 22;

let secret: Server;
let target: Server;
let secretHits: string[] = [];
let stun: UdpSocket;
let stunPackets = 0;

const HOSTILE_PAGE = `<!doctype html><title>hostile</title>
<img src="http://127.0.0.1:${SECRET_PORT}/img">
<img src="/redir">
<iframe src="http://internal.test:${SECRET_PORT}/iframe"></iframe>
<script>
  fetch('http://127.0.0.1:${SECRET_PORT}/fetch').catch(() => {});
  fetch('http://internal.test:${SECRET_PORT}/fetch-dns').catch(() => {});
  fetch('http://169.254.169.254/latest/meta-data/').catch(() => {});
  fetch('http://meta.test/latest/meta-data/').catch(() => {});
  try { new WebSocket('ws://127.0.0.1:${SECRET_PORT}/ws'); } catch (e) {}
  try { navigator.sendBeacon('http://127.0.0.1:${SECRET_PORT}/beacon', 'x'); } catch (e) {}
  // WebRTC: ICE gathering sends STUN binding requests over UDP straight to
  // the STUN server — a path an HTTP proxy never sees.
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${STUN_PORT}' }] });
    pc.createDataChannel('x');
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {});
  } catch (e) {}
</script>`;

/** Resolver used by the proxy: *.test names point at internal addresses. */
const fakeDns: Record<string, string[]> = {
  'target.test': ['127.0.0.1'],
  'internal.test': ['127.0.0.1'],
  'meta.test': ['169.254.169.254'],
};
const resolve = async (h: string) => {
  const ips = fakeDns[h];
  if (!ips) throw new Error('NXDOMAIN');
  return ips;
};

function publicOnlyScan(url: string, allowTarget: boolean): Promise<Report> {
  return scan({
    url,
    dwellMs: 1500,
    egress: {
      mode: 'public-only',
      resolve,
      // The scan target itself lives on loopback in this offline test, so it
      // is the ONE explicitly allowed (ip, port). The secret server is not.
      ...(allowTarget ? { allowAddresses: [{ ip: '127.0.0.1', port: TARGET_PORT }] } : {}),
    },
  });
}

beforeAll(async () => {
  secret = createServer((req, res) => {
    secretHits.push(req.url ?? '?');
    res.end('internal secret');
  });
  secret.on('upgrade', (req, socket) => {
    secretHits.push(`upgrade ${req.url}`);
    socket.destroy();
  });
  target = createServer((req, res) => {
    if (req.url === '/redir') {
      res.writeHead(302, { location: `http://127.0.0.1:${SECRET_PORT}/redirected` });
      return res.end();
    }
    if (req.url === '/go') {
      res.writeHead(302, { location: `http://127.0.0.1:${SECRET_PORT}/main-redirect` });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HOSTILE_PAGE);
  });
  await new Promise<void>((r) => secret.listen(SECRET_PORT, '127.0.0.1', () => r()));
  stun = createSocket('udp4');
  stun.on('message', () => {
    stunPackets += 1;
  });
  await new Promise<void>((r) => stun.bind(STUN_PORT, '127.0.0.1', () => r()));
  await new Promise<void>((r) => target.listen(TARGET_PORT, '127.0.0.1', () => r()));
});

afterAll(async () => {
  await new Promise((r) => secret.close(() => r(undefined)));
  await new Promise((r) => target.close(() => r(undefined)));
  await new Promise((r) => stun.close(() => r(undefined)));
});

beforeEach(() => {
  secretHits = [];
  stunPackets = 0;
});

describe('egress isolation (public-only)', () => {
  it('control: WITHOUT the proxy the hostile page reaches the internal server', async () => {
    await scan({
      url: `http://target.test:${TARGET_PORT}/`,
      hostResolverRules: HOST_RULES,
      dwellMs: 1500,
    });
    // Each route must independently reach the server, or "blocked" below
    // would prove nothing about it.
    for (const route of [
      '/img',
      '/redirected',
      '/iframe',
      '/fetch',
      '/fetch-dns',
      'upgrade /ws',
      '/beacon',
    ]) {
      expect(secretHits, `control route ${route}`).toContain(route);
    }
    expect(stunPackets, 'control route WebRTC/STUN (UDP)').toBeGreaterThan(0);
  });

  it('every route to the internal server is blocked; the target page itself still loads', async () => {
    const report = await publicOnlyScan(`http://target.test:${TARGET_PORT}/`, true);
    expect(secretHits).toEqual([]);
    expect(stunPackets, 'WebRTC/STUN UDP must not bypass the proxy').toBe(0);
    expect(report.status).not.toBe('page-load-failed');
    const blocked = report.errors.filter((e) => e.startsWith('egress blocked:'));
    expect(blocked.some((e) => e.includes(`127.0.0.1:${SECRET_PORT}`))).toBe(true);
    expect(blocked.some((e) => e.includes(`internal.test:${SECRET_PORT}`))).toBe(true);
    expect(blocked.some((e) => e.includes('169.254.169.254:80'))).toBe(true);
    expect(blocked.some((e) => e.includes('meta.test:80'))).toBe(true);
    // Refused requests never left the scanner: not third-party contacts.
    const hosts = report.thirdParties.map((t) => t.host);
    expect(hosts).not.toContain('internal.test');
    expect(hosts).not.toContain('169.254.169.254');
  });

  it('an internal scan target never loads (direct)', async () => {
    const report = await publicOnlyScan(`http://127.0.0.1:${SECRET_PORT}/`, false);
    expect(report.status).toBe('page-load-failed');
    expect(report.score).toBeNull();
    expect(secretHits).toEqual([]);
  });

  it('an internal scan target never loads (via a hostname that resolves privately)', async () => {
    const report = await publicOnlyScan(`http://internal.test:${SECRET_PORT}/`, false);
    expect(report.status).toBe('page-load-failed');
    expect(secretHits).toEqual([]);
  });

  it('a main-document redirect into the internal network is blocked', async () => {
    const report = await publicOnlyScan(`http://target.test:${TARGET_PORT}/go`, true);
    expect(report.status).toBe('page-load-failed');
    expect(secretHits).toEqual([]);
  });
});
