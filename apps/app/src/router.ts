/** Hash router: no server routes, works from any static host. */
import { useEffect, useState } from 'preact/hooks';
import { isHostname } from './api.js';

export type Route =
  | { name: 'landing' }
  /** A site: its latest version (or the empty / scanning state). */
  | { name: 'site'; hostname: string }
  /** One published version of a site. */
  | { name: 'version'; hostname: string; version: number }
  | { name: 'evidence'; hostname: string; version: number; item?: string }
  /** A scan job's live progress. */
  | { name: 'scan'; id: string }
  /** A completed scan's report from the server's cache (not published yet). */
  | { name: 'scan-report'; id: string }
  | { name: 'scan-evidence'; id: string; item?: string }
  | { name: 'not-found' };

const HOST = '([^/?#]{1,253})';
const VER = '([1-9][0-9]{0,8})';
const EV = '(ev_[0-9a-f]{24})';
const JOB = '([A-Za-z0-9_-]{1,64})';

/**
 * Where a report lives in the app: a published version of a site, or a
 * completed scan that is not (yet) a version and is read from the server's
 * cache by its job id.
 */
export type ReportRef =
  { kind: 'version'; hostname: string; version: number } | { kind: 'scan'; id: string };

function host(raw: string): string | null {
  let h: string;
  try {
    h = decodeURIComponent(raw).toLowerCase();
  } catch {
    return null;
  }
  return isHostname(h) ? h : null;
}

export function parse(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/';
  if (path === '/') return { name: 'landing' };
  let m = new RegExp(`^/site/${HOST}$`).exec(path);
  if (m) {
    const h = host(m[1]!);
    return h ? { name: 'site', hostname: h } : { name: 'not-found' };
  }
  m = new RegExp(`^/site/${HOST}/v/${VER}$`).exec(path);
  if (m) {
    const h = host(m[1]!);
    return h ? { name: 'version', hostname: h, version: Number(m[2]) } : { name: 'not-found' };
  }
  m = new RegExp(`^/site/${HOST}/v/${VER}/evidence(?:/${EV})?$`).exec(path);
  if (m) {
    const h = host(m[1]!);
    if (!h) return { name: 'not-found' };
    const r: Route = { name: 'evidence', hostname: h, version: Number(m[2]) };
    return m[3] ? { ...r, item: m[3] } : r;
  }
  m = new RegExp(`^/scan/${JOB}$`).exec(path);
  if (m) return { name: 'scan', id: m[1]! };
  m = new RegExp(`^/scan/${JOB}/report$`).exec(path);
  if (m) return { name: 'scan-report', id: m[1]! };
  m = new RegExp(`^/scan/${JOB}/report/evidence(?:/${EV})?$`).exec(path);
  if (m)
    return m[2]
      ? { name: 'scan-evidence', id: m[1]!, item: m[2] }
      : { name: 'scan-evidence', id: m[1]! };
  return { name: 'not-found' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function go(path: string, replace = false): void {
  if (replace) {
    history.replaceState(null, '', `#${path}`);
    dispatchEvent(new HashChangeEvent('hashchange'));
  } else location.hash = path;
}

export const paths: {
  site: (h: string) => string;
  version: (h: string, n: number) => string;
  evidence: (h: string, n: number, item?: string) => string;
  scan: (id: string) => string;
  scanReport: (id: string) => string;
  scanEvidence: (id: string, item?: string) => string;
  report: (ref: ReportRef) => string;
  evidenceOf: (ref: ReportRef, item?: string) => string;
} = {
  site: (h: string) => `/site/${h}`,
  version: (h: string, n: number) => `/site/${h}/v/${n}`,
  evidence: (h: string, n: number, item?: string) =>
    `/site/${h}/v/${n}/evidence${item ? `/${item}` : ''}`,
  scan: (id: string) => `/scan/${id}`,
  scanReport: (id: string) => `/scan/${id}/report`,
  scanEvidence: (id: string, item?: string) =>
    `/scan/${id}/report/evidence${item ? `/${item}` : ''}`,
  report: (ref: ReportRef) =>
    ref.kind === 'version' ? paths.version(ref.hostname, ref.version) : paths.scanReport(ref.id),
  evidenceOf: (ref: ReportRef, item?: string) =>
    ref.kind === 'version'
      ? paths.evidence(ref.hostname, ref.version, item)
      : paths.scanEvidence(ref.id, item),
};
