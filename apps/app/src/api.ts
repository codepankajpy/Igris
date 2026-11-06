/**
 * Thin client for the IGRIS API (apps/api). The backend owns every decision —
 * scanning, evidence, detection, verdicts, the summary, publishing to Arkiv
 * and verifying what it reads back. This module only moves its data to the
 * screen.
 *
 * The shapes below mirror apps/api and packages/registry (site-registry.ts)
 * exactly; they are restated here, type-only, because the browser bundle must
 * not depend on the backend's module graph.
 */
import type { EvidenceBundle, ReportV3, Verdict } from '@igris/core/contracts';

/** summarise() output (@igris/core assessment.ts), restated: descriptive, never a grade. */
export type SummaryState =
  'not-observed' | 'address-to-trackers' | 'address-to-services' | 'no-address-observed';
export interface Summary {
  state: SummaryState;
  headline: string;
  points: string[];
  caveats: string[];
}

export const SCAN_STAGES = [
  'browser',
  'navigation',
  'observe-pre-connect',
  'wallet',
  'observe-post-connect',
  'detection',
  'evidence',
  'report',
] as const;
export type ScanStage = (typeof SCAN_STAGES)[number];

export interface ScanProgressEvent {
  stage: ScanStage;
  status: 'started' | 'completed' | 'failed' | 'skipped' | 'update';
  at: string;
  detail?: string;
  counters?: { requests: number; hosts: number; wsConnections: number };
}

export type JobState = 'queued' | 'running' | 'completed' | 'failed';

export interface PublishStatus {
  ok: boolean;
  error?: string;
  mode?: 'arkiv' | 'local';
  scanKey?: string;
  evidenceKey?: string;
  flowKeys?: string[];
  txHash?: string | null;
}

export interface Job {
  id: string;
  hostname: string;
  url: string;
  state: JobState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  events: ScanProgressEvent[];
  version: number | null;
  publish: PublishStatus | null;
}

/** A published scan version (igris.scan.v2, decoded). Mirrors registry's PublishedScan. */
export interface PublishedScan {
  key: string;
  owner: string;
  hostname: string;
  version: number;
  previous: string | null;
  /** Unix seconds. */
  scannedAt: number;
  scanId: string;
  evidenceSha256: string;
  findingSetSha256: string;
  state: SummaryState;
  coverage: 'full' | 'pre-connect-only';
  recipients: number;
  addressRecipients: number;
  trackingRecipients: number;
  usesAnonRpc: boolean;
  scannerVersion: string;
  reportVersion: string;
  expiresAtBlock: number | null;
}

/** One site → recipient data flow of a published version (igris.flow.v1). */
export interface FlowEntity {
  key: string;
  owner: string;
  hostname: string;
  recipient: string;
  class: string;
  verdict: Verdict;
  address: 'exact' | 'hashed' | 'possible' | 'none';
  preConnect: boolean;
  version: number;
  scanId: string;
  scannedAt: number;
}

export interface RecipientRef {
  registrableDomain: string;
  class: string;
}
type AddressExposure = 'exact' | 'hashed' | 'possible' | 'none';

/** Version n vs n − 1, computed by the API. */
export interface Changes {
  sameBehaviour: boolean;
  added: RecipientRef[];
  removed: RecipientRef[];
  changed: Array<{
    ref: RecipientRef;
    from: { verdict: Verdict; address: AddressExposure };
    to: { verdict: Verdict; address: AddressExposure };
  }>;
}

export interface RegistryInfo {
  mode: 'arkiv' | 'local';
  publisher: string | null;
  network: string;
  trustedOwners: string[];
  ready: boolean;
  reason?: string;
}

export interface SiteResponse {
  hostname: string;
  versions: PublishedScan[];
  scanning: { id: string; state: JobState } | null;
}

export interface VersionResponse {
  scan: PublishedScan;
  report: ReportV3;
  evidence: EvidenceBundle;
  verified: boolean;
  problems: string[];
  summary: Summary;
  changes: Changes | null;
  source: 'arkiv' | 'local';
}

/**
 * GET /api/scans/:id/report — a completed scan served from this server's local
 * cache (re-verified on read: schema, integrity, hashes), whether or not it
 * has been published. 404 when the job is unknown or nothing is cached; 409
 * while the job has not completed.
 */
export interface ScanReportResponse {
  report: ReportV3;
  evidence: EvidenceBundle;
  verified: boolean;
  problems: string[];
  summary: Summary;
  source: 'local';
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The running scan's id on a 409 "already scanning". */
    readonly id?: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'The IGRIS API is not reachable. Is it running?');
  }
  const body = (await res.json().catch(() => null)) as { error?: string; id?: string } | null;
  if (!res.ok) {
    const fallback =
      res.status === 429
        ? 'Too many scans requested — wait a minute and try again.'
        : res.status === 503
          ? 'The scanner is busy. Try again when the current scans finish.'
          : res.status === 404
            ? 'Not found.'
            : `Request failed (${res.status}).`;
    throw new ApiError(res.status, body?.error ?? fallback, body?.id);
  }
  return body as T;
}

const enc = encodeURIComponent;
const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  registry: () => call<RegistryInfo>('/api/registry'),
  sites: (limit = 12) =>
    call<{ sites: PublishedScan[] }>(`/api/sites?limit=${limit}`).then((r) => r.sites),
  site: (hostname: string) => call<SiteResponse>(`/api/sites/${enc(hostname)}`),
  version: (hostname: string, n: number) =>
    call<VersionResponse>(`/api/sites/${enc(hostname)}/versions/${n}`),
  /** Scan or retest. Resolves to the new job id; a 409 carries the running job's id. */
  scan: (hostname: string, url?: string) =>
    call<{ id: string }>(`/api/sites/${enc(hostname)}/scans`, post(url ? { url } : {})),
  job: (id: string) => call<{ scan: Job }>(`/api/scans/${enc(id)}`).then((r) => r.scan),
  /** A completed scan's report from the server's cache (published or not). */
  scanReport: (id: string) => call<ScanReportResponse>(`/api/scans/${enc(id)}/report`),
  retryPublish: (id: string) =>
    call<{ publish: PublishStatus }>(`/api/scans/${enc(id)}/publish`, post({})).then(
      (r) => r.publish,
    ),
  flowsTo: (domain: string) =>
    call<{ flows: FlowEntity[] }>(`/api/recipients/${enc(domain)}`).then((r) => r.flows),
};

/** Start a scan of `hostname`; if one is already running, return that one's id. */
export async function startScan(hostname: string, url?: string): Promise<string> {
  try {
    return (await api.scan(hostname, url)).id;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.id) return e.id;
    throw e;
  }
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/** True for a syntactically valid DNS hostname (lower-case, at least one dot). */
export function isHostname(h: string): boolean {
  return HOSTNAME.test(h);
}

/**
 * What a person types → the hostname a site is keyed by. Accepts a URL or a
 * bare host; lower-cases (the URL parser also punycodes); keeps "www." —
 * www.example.org and example.org are different sites. Null when it is not
 * a hostname. Whether the host is public is the backend's call.
 */
export function normaliseHostname(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/\.$/, '');
  return isHostname(host) ? host : null;
}
