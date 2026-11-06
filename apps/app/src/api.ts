/**
 * Thin client for the IGRIS API (apps/api). The backend owns every decision —
 * scanning, evidence, detection, verdicts, the summary, publishing to Arkiv
 * and verifying what it reads back. This module only moves its data to the
 * screen.
 *
 * The shapes below are what apps/api SENDS (apps/api/src/public.ts): the
 * registry's rows (packages/registry, site-registry.ts) without the signer —
 * a scan's, flow's or wallet request's `owner` and a request's `creator` are
 * never part of a response. They are restated here, type-only, because the
 * browser bundle must not depend on the backend's module graph.
 */
import type {
  EvidenceBundle,
  RecordedWalletMethod,
  ReportV3,
  Verdict,
  WalletRequestKind,
} from '@igris/core/contracts';

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

/**
 * A published scan version (igris.scan.v2, decoded): the API's PublicScan —
 * registry's PublishedScan without `owner`.
 */
export interface PublishedScan {
  key: string;
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
  /**
   * Entity key of the igris.request.v1 this scan fulfilled; null when it was
   * not made for a request (entities published before requests existed).
   */
  request: string | null;
}

/**
 * An open scan request (igris.request.v1): anyone can create one; every
 * scanner node that sees it may fulfil it (docs/design/SCAN-NETWORK.md).
 * The API's PublicRequest — registry's ScanRequest without `creator` (public
 * on Arkiv by design; the API does not send it).
 */
export interface ScanRequest {
  key: string;
  hostname: string;
  url: string;
  /** Unix seconds. */
  requestedAt: number;
  expiresAtBlock: number | null;
}

/**
 * One round: a request and the trusted scans that fulfilled it (a scan with
 * no request is a round of one). `node` is the API's label ("Scanner 1"…),
 * never an address.
 */
export interface RoundSummary {
  request: ScanRequest | null;
  scans: Array<{ version: number; key: string; node: string }>;
}

export type AddressExposure = 'exact' | 'hashed' | 'possible' | 'none';
export type AgreementStatus = 'agree' | 'differ' | 'partial';

/** Recipient-by-recipient comparison of a round's scans, computed by the API. */
export interface Agreement {
  /** Node labels, in the API's order (this node first). */
  nodes: string[];
  rows: Array<{
    registrableDomain: string;
    class: string;
    /** Keyed by node label; null when that node's scan did not see the recipient. */
    byNode: Record<string, { verdict: Verdict; address: AddressExposure } | null>;
    status: AgreementStatus;
  }>;
  summary: { agree: number; differ: number; partial: number };
}

/**
 * GET /api/sites/:hostname/rounds/:requestKey. `request` is null when the
 * request entity has expired on Arkiv: its scans (and the agreement) still
 * come back.
 */
export interface RoundResponse {
  request: ScanRequest | null;
  scans: Array<{ scan: PublishedScan; node: string; verified: boolean }>;
  agreement: Agreement | null;
}

/** GET /api/nodes — labels only, never addresses. */
export interface NodeInfo {
  label: string;
  self: boolean;
}

/**
 * One decoded wallet request of a published version (igris.walletreq.v1): the
 * API's PublicWalletRequest — registry's WalletRequestEntity without `owner`.
 */
export interface WalletRequestEntity {
  key: string;
  hostname: string;
  kind: WalletRequestKind;
  method: RecordedWalletMethod;
  outcome: 'answered' | 'signed' | 'rejected' | 'error';
  unlimited: boolean;
  chainIdMismatch: boolean;
  domainMismatch: boolean;
  preConnect: boolean;
  /** Checksummed address or "" when none. */
  verifyingContract: string;
  /** Checksummed address or "" when none. */
  spender: string;
  version: number;
  scanId: string;
  scannedAt: number;
}

/**
 * One site → recipient data flow of a published version (igris.flow.v1): the
 * API's PublicFlow — registry's FlowEntity without `owner`.
 */
export interface FlowEntity {
  key: string;
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

/** GET /api/registry — deliberately carries no publisher address. */
export interface RegistryInfo {
  mode: 'arkiv' | 'local';
  network: string;
  /** Public block explorer base URL (Arkiv mode), or null. */
  explorer: string | null;
  /** Whether this instance publishes the reports it produces. */
  publishing: boolean;
  ready: boolean;
  reason?: string;
}

export interface SiteResponse {
  hostname: string;
  versions: PublishedScan[];
  scanning: { id: string; state: JobState } | null;
  rounds: RoundSummary[];
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
  /** Label of the scanner node that published this version ("Scanner 1"…). */
  node: string;
}

/** POST /api/sites/:hostname/scans → 202. `request` is null when no request entity was made. */
export interface ScanStarted {
  id: string;
  request: ScanRequest | null;
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
  /** Scan or retest: the new job id and its request entity; a 409 carries the running job's id. */
  scan: (hostname: string, url?: string) =>
    call<ScanStarted>(`/api/sites/${enc(hostname)}/scans`, post(url ? { url } : {})),
  round: (hostname: string, requestKey: string) =>
    call<RoundResponse>(`/api/sites/${enc(hostname)}/rounds/${enc(requestKey)}`),
  nodes: () => call<{ nodes: NodeInfo[] }>('/api/nodes').then((r) => r.nodes),
  walletRequests: (
    q: { kind?: WalletRequestKind; unlimited?: boolean; hostname?: string; limit?: number } = {},
  ) => {
    const p = new URLSearchParams();
    if (q.kind) p.set('kind', q.kind);
    if (q.unlimited !== undefined) p.set('unlimited', String(q.unlimited));
    if (q.hostname) p.set('hostname', q.hostname);
    if (q.limit !== undefined) p.set('limit', String(q.limit));
    const qs = p.toString();
    return call<{ requests: WalletRequestEntity[] }>(
      `/api/wallet-requests${qs ? `?${qs}` : ''}`,
    ).then((r) => r.requests);
  },
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

/**
 * Start a scan of `hostname`; if one is already running, return that one's id
 * (its request is not known then: null). The request is remembered for the
 * live scan page (see rememberRequest).
 */
export async function startScan(hostname: string, url?: string): Promise<ScanStarted> {
  let started: ScanStarted;
  try {
    const r = await api.scan(hostname, url);
    started = { id: r.id, request: r.request ?? null };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.id) return { id: e.id, request: null };
    throw e;
  }
  if (started.request) rememberRequest(started.id, started.request);
  return started;
}

/*
 * The request a job was started for. GET /api/scans/:id does not carry it, so
 * the POST response's request is kept for this tab: in memory, and in
 * sessionStorage so a reload of the live scan page still shows it. Storage is
 * a convenience only — it may be unavailable, and then nothing is shown.
 */
const requests = new Map<string, ScanRequest>();
const STORE_KEY = (id: string) => `igris.request.${id}`;

export function rememberRequest(jobId: string, request: ScanRequest): void {
  requests.set(jobId, request);
  try {
    sessionStorage.setItem(STORE_KEY(jobId), JSON.stringify(request));
  } catch {
    /* storage unavailable: memory only */
  }
}

export function requestFor(jobId: string): ScanRequest | null {
  const known = requests.get(jobId);
  if (known) return known;
  try {
    const raw = sessionStorage.getItem(STORE_KEY(jobId));
    if (!raw) return null;
    const r = JSON.parse(raw) as ScanRequest;
    return typeof r?.key === 'string' && typeof r.hostname === 'string' ? r : null;
  } catch {
    return null;
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
