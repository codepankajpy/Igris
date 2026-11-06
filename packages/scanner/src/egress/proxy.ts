/**
 * Egress-filtering forward proxy for public-only scans (P0-5).
 *
 * Why a proxy and not a URL check: a scanned page controls everything that
 * happens after navigation — redirects, subresources, fetch/XHR from JS,
 * WebSockets, iframes — and a hostname can resolve to a private address
 * (or change its answer between a check and the browser's own lookup: DNS
 * rebinding). Checking the submitted URL protects none of that.
 *
 * Chromium is launched with this proxy for ALL traffic (loopback included,
 * via `<-loopback>`), so Chromium never resolves names or opens sockets
 * itself. For every CONNECT tunnel or absolute-form HTTP request the proxy:
 *   1. rejects ports outside the allowlist (before any DNS);
 *   2. resolves the hostname ONCE and keeps only public addresses
 *      (ip-policy.ts); none left → 403;
 *   3. connects to that exact checked IP — there is no second lookup, so
 *      there is no rebinding window.
 * It never follows redirects itself: the browser re-requests through the
 * proxy, so every hop is checked.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { Duplex } from 'node:stream';
import { classifyRefusal, isPublicAddress } from './ip-policy.js';

export type Resolver = (hostname: string) => Promise<string[]>;

export interface EgressProxyOptions {
  /** Ports the page may reach. Default [80, 443]. */
  allowedPorts?: number[];
  /**
   * Exact (ip, port) pairs allowed despite being non-public. For tests and
   * for operators who knowingly expose one internal target; never derived
   * from scan input.
   */
  allowAddresses?: Array<{ ip: string; port: number }>;
  /** DNS resolver (default: OS resolver, all addresses). Injected in tests. */
  resolve?: Resolver;
  /** Socket idle timeout, ms (default 30 000). */
  idleTimeoutMs?: number;
}

export interface BlockedEgress {
  host: string;
  port: number;
  reason: string;
}

export interface EgressProxy {
  /** e.g. "http://127.0.0.1:53211" */
  url: string;
  port: number;
  /** Attempts refused so far (capped at 1000 entries). */
  readonly blocked: BlockedEgress[];
  /** Hosts ("host:port") refused at least once — the report builder excludes these. */
  readonly blockedHosts: Set<string>;
  close(): Promise<void>;
}

const defaultResolve: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** Strip IPv6 brackets: "[::1]" → "::1". */
function unbracket(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Parse "host:port" (CONNECT authority), IPv6-bracket aware. */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const m = authority.match(/^(\[[^\]]+\]|[^:]+):(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: unbracket(m[1]!).toLowerCase(), port };
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export async function startEgressProxy(options: EgressProxyOptions = {}): Promise<EgressProxy> {
  const allowedPorts = new Set(options.allowedPorts ?? [80, 443]);
  const allowList = options.allowAddresses ?? [];
  const resolve = options.resolve ?? defaultResolve;
  const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
  const blocked: BlockedEgress[] = [];
  const blockedHosts = new Set<string>();
  const openSockets = new Set<Socket | Duplex>();

  const track = (s: Socket | Duplex) => {
    openSockets.add(s);
    s.on('close', () => openSockets.delete(s));
  };

  const refuse = (host: string, port: number, reason: string) => {
    if (blocked.length < 1000) blocked.push({ host, port, reason });
    blockedHosts.add(`${host}:${port}`);
  };

  const explicitlyAllowed = (ip: string, port: number) =>
    allowList.some((a) => a.ip === ip && a.port === port);

  /** Decide where (if anywhere) a host:port may be reached. */
  async function checkedAddress(
    host: string,
    port: number,
  ): Promise<{ ip: string } | { reason: string }> {
    if (!allowedPorts.has(port) && !allowList.some((a) => a.port === port)) {
      return { reason: `port ${port} not allowed` };
    }
    let candidates: string[];
    if (isIP(host)) {
      candidates = [host];
    } else {
      try {
        candidates = await resolve(host);
      } catch {
        return { reason: 'DNS resolution failed' };
      }
    }
    for (const ip of candidates) {
      if (explicitlyAllowed(ip, port)) return { ip };
    }
    for (const ip of candidates) {
      if (allowedPorts.has(port) && isPublicAddress(ip)) return { ip };
    }
    const first = candidates[0];
    return { reason: first ? classifyRefusal(first) : 'no addresses' };
  }

  const server: Server = createServer();

  // --- CONNECT tunnels (HTTPS, WSS, and anything Chromium tunnels) ---
  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    client.on('error', () => client.destroy());
    const target = parseAuthority(req.url ?? '');
    if (!target) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    void checkedAddress(target.host, target.port).then((decision) => {
      if ('reason' in decision) {
        refuse(target.host, target.port, decision.reason);
        client.end('HTTP/1.1 403 Forbidden\r\nX-Igris-Egress: blocked\r\n\r\n');
        return;
      }
      const upstream = netConnect({ host: decision.ip, port: target.port });
      track(upstream);
      upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => {
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });
      client.on('close', () => upstream.destroy());
    });
  });

  // --- absolute-form plain HTTP requests ---
  server.on('request', (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
      if (url.protocol !== 'http:') throw new Error('not http');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const host = unbracket(url.hostname).toLowerCase();
    const port = url.port ? Number(url.port) : 80;
    void checkedAddress(host, port).then((decision) => {
      if ('reason' in decision) {
        refuse(host, port, decision.reason);
        res.writeHead(403, { 'x-igris-egress': 'blocked' }).end();
        return;
      }
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
      }
      const upstream = httpRequest({
        host: decision.ip,
        port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        setHost: false, // keep the browser's Host header
        timeout: idleTimeoutMs,
      });
      upstream.on('response', (up) => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
        }
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });
  });

  // --- plain-HTTP upgrades (ws:// sent in absolute form) are refused: ---
  // Chromium tunnels WebSockets with CONNECT, which is checked above; an
  // upgrade arriving here is unexpected and not worth a second code path.
  server.on('upgrade', (req, socket: Duplex) => {
    track(socket);
    const host = (() => {
      try {
        return new URL(req.url ?? '').hostname;
      } catch {
        return '?';
      }
    })();
    refuse(host, 0, 'plain-HTTP upgrade not supported by egress proxy');
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('egress proxy failed to bind');

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    blocked,
    blockedHosts,
    close: () =>
      new Promise<void>((r) => {
        for (const s of openSockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/**
 * Chromium flags that force every byte through the proxy: loopback is NOT
 * bypassed (`<-loopback>` removes Chromium's implicit localhost bypass),
 * QUIC is off (UDP would skip an HTTP proxy), and WebRTC may not use
 * non-proxied UDP (it would otherwise reach LAN/STUN addresses directly).
 */
export function egressChromiumArgs(proxyUrl: string): string[] {
  return [
    `--proxy-server=${proxyUrl}`,
    '--proxy-bypass-list=<-loopback>',
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];
}
