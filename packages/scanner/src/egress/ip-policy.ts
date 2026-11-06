/**
 * Which IP addresses a public-only scanner may connect to.
 *
 * "Public" means globally routable unicast. Everything else — loopback,
 * RFC 1918, link-local (incl. cloud metadata 169.254.169.254), CGNAT,
 * benchmarking, documentation, multicast, reserved, and IPv6 equivalents —
 * is refused. IPv6 forms that embed an IPv4 address (IPv4-mapped, NAT64,
 * 6to4, IPv4-compatible) are judged by the embedded address, and Teredo is
 * refused outright (its embedded address is obfuscated and it tunnels).
 *
 * Pure functions, no I/O: unit-tested exhaustively in ip-policy.test.ts.
 */
import { isIPv4, isIPv6 } from 'node:net';

/** [network, prefixLength] */
type V4Range = readonly [string, number];

const BLOCKED_V4: readonly V4Range[] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT (RFC 6598)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function v4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function inV4Range(ip: string, [net, len]: V4Range): boolean {
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(net) & mask);
}

export function isPublicIPv4(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  return !BLOCKED_V4.some((r) => inV4Range(ip, r));
}

/** Expand an IPv6 literal to 8 × 16-bit groups (handles :: and dotted tails). */
export function expandIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (!isIPv6(s)) return null;
  // Dotted IPv4 tail → two hex groups.
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const n = v4ToInt(dotted[1]!);
    s = s.slice(0, -dotted[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - h.length - t.length;
  if (tail === undefined && h.length !== 8) return null;
  const groups = [...h, ...Array(tail !== undefined ? missing : 0).fill('0'), ...t];
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16));
}

function v4FromGroups(hi: number, lo: number): string {
  return [hi >>> 8, hi & 0xff, lo >>> 8, lo & 0xff].join('.');
}

export function isPublicIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return false;
  const [a, b] = [g[0]!, g[1]!];
  const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);

  if (allZero(0, 8)) return false; // :: unspecified
  if (allZero(0, 7) && g[7] === 1) return false; // ::1 loopback
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d → judge the IPv4.
  if (allZero(0, 5) && (g[5] === 0xffff || g[5] === 0))
    return isPublicIPv4(v4FromGroups(g[6]!, g[7]!));
  // NAT64 well-known prefix 64:ff9b::/96 → embedded IPv4.
  if (a === 0x64 && b === 0xff9b && allZero(2, 6)) return isPublicIPv4(v4FromGroups(g[6]!, g[7]!));
  // 6to4 2002::/16 → embedded IPv4 in groups 1–2.
  if (a === 0x2002) return isPublicIPv4(v4FromGroups(g[1]!, g[2]!));
  if (a === 0x2001 && b === 0x0000) return false; // Teredo 2001::/32
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x2001 && b < 0x0200) return false; // 2001::/23 IETF protocol assignments
  if (a === 0x0100 && allZero(1, 4)) return false; // 100::/64 discard-only
  if ((a & 0xfe00) === 0xfc00) return false; // fc00::/7 unique-local
  if ((a & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  // Only 2000::/3 is allocated global unicast; anything else is reserved.
  return (a & 0xe000) === 0x2000;
}

/** Is this IP literal (v4 or v6) a globally routable unicast address? */
export function isPublicAddress(ip: string): boolean {
  if (isIPv4(ip)) return isPublicIPv4(ip);
  return isPublicIPv6(ip);
}

/** Why an address is refused, for logs/reports. */
export function classifyRefusal(ip: string): string {
  if (!isIPv4(ip) && !isIPv6(ip.split('%')[0] ?? '')) return 'not an IP address';
  if (isIPv4(ip)) {
    if (inV4Range(ip, ['127.0.0.0', 8])) return 'loopback';
    if (inV4Range(ip, ['169.254.0.0', 16])) return 'link-local / cloud metadata';
    if (
      inV4Range(ip, ['10.0.0.0', 8]) ||
      inV4Range(ip, ['172.16.0.0', 12]) ||
      inV4Range(ip, ['192.168.0.0', 16])
    )
      return 'private network';
  }
  const g = expandIPv6(ip);
  if (g) {
    const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
    if (allZero(0, 7) && g[7] === 1) return 'loopback';
    if (allZero(0, 5) && (g[5] === 0xffff || g[5] === 0)) {
      return classifyRefusal(v4FromGroups(g[6]!, g[7]!)); // IPv4-mapped/compatible
    }
    if ((g[0]! & 0xffc0) === 0xfe80) return 'link-local';
    if ((g[0]! & 0xfe00) === 0xfc00) return 'private network';
  }
  return 'non-public address';
}
