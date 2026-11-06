/**
 * P0-5 unit level: the IP policy and the egress proxy, driven with raw
 * sockets (no browser). The browser-level proof is e2e/egress.e2e.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { expandIPv6, isPublicAddress } from './ip-policy.js';
import { parseAuthority, startEgressProxy, type EgressProxy } from './proxy.js';

describe('ip-policy', () => {
  const blocked = [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '239.255.255.250',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:169.254.169.254',
    '::ffff:7f00:1', // mapped, hex form
    '::127.0.0.1', // IPv4-compatible
    '64:ff9b::a9fe:a9fe', // NAT64 → 169.254.169.254
    '2002:c0a8:0101::1', // 6to4 → 192.168.1.1
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '2001:db8::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'fec0::1',
    'ff02::1',
    '100::1',
    '::2', // reserved, not global unicast
    'not-an-ip',
  ];
  const allowed = [
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '172.15.255.255', // just outside 172.16/12
    '172.32.0.1',
    '100.63.255.255', // just outside CGNAT
    '2606:4700:4700::1111',
    '2a00:1450:4001:81b::200e',
    '::ffff:8.8.8.8', // mapped public
    '64:ff9b::808:808', // NAT64 → 8.8.8.8
  ];
  for (const ip of blocked) it(`refuses ${ip}`, () => expect(isPublicAddress(ip)).toBe(false));
  for (const ip of allowed) it(`allows ${ip}`, () => expect(isPublicAddress(ip)).toBe(true));

  it('expands IPv6 with :: and dotted tails', () => {
    expect(expandIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(expandIPv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('nope')).toBeNull();
  });

  it('parses CONNECT authorities, IPv6-bracket aware', () => {
    expect(parseAuthority('example.org:443')).toEqual({ host: 'example.org', port: 443 });
    expect(parseAuthority('[::1]:8080')).toEqual({ host: '::1', port: 8080 });
    expect(parseAuthority('example.org')).toBeNull();
    expect(parseAuthority('example.org:99999')).toBeNull();
  });
});

/** Send raw bytes to the proxy and return the first response line. */
function rawExchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        sock.destroy();
        resolve(buf.split('\r\n')[0]!);
      }
    });
    sock.on('error', reject);
    sock.on('end', () => resolve(buf.split('\r\n')[0] ?? ''));
    sock.write(payload);
  });
}

describe('egress proxy', () => {
  let internal: Server;
  let internalPort: number;
  let hits = 0;
  let strict: EgressProxy;
  let permissive: EgressProxy;
  const fakeDns: Record<string, string[]> = {
    'evil.test': ['127.0.0.1'],
    'metadata.test': ['169.254.169.254'],
    'mixed.test': ['10.0.0.1', '127.0.0.1'],
  };
  const resolve = async (h: string) => {
    const ips = fakeDns[h];
    if (!ips) throw new Error('NXDOMAIN');
    return ips;
  };

  beforeAll(async () => {
    internal = createServer((_req, res) => {
      hits += 1;
      res.end('internal secret');
    });
    await new Promise<void>((r) => internal.listen(0, '127.0.0.1', () => r()));
    internalPort = (internal.address() as AddressInfo).port;
    strict = await startEgressProxy({ resolve });
    permissive = await startEgressProxy({
      resolve,
      allowAddresses: [{ ip: '127.0.0.1', port: internalPort }],
    });
  });

  afterAll(async () => {
    await strict.close();
    await permissive.close();
    await new Promise((r) => internal.close(() => r(undefined)));
  });

  const blockedCases: Array<[string, string]> = [
    [
      'CONNECT to loopback literal',
      `CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n`,
    ],
    ['CONNECT to cloud metadata', `CONNECT 169.254.169.254:80 HTTP/1.1\r\nHost: x\r\n\r\n`],
    ['CONNECT to IPv6 loopback', `CONNECT [::1]:443 HTTP/1.1\r\nHost: x\r\n\r\n`],
    [
      'CONNECT to IPv4-mapped loopback',
      `CONNECT [::ffff:127.0.0.1]:443 HTTP/1.1\r\nHost: x\r\n\r\n`,
    ],
    ['CONNECT to name resolving to loopback', `CONNECT evil.test:443 HTTP/1.1\r\nHost: x\r\n\r\n`],
    [
      'CONNECT to name resolving to metadata',
      `CONNECT metadata.test:80 HTTP/1.1\r\nHost: x\r\n\r\n`,
    ],
    [
      'CONNECT to name with only private answers',
      `CONNECT mixed.test:443 HTTP/1.1\r\nHost: x\r\n\r\n`,
    ],
    ['CONNECT to unresolvable name', `CONNECT nx.test:443 HTTP/1.1\r\nHost: x\r\n\r\n`],
    ['CONNECT to disallowed port (public IP)', `CONNECT 8.8.8.8:25 HTTP/1.1\r\nHost: x\r\n\r\n`],
    ['absolute-form GET to loopback', `GET http://127.0.0.1/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`],
    [
      'absolute-form GET to metadata',
      `GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n`,
    ],
  ];

  for (const [name, payload] of blockedCases) {
    it(`blocks ${name}`, async () => {
      const before = hits;
      expect(await rawExchange(strict.port, payload)).toMatch(/^HTTP\/1\.1 403/);
      expect(hits).toBe(before);
    });
  }

  it('blocks the real internal server on its own port (not in the port allowlist)', async () => {
    const before = hits;
    const line = await rawExchange(
      strict.port,
      `GET http://127.0.0.1:${internalPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${internalPort}\r\n\r\n`,
    );
    expect(line).toMatch(/403/);
    expect(hits).toBe(before);
    expect(strict.blockedHosts.has(`127.0.0.1:${internalPort}`)).toBe(true);
  });

  it('records why each attempt was refused', () => {
    const reasons = strict.blocked.map((b) => b.reason);
    expect(reasons).toContain('loopback');
    expect(reasons).toContain('link-local / cloud metadata');
    expect(reasons).toContain('port 25 not allowed');
    expect(reasons).toContain('DNS resolution failed');
  });

  it('positive: an explicitly allowlisted (ip, port) is reachable via absolute-form GET', async () => {
    const before = hits;
    const line = await rawExchange(
      permissive.port,
      `GET http://127.0.0.1:${internalPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${internalPort}\r\nConnection: close\r\n\r\n`,
    );
    expect(line).toMatch(/^HTTP\/1\.1 200/);
    expect(hits).toBe(before + 1);
  });

  it('positive: an explicitly allowlisted (ip, port) is reachable via CONNECT', async () => {
    const line = await rawExchange(
      permissive.port,
      `CONNECT 127.0.0.1:${internalPort} HTTP/1.1\r\nHost: x\r\n\r\n`,
    );
    expect(line).toMatch(/^HTTP\/1\.1 200 Connection Established/);
  });

  it('the allowlist is exact: same IP, other port stays blocked', async () => {
    const line = await rawExchange(
      permissive.port,
      `CONNECT 127.0.0.1:${internalPort + 1} HTTP/1.1\r\nHost: x\r\n\r\n`,
    );
    expect(line).toMatch(/403/);
  });

  it('rejects malformed CONNECT authorities', async () => {
    expect(await rawExchange(strict.port, `CONNECT nonsense HTTP/1.1\r\nHost: x\r\n\r\n`)).toMatch(
      /400/,
    );
  });
});
