/**
 * Input validation for scan targets. This is the fail-fast layer: the
 * scanner's egress proxy (forced to public-only for every scan) is the real
 * control, and it re-checks every resolved address.
 */
import { isIP } from 'node:net';

export class BadRequest extends Error {}

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet'];
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isInternalName(host: string): boolean {
  return host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s));
}

/**
 * A site's identity: a lower-case public DNS name, exactly as the visitor
 * typed it (www.example.org and example.org are different sites). No IP
 * literals, no ports, no internal names, at least two labels, and a TLD that
 * is not numeric (so dotted-decimal and other numeric IPv4 forms never pass).
 */
export function validateHostname(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 253) {
    throw new BadRequest('hostname must be a DNS name (at most 253 characters)');
  }
  const host = input.toLowerCase();
  if (host.includes(':') || host.includes('[') || isIP(host)) {
    throw new BadRequest('hostname must be a DNS name, not an IP address or host:port');
  }
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) {
    throw new BadRequest(
      'hostname must be a DNS name like app.example.org (letters, digits, hyphens; punycode for IDNs)',
    );
  }
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) {
    throw new BadRequest('hostname must be a DNS name, not an IP address');
  }
  if (isInternalName(host)) throw new BadRequest('internal hostnames are not scanned');
  return host;
}

/** Validate a scan target URL (scheme, credentials, port, internal or non-public hosts). */
export function validateScanUrl(
  input: unknown,
  allowedPorts: number[],
  isPublic: (ip: string) => boolean,
): string {
  if (typeof input !== 'string' || input.length > 2048)
    throw new BadRequest('url must be a string');
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new BadRequest('url is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new BadRequest('url must be http(s)');
  if (u.username || u.password) throw new BadRequest('url must not contain credentials');
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (!allowedPorts.includes(port)) throw new BadRequest(`port ${port} is not allowed`);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isInternalName(host)) throw new BadRequest('internal hostnames are not scanned');
  if (isIP(host) && !isPublic(host)) throw new BadRequest('non-public addresses are not scanned');
  return u.toString();
}

/**
 * The target of a scan of `hostname`: the visitor's URL when given (it must
 * be on exactly that hostname), else https://<hostname>/.
 */
export function scanTarget(
  hostnameInput: unknown,
  urlInput: unknown,
  allowedPorts: number[],
  isPublic: (ip: string) => boolean,
): { hostname: string; url: string } {
  const hostname = validateHostname(hostnameInput);
  if (urlInput === undefined || urlInput === null || urlInput === '') {
    return { hostname, url: validateScanUrl(`https://${hostname}/`, allowedPorts, isPublic) };
  }
  const url = validateScanUrl(urlInput, allowedPorts, isPublic);
  if (new URL(url).hostname !== hostname) {
    throw new BadRequest(`url must be on ${hostname}`);
  }
  return { hostname, url };
}

/** A positive integer path segment (version numbers), else BadRequest. */
export function positiveInt(input: string, what: string, max = 1_000_000): number {
  if (!/^[1-9][0-9]{0,9}$/.test(input) || Number(input) > max) {
    throw new BadRequest(`${what} must be a positive integer`);
  }
  return Number(input);
}

/** ?limit= with bounds; absent → def. */
export function limitParam(input: unknown, def: number, max: number): number {
  if (input === undefined || input === '') return def;
  if (typeof input !== 'string' || !/^[1-9][0-9]{0,4}$/.test(input) || Number(input) > max) {
    throw new BadRequest(`limit must be an integer in [1, ${max}]`);
  }
  return Number(input);
}
