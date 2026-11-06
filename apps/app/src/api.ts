/**
 * Thin client for the IGRIS scanner API (apps/api). The backend owns every
 * security decision — scanning, evidence, detection, scoring, assessment.
 * This module only moves its data to the screen.
 */
import type { EvidenceBundle, ReportV2 } from '@igris/core/contracts';

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
export type Level = 'not-assessed' | 'critical' | 'high' | 'elevated' | 'moderate' | 'low';
export type SeverityCounts = Record<'critical' | 'high' | 'medium' | 'low' | 'info', number>;

export interface ScanSummary {
  level: Level;
  headline: string;
  status: ReportV2['scan']['status'];
  score: number | null;
  coverage: ReportV2['privacy']['coverage'];
  failure: { category: string; detail: string } | null;
  findings: {
    total: number;
    bySeverity: SeverityCounts;
    byKind: Record<'issue' | 'risk' | 'observation', number>;
  };
  securityObservations: number;
  addressLeaks: number;
  leakDomains: string[];
  thirdPartyDomains: string[];
  kit: { id: string; confidence: string } | null;
  walletConnected: boolean;
  usesAnonRpc: boolean;
  evidence: { sha256: string; itemCount: number };
  findingSet: { sha256: string; count: number };
}

export interface ScanMeta {
  id: string;
  url: string;
  hostname: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  state: JobState;
  error?: string;
  events: ScanProgressEvent[];
  summary?: ScanSummary;
}

export interface Assessment {
  level: Level;
  headline: string;
  points: string[];
  caveats: string[];
}

export interface ReportResponse {
  scan: ScanMeta;
  report: ReportV2;
  evidence: EvidenceBundle;
  verification: { schema: boolean; integrity: boolean };
  assessment: Assessment;
}

export interface Stats {
  totals: {
    scans: number;
    completed: number;
    failed: number;
    inProgress: number;
    scored: number;
    notScored: number;
    dapps: number;
  };
  /** Findings, scores and domains use the latest completed scan of each dApp. */
  basis: string;
  averageScore: number | null;
  severity: SeverityCounts;
  addressLeaks: number;
  topThirdParties: Array<{ domain: string; scans: number }>;
  topLeakDomains: Array<{ domain: string; scans: number }>;
  /** Per kit, scans by identification confidence (high = modal observed). */
  kits: Array<{ id: string; high: number; medium: number; low: number }>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'The scanner API is not reachable. Is it running on this machine?');
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    const fallback =
      res.status === 429
        ? 'Too many scans requested — wait a minute and try again.'
        : res.status === 503
          ? 'The scanner is busy. Try again when the current scans finish.'
          : `Request failed (${res.status}).`;
    throw new ApiError(res.status, body?.error ?? fallback);
  }
  return body as T;
}

export const api = {
  submit: (url: string, dwellMs?: number) =>
    call<{ id: string; state: JobState }>('/api/scans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dwellMs ? { url, dwellMs } : { url }),
    }),
  list: () => call<{ scans: ScanMeta[] }>('/api/scans').then((r) => r.scans),
  get: (id: string) => call<{ scan: ScanMeta }>(`/api/scans/${id}`).then((r) => r.scan),
  report: (id: string) => call<Omit<ReportResponse, 'scan'>>(`/api/scans/${id}/report`),
  stats: () => call<Stats>('/api/stats'),
  health: () => call<{ ok: boolean }>('/api/health'),
};

/** Normalise what a person types into a URL the API accepts. */
export function normaliseUrl(input: string): string {
  const t = input.trim();
  if (!t) return t;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
}
