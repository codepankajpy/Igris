/**
 * Deterministic API fixtures for the web-app e2e suite, in the exact JSON
 * shapes of apps/api (docs/design/FLOW.md):
 *
 *  - app.example.org has two published versions: v2 is a real Report 3.0.0
 *    built by core's engine from a timed capture (timeline, traffic, RPC
 *    inventory); v1 is a 2.2.0 report migrated to 3.0.0 (timeline and rpc
 *    null — the "not recorded" paths);
 *  - new.example.com has never been scanned;
 *  - a running scan streams progress over SSE and completes as v2;
 *  - a failed scan; a completed scan whose publish failed (retry succeeds)
 *    and whose report is served from the API's cache meanwhile;
 *  - swap.example.net's v1 is served from the API's cache (registry: Arkiv)
 *    with a verification problem.
 *
 * Shapes are typed against the app's own client types (src/api.ts), so drift
 * between this stub and what the app expects fails the e2e typecheck. The
 * reports, summaries and hashes come from @igris/core — nothing hand-written.
 */
import { migrateReportV2toV3, summarise, type ScanResult } from '@igris/core';
import { bundleHash, contentHash, type ReportV3 } from '@igris/core/contracts';
import { sampleCapture, sampleResult, toReportV2 } from '@igris/core/testing';
import type {
  Changes,
  FlowEntity,
  Job,
  PublishedScan,
  RegistryInfo,
  ScanProgressEvent,
  ScanReportResponse,
  ScanStage,
  SiteResponse,
  VersionResponse,
} from '../src/api.js';

export const HOST = 'app.example.org';
export const NEW_HOST = 'new.example.com';
export const OTHER_HOST = 'swap.example.net';

export const RUNNING_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const FAILED_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
export const UNPUBLISHED_ID = '0b5f8a52-3c1e-4d2a-9f60-1a2b3c4d5e6f';

const OWNER = '0x5c0f3e2d9a1b4c6e8f7a9b0c1d2e3f4a5b6c7d8e';
const T0 = Date.parse('2026-11-06T09:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const key = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(32)}`;

// ------------------------------------------------------------------ reports

/** sampleCapture() with capture times, milestones and some first-party traffic. */
function timedCapture() {
  const c = sampleCapture();
  const times = [0, 420, 6_200, 7_100, 7_900, 8_400];
  const requests = c.requests.map((r, i) => ({ ...r, t: times[i] ?? 9_000 }));
  for (let i = 0; i < 18; i++)
    requests.push({
      ...c.requests[0]!,
      url: `https://app.example.org/assets/chunk-${i}.js`,
      resourceType: 'script',
      t: 150 + i * 160 + (i > 10 ? 3_000 : 0),
    });
  requests.push({
    ...c.requests[2]!,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    phase: 'pre-connect',
    t: 1_900,
  });
  return {
    ...c,
    requests,
    milestones: [
      { event: 'page-loaded' as const, t: 2_400 },
      { event: 'connect-started' as const, t: 5_000 },
      { event: 'accounts-requested' as const, t: 5_600 },
      { event: 'connect-finished' as const, t: 6_000 },
      { event: 'observation-ended' as const, t: 11_000 },
    ],
  };
}

export const v2: ScanResult = sampleResult({
  scannedAt: at(0),
  capture: timedCapture(),
  wallet: {
    readsViaWallet: [
      { method: 'eth_blockNumber', count: 3 },
      { method: 'eth_chainId', count: 1 },
    ],
    usesAnonRpc: false,
  },
});

/** v1: an older scan without the error-monitoring call, as a migrated 2.2.0 report. */
export const v1: ScanResult = (() => {
  const c = sampleCapture();
  const old = sampleResult({
    scannedAt: at(-7 * 86_400_000),
    capture: { ...c, requests: c.requests.filter((r) => !r.url.includes('sentry')) },
  });
  const v = toReportV2(old);
  return migrateReportV2toV3(v.report, v.bundle);
})();

function published(r: ScanResult, version: number, hostname = HOST): PublishedScan {
  const report: ReportV3 = r.report;
  const s = summarise(report, r.bundle);
  const addr = report.recipients.filter(
    (x) => x.learned.address === 'exact' || x.learned.address === 'hashed',
  );
  return {
    key: key(version + (hostname === HOST ? 0 : 40)),
    owner: OWNER,
    hostname,
    version,
    previous: version > 1 ? key(version - 1) : null,
    scannedAt: Math.floor(Date.parse(report.scan.scannedAt) / 1000),
    scanId: contentHash(report),
    evidenceSha256: bundleHash(r.bundle),
    findingSetSha256: report.findingSet.sha256,
    state: s.state,
    coverage: report.privacy.coverage === 'full' ? 'full' : 'pre-connect-only',
    recipients: report.recipients.length,
    addressRecipients: addr.length,
    trackingRecipients: report.recipients.filter(
      (x) => x.verdict === 'tracking' || x.verdict === 'unidentified',
    ).length,
    usesAnonRpc: report.wallet.usesAnonRpc,
    scannerVersion: report.scan.scannerVersion,
    reportVersion: report.reportVersion,
    expiresAtBlock: 9_000_000 + version,
  };
}

export const scanV1 = published(v1, 1);
export const scanV2 = published(v2, 2);
export const summaryV2 = summarise(v2.report, v2.bundle);

/** v2 vs v1, recipient by recipient (the API's diffVersions does this server-side). */
function diff(prev: ReportV3, next: ReportV3): Changes {
  const k = (r: { registrableDomain: string; class: string }) =>
    `${r.registrableDomain}|${r.class}`;
  const a = new Map(prev.recipients.map((r) => [k(r), r]));
  const b = new Map(next.recipients.map((r) => [k(r), r]));
  const ref = (r: { registrableDomain: string; class: string }) => ({
    registrableDomain: r.registrableDomain,
    class: r.class,
  });
  return {
    sameBehaviour: prev.findingSet.sha256 === next.findingSet.sha256,
    added: [...b.values()].filter((r) => !a.has(k(r))).map(ref),
    removed: [...a.values()].filter((r) => !b.has(k(r))).map(ref),
    changed: [...b.values()]
      .filter((r) => {
        const p = a.get(k(r));
        return p && (p.verdict !== r.verdict || p.learned.address !== r.learned.address);
      })
      .map((r) => {
        const p = a.get(k(r))!;
        return {
          ref: ref(r),
          from: { verdict: p.verdict, address: p.learned.address },
          to: { verdict: r.verdict, address: r.learned.address },
        };
      }),
  };
}

export const versionBodies: Record<number, VersionResponse> = {
  1: {
    scan: scanV1,
    report: v1.report,
    evidence: v1.bundle,
    verified: true,
    problems: [],
    summary: summarise(v1.report, v1.bundle),
    changes: null,
    source: 'arkiv',
  },
  2: {
    scan: scanV2,
    report: v2.report,
    evidence: v2.bundle,
    verified: true,
    problems: [],
    summary: summaryV2,
    changes: diff(v1.report, v2.report),
    source: 'arkiv',
  },
};

/** A problem the API reported while still verifying the report it served. */
export const CACHE_PROBLEM = 'Arkiv read failed (timeout); served from the local cache';

export const registry: RegistryInfo = {
  mode: 'arkiv',
  network: 'arkiv-rabdi-testnet',
  explorer: 'https://rabdi.explorer.arkiv.network',
  publishing: true,
  ready: true,
};

export const sites: PublishedScan[] = [scanV2, published(v2, 1, OTHER_HOST)];

/** swap.example.net v1: published on Arkiv, served from this server's cache, one problem. */
export const cachedVersionBody: VersionResponse = {
  scan: sites[1]!,
  report: v2.report,
  evidence: v2.bundle,
  verified: true,
  problems: [CACHE_PROBLEM],
  summary: summaryV2,
  changes: null,
  source: 'local',
};

export function siteBody(hostname: string): SiteResponse {
  if (hostname === HOST) return { hostname, versions: [scanV2, scanV1], scanning: null };
  if (hostname === OTHER_HOST) return { hostname, versions: [sites[1]!], scanning: null };
  return { hostname, versions: [], scanning: null };
}

/** Flows to a recipient across scanned sites (igris.flow.v1). */
export function flowsTo(domain: string): FlowEntity[] {
  const hosts = domain === 'segment.io' ? [HOST, OTHER_HOST, 'bridge.example.io'] : [HOST];
  return hosts.map((hostname, i) => ({
    key: key(100 + i),
    owner: OWNER,
    hostname,
    recipient: domain,
    class: 'analytics',
    verdict: 'tracking',
    address: 'exact',
    preConnect: false,
    version: 1,
    scanId: scanV2.scanId,
    scannedAt: scanV2.scannedAt,
  }));
}

/** An evidence id that a finding cites (for the evidence-detail route). */
export const citedEvidenceId: string = (() => {
  const cited = v2.report.privacy.findings.flatMap((f) => f.evidence.map((r) => r.id));
  const id = cited.find((i) => /^ev_[0-9a-f]{24}$/.test(i));
  if (!id) throw new Error('the v2 fixture has no cited evidence item');
  return id;
})();

// ------------------------------------------------------------------ jobs

const counters = (requests: number, hosts: number) => ({ requests, hosts, wsConnections: 0 });

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

/** Progress the running scan's SSE stream replays before its final `done`. */
export const runningProgress: ScanProgressEvent[] = [
  { stage: 'browser', status: 'started', at: at(60_000) },
  { stage: 'browser', status: 'completed', at: at(60_900) },
  { stage: 'navigation', status: 'started', at: at(61_000), detail: 'https://app.example.org/' },
  { stage: 'navigation', status: 'completed', at: at(63_200) },
  { stage: 'observe-pre-connect', status: 'update', at: at(64_000), counters: counters(18, 5) },
];

const publishedOk: Job['publish'] = {
  ok: true,
  mode: 'arkiv',
  scanKey: scanV2.key,
  evidenceKey: key(60),
  flowKeys: [key(61), key(62), key(63)],
  txHash: `0x${'ab'.repeat(32)}`,
};

export const runningJob: Job = {
  id: RUNNING_ID,
  hostname: HOST,
  url: 'https://app.example.org/',
  state: 'running',
  createdAt: at(59_000),
  startedAt: at(60_000),
  events: runningProgress.slice(0, 2),
  version: null,
  publish: null,
};

/** GET /api/scans/:id for the running scan once its stream said `done`. */
export const runningDoneJob: Job = {
  ...runningJob,
  state: 'completed',
  finishedAt: at(75_000),
  events: [...runningProgress, ...fullRun(65_000).slice(6)],
  version: 2,
  publish: publishedOk,
};

export const failedJob: Job = {
  id: FAILED_ID,
  hostname: NEW_HOST,
  url: 'https://new.example.com/',
  state: 'failed',
  createdAt: at(-120_000),
  startedAt: at(-119_900),
  finishedAt: at(-110_000),
  error: 'The page did not load: DNS lookup for new.example.com failed.',
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
  version: null,
  publish: null,
};

export const PUBLISH_ERROR = 'Arkiv RPC unreachable (timeout after 20 s)';

export const unpublishedJob: Job = {
  id: UNPUBLISHED_ID,
  hostname: HOST,
  url: 'https://app.example.org/',
  state: 'completed',
  createdAt: at(0),
  startedAt: at(100),
  finishedAt: at(17_000),
  events: fullRun(100),
  version: null,
  publish: { ok: false, error: PUBLISH_ERROR },
};

export const republishedJob: Job = { ...unpublishedJob, version: 2, publish: publishedOk };

/** SSE body exactly as apps/api writes it: state, replayed progress, done. */
export function sseBody(progress: ScanProgressEvent[]): string {
  const send = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    send('state', { state: 'running' }) +
    progress.map((e) => send('progress', e)).join('') +
    send('done', {
      state: 'completed',
      hostname: HOST,
      version: 2,
      error: null,
      publish: publishedOk,
    })
  );
}

/** GET /api/scans/:id/report for the completed, unpublished scan (from the API's cache). */
export const unpublishedReport: ScanReportResponse = {
  report: v2.report,
  evidence: v2.bundle,
  verified: true,
  problems: [],
  summary: summaryV2,
  source: 'local',
};
