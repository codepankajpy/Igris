/**
 * Deterministic API fixtures for the web-app e2e suite: one completed scan
 * (real Report v2 + evidence bundle from core's sampleResult()), one running
 * scan that streams progress over SSE and then completes, and one failed scan.
 *
 * Shapes are typed against the app's own API client types (src/api.ts), so a
 * drift between this stub and what the app expects fails the e2e typecheck.
 * The summary mirrors apps/api/src/scans.ts summarize() — rebuilt here rather
 * than imported, because @igris/app does not (and should not) depend on
 * @igris/api, whose module graph pulls in the scanner and CLI.
 */
import { assess, type CanaryMatchEvidence, type ScanResult } from '@igris/core';
import { sampleResult } from '@igris/core/testing';
import type {
  ReportResponse,
  ScanMeta,
  ScanProgressEvent,
  ScanStage,
  ScanSummary,
  Stats,
} from '../src/api.js';

export const COMPLETED_ID = '0b5f8a52-3c1e-4d2a-9f60-1a2b3c4d5e6f';
export const RUNNING_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const FAILED_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const T0 = Date.parse('2026-11-06T09:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

export const result: ScanResult = sampleResult();
export const assessment = assess(result.report, result.bundle);

/** Mirror of apps/api summarize(). */
function summarize({ report, bundle }: ScanResult): ScanSummary {
  const all = [...report.privacy.findings, ...report.security.observations];
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byKind = { issue: 0, risk: 0, observation: 0 };
  for (const f of all) {
    bySeverity[f.severity] += 1;
    byKind[f.kind] += 1;
  }
  const leaks = report.privacy.findings.filter(
    (f) => f.detector === 'canary-leak' && f.countsTowardPrivacyScore,
  );
  const conn = report.scan.connection;
  const a = assess(report, bundle);
  return {
    level: a.level,
    headline: a.headline,
    status: report.scan.status,
    score: report.privacy.score,
    coverage: report.privacy.coverage,
    failure: report.scan.failure ?? null,
    findings: { total: all.length, bySeverity, byKind },
    securityObservations: report.security.observations.length,
    addressLeaks: leaks.length,
    leakDomains: [
      ...new Set(
        leaks.flatMap((f) =>
          f.evidence
            .map((ref) => bundle.items[ref.id])
            .filter((i): i is CanaryMatchEvidence => i?.type === 'canary-match')
            .map((i) => i.registrableDomain),
        ),
      ),
    ].sort(),
    thirdPartyDomains: [...new Set(report.contacts.map((c) => c.registrableDomain))].sort(),
    kit:
      conn && conn.kit.id !== 'none' ? { id: conn.kit.id, confidence: conn.kit.confidence } : null,
    walletConnected: report.scan.status === 'completed',
    usesAnonRpc: report.wallet.usesAnonRpc,
    evidence: { sha256: report.evidence.sha256, itemCount: report.evidence.itemCount },
    findingSet: report.findingSet,
  };
}

export const summary = summarize(result);

const counters = (requests: number, hosts: number) => ({ requests, hosts, wsConnections: 0 });

/** A full, successful stage run (as the scanner emits it). */
function fullRun(offset: number): ScanProgressEvent[] {
  const stages: ScanStage[] = [
    'browser',
    'navigation',
    'observe-pre-connect',
    'wallet',
    'observe-post-connect',
    'detection',
    'evidence',
    'report',
  ];
  return stages.flatMap((stage, i) => [
    { stage, status: 'started' as const, at: at(offset + i * 2000) },
    {
      stage,
      status: 'completed' as const,
      at: at(offset + i * 2000 + 1500),
      ...(stage.startsWith('observe') ? { counters: counters(12 + i * 4, 3 + i) } : {}),
    },
  ]);
}

export const completedMeta: ScanMeta = {
  id: COMPLETED_ID,
  url: 'https://app.example.org/',
  hostname: 'app.example.org',
  createdAt: at(0),
  startedAt: at(100),
  finishedAt: at(17_000),
  state: 'completed',
  events: fullRun(100),
  summary,
};

/** Progress the running scan's SSE stream replays before its final `done`. */
export const runningProgress: ScanProgressEvent[] = [
  { stage: 'browser', status: 'started', at: at(60_000) },
  { stage: 'browser', status: 'completed', at: at(60_900) },
  { stage: 'navigation', status: 'started', at: at(61_000), detail: 'https://app.example.org/' },
  { stage: 'navigation', status: 'completed', at: at(63_200) },
  {
    stage: 'observe-pre-connect',
    status: 'update',
    at: at(64_000),
    counters: counters(18, 5),
  },
];

export const runningMeta: ScanMeta = {
  id: RUNNING_ID,
  url: 'https://app.example.org/',
  hostname: 'app.example.org',
  createdAt: at(59_000),
  startedAt: at(60_000),
  state: 'running',
  events: runningProgress.slice(0, 2),
};

/** What GET /api/scans/:id returns for the running scan once its stream said `done`. */
export const runningDoneMeta: ScanMeta = {
  ...runningMeta,
  state: 'completed',
  finishedAt: at(75_000),
  events: [...runningProgress, ...fullRun(65_000).slice(6)],
  summary,
};

export const failedMeta: ScanMeta = {
  id: FAILED_ID,
  url: 'https://unreachable.example.com/',
  hostname: 'unreachable.example.com',
  createdAt: at(-120_000),
  startedAt: at(-119_900),
  finishedAt: at(-110_000),
  state: 'failed',
  error: 'The page did not load: DNS lookup for unreachable.example.com failed.',
  events: [
    { stage: 'browser', status: 'started', at: at(-119_900) },
    { stage: 'browser', status: 'completed', at: at(-119_000) },
    { stage: 'navigation', status: 'started', at: at(-118_900) },
    {
      stage: 'navigation',
      status: 'failed',
      at: at(-110_000),
      detail: 'net::ERR_NAME_NOT_RESOLVED',
    },
  ],
};

export const reportBody: Omit<ReportResponse, 'scan'> = {
  report: result.report,
  evidence: result.bundle,
  verification: { schema: true, integrity: true },
  assessment,
};

export function stats(metas: ScanMeta[]): Stats {
  const done = metas.filter((m) => m.state === 'completed' && m.summary);
  const scored = done.filter((m) => m.summary!.score !== null);
  const latest = done[0]?.summary;
  const top = (ds: string[]) => ds.map((domain) => ({ domain, scans: 1 }));
  return {
    totals: {
      scans: metas.length,
      completed: done.length,
      failed: metas.filter((m) => m.state === 'failed').length,
      inProgress: metas.filter((m) => m.state === 'queued' || m.state === 'running').length,
      scored: scored.length,
      notScored: done.length - scored.length,
      dapps: new Set(done.map((m) => m.hostname)).size,
    },
    basis: 'latest completed scan of each dApp',
    averageScore: latest?.score ?? null,
    severity: latest?.findings.bySeverity ?? { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    addressLeaks: latest?.addressLeaks ?? 0,
    topThirdParties: top(latest?.thirdPartyDomains ?? []),
    topLeakDomains: top(latest?.leakDomains ?? []),
    kits: [],
  };
}

/** SSE body exactly as apps/api writes it: state, replayed progress, done. */
export function sseBody(progress: ScanProgressEvent[]): string {
  const send = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    send('state', { state: 'running' }) +
    progress.map((e) => send('progress', e)).join('') +
    send('done', { state: 'completed', error: null })
  );
}

/** An evidence id that a finding cites (for the evidence-detail route). */
export const citedEvidenceId: string = (() => {
  const cited = result.report.privacy.findings.flatMap((f) => f.evidence.map((r) => r.id));
  const id = cited.find((i) => /^ev_[0-9a-f]{24}$/.test(i));
  if (!id) throw new Error('sampleResult() has no cited evidence item');
  return id;
})();
