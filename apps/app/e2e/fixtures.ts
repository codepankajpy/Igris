/**
 * Deterministic API fixtures for the web-app e2e suite, in the exact JSON
 * shapes of apps/api (docs/design/FLOW.md, docs/design/SCAN-NETWORK.md):
 *
 *  - app.example.org has three published versions: v3 (Scanner 2) and v2
 *    (Scanner 1) are two nodes' Report 3.0.0 scans for ONE open request (a
 *    round of two, with the API's per-recipient agreement), built by core's
 *    engine from timed captures that include the wallet-request fixture flow
 *    (connect, a SIWE message for another domain, an unlimited Permit2 naming
 *    the wrong chain, an approve(spender, MAX) transaction); v1 is a 2.2.0
 *    report migrated to 3.0.0 (timeline, rpc and walletRequests null — the
 *    "not recorded" paths);
 *  - new.example.com has never been scanned;
 *  - a running scan streams progress over SSE and completes as v2;
 *  - a failed scan; a completed scan whose publish failed (retry succeeds)
 *    and whose report is served from the API's cache meanwhile;
 *  - swap.example.net's v1 is served from the API's cache (registry: Arkiv)
 *    with a verification problem; its page asked the wallet for nothing;
 *  - the v2 + v3 round once its request entity has expired (request: null).
 *
 * Like the API (apps/api/src/public.ts), no response carries a signer
 * address: no `owner` on scans or flows, no `creator` on requests.
 *
 * Shapes are typed against the app's own client types (src/api.ts), so drift
 * between this stub and what the app expects fails the e2e typecheck. The
 * reports, summaries and hashes come from @igris/core — nothing hand-written.
 */
import { migrateReportV2toV3, summarise, type ScanResult } from '@igris/core';
import {
  PERMIT2_ADDRESS,
  bundleHash,
  contentHash,
  type CapturedWalletRequest,
  type RecordedWalletMethod,
  type ReportV3,
} from '@igris/core/contracts';
import { CANARY_A, CANARY_B, sampleCapture, sampleResult, toReportV2 } from '@igris/core/testing';
import type {
  Agreement,
  Changes,
  FlowEntity,
  Job,
  NodeInfo,
  PublishedScan,
  RegistryInfo,
  RoundResponse,
  ScanProgressEvent,
  ScanReportResponse,
  ScanRequest,
  ScanStage,
  ScanStarted,
  SiteResponse,
  VersionResponse,
} from '../src/api.js';

export const HOST = 'app.example.org';
export const NEW_HOST = 'new.example.com';
export const OTHER_HOST = 'swap.example.net';

export const RUNNING_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const FAILED_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
export const UNPUBLISHED_ID = '0b5f8a52-3c1e-4d2a-9f60-1a2b3c4d5e6f';

export const NODES: NodeInfo[] = [
  { label: 'Scanner 1', self: true },
  { label: 'Scanner 2', self: false },
];
const T0 = Date.parse('2026-11-06T09:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const key = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(32)}`;

// ------------------------------------------------------------------ reports

const SPENDER = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const SCAN_S = Math.floor(T0 / 1000);
const hex = (text: string) => `0x${Buffer.from(text, 'utf8').toString('hex')}`;
const word = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');

/**
 * The wallet-request fixture flow (fixtures/wallet-requests): after connect,
 * a SIWE message for another domain, an unlimited Permit2 naming chain 137
 * (the wallet is on chain 1), and an approve(spender, MAX) transaction.
 */
function walletFlow(canary: string): CapturedWalletRequest[] {
  const cap = (
    method: RecordedWalletMethod,
    params: unknown,
    t: number,
    outcome: CapturedWalletRequest['outcome'] = 'signed',
  ): CapturedWalletRequest => ({
    phase: 'post-connect',
    t,
    method,
    params: JSON.stringify(params),
    frame: 'main',
    origin: 'https://app.example.org',
    outcome,
  });
  const siwe =
    `evil.example wants you to sign in with your Ethereum account:\n${canary}\n\nSign in.\n\n` +
    `URI: https://evil.example\nVersion: 1\nChain ID: 1\nNonce: 1\nIssued At: 2026-11-06T09:00:05Z`;
  const permit2 = {
    types: { EIP712Domain: [] },
    primaryType: 'PermitSingle',
    domain: { name: 'Permit2', chainId: 137, verifyingContract: PERMIT2_ADDRESS },
    message: {
      details: { token: USDC, amount: ((1n << 160n) - 1n).toString(), expiration: SCAN_S + 3600 },
      spender: SPENDER,
      sigDeadline: SCAN_S + 60,
    },
  };
  const approve = `0x095ea7b3${word(SPENDER)}${'f'.repeat(64)}`;
  return [
    cap('eth_requestAccounts', [], 5_600, 'answered'),
    cap('personal_sign', [hex(siwe), canary], 6_300),
    cap('eth_signTypedData_v4', [canary, JSON.stringify(permit2)], 6_900),
    cap('eth_sendTransaction', [{ from: canary, to: USDC, data: approve }], 7_500, 'rejected'),
  ];
}

/**
 * sampleCapture() with capture times, milestones, some first-party traffic and
 * (optionally) the wallet flow. `second` is the other node's run of the same
 * page: no error-monitoring call, and the analytics event without the address.
 */
function timedCapture(
  canary: string,
  opts: { wallet: CapturedWalletRequest[] | undefined; second?: boolean },
) {
  const c = sampleCapture(canary);
  const times = [0, 420, 6_200, 7_100, 7_900, 8_400];
  let requests = c.requests.map((r, i) => ({ ...r, t: times[i] ?? 9_000 }));
  if (opts.second)
    requests = requests
      .filter((r) => !r.url.includes('sentry'))
      .map((r) =>
        r.url.includes('segment') ? { ...r, body: JSON.stringify({ event: 'connect' }) } : r,
      );
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
    ...(opts.wallet ? { walletRequests: opts.wallet } : {}),
    milestones: [
      { event: 'page-loaded' as const, t: 2_400 },
      { event: 'connect-started' as const, t: 5_000 },
      { event: 'accounts-requested' as const, t: 5_600 },
      { event: 'connect-finished' as const, t: 6_000 },
      { event: 'observation-ended' as const, t: 11_000 },
    ],
  };
}

const wallet = {
  readsViaWallet: [
    { method: 'eth_blockNumber', count: 3 },
    { method: 'eth_chainId', count: 1 },
  ],
  usesAnonRpc: false,
};

/** Scanner 1's scan for the request (with the wallet flow). */
export const v2: ScanResult = sampleResult({
  scannedAt: at(0),
  capture: timedCapture(CANARY_A, { wallet: walletFlow(CANARY_A) }),
  wallet,
});

/** Scanner 2's scan for the same request: its own throwaway wallet, its own run of the page. */
export const v3: ScanResult = sampleResult({
  scannedAt: at(40_000),
  canaryAddress: CANARY_B,
  capture: timedCapture(CANARY_B, { wallet: walletFlow(CANARY_B), second: true }),
  wallet,
});

/** swap.example.net: recorded wallet requests, none of them (walletRequests: []). */
export const vQuiet: ScanResult = sampleResult({
  scannedAt: at(0),
  capture: timedCapture(CANARY_A, { wallet: [] }),
  wallet,
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

function published(
  r: ScanResult,
  version: number,
  hostname = HOST,
  opts: { request?: string | null } = {},
): PublishedScan {
  const report: ReportV3 = r.report;
  const s = summarise(report, r.bundle);
  const addr = report.recipients.filter(
    (x) => x.learned.address === 'exact' || x.learned.address === 'hashed',
  );
  return {
    key: key(version + (hostname === HOST ? 0 : 40)),
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
    request: opts.request ?? null,
  };
}

/** The open request v2 and v3 fulfilled (igris.request.v1). */
export const REQUEST: ScanRequest = {
  key: key(70),
  hostname: HOST,
  url: 'https://app.example.org/',
  requestedAt: Math.floor(T0 / 1000) - 30,
  expiresAtBlock: 9_100_000,
};

/** The request a Retest creates (POST /api/sites/:hostname/scans). */
export const RETEST_REQUEST: ScanRequest = {
  ...REQUEST,
  key: key(71),
  requestedAt: Math.floor(T0 / 1000) + 59,
};

export const scanV1 = published(v1, 1);
export const scanV2 = published(v2, 2, HOST, { request: REQUEST.key });
export const scanV3 = published(v3, 3, HOST, { request: REQUEST.key });
export const summaryV2 = summarise(v2.report, v2.bundle);
export const summaryV3 = summarise(v3.report, v3.bundle);

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
    node: 'Scanner 1',
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
    node: 'Scanner 1',
  },
  3: {
    scan: scanV3,
    report: v3.report,
    evidence: v3.bundle,
    verified: true,
    problems: [],
    summary: summaryV3,
    changes: diff(v2.report, v3.report),
    source: 'arkiv',
    node: 'Scanner 2',
  },
};

/**
 * The API's comparison of a round's reports, recipient by recipient
 * (registrableDomain, class): agree / differ / partial.
 */
function agreement(byNode: Array<[string, ReportV3]>): Agreement {
  const k = (r: { registrableDomain: string; class: string }) =>
    `${r.registrableDomain}|${r.class}`;
  const keys = new Map<string, { registrableDomain: string; class: string }>();
  for (const [, rep] of byNode)
    for (const r of rep.recipients)
      keys.set(k(r), { registrableDomain: r.registrableDomain, class: r.class });
  const got = (a: string) => a === 'exact' || a === 'hashed';
  const rows: Agreement['rows'] = [...keys.values()]
    .sort((a, b) => k(a).localeCompare(k(b)))
    .map((ref) => {
      const cells: Agreement['rows'][number]['byNode'] = {};
      for (const [node, rep] of byNode) {
        const r = rep.recipients.find((x) => k(x) === k(ref));
        cells[node] = r ? { verdict: r.verdict, address: r.learned.address } : null;
      }
      const seen = Object.values(cells);
      const status = seen.some((c) => c === null)
        ? ('partial' as const)
        : seen.every(
              (c) => c!.verdict === seen[0]!.verdict && got(c!.address) === got(seen[0]!.address),
            )
          ? ('agree' as const)
          : ('differ' as const);
      return { ...ref, byNode: cells, status };
    });
  const count = (st: string) => rows.filter((r) => r.status === st).length;
  return {
    nodes: byNode.map(([n]) => n),
    rows,
    summary: { agree: count('agree'), differ: count('differ'), partial: count('partial') },
  };
}

/** GET /api/sites/:hostname/rounds/:requestKey for the round of v2 + v3. */
export const roundBody: RoundResponse = {
  request: REQUEST,
  scans: [
    { scan: scanV3, node: 'Scanner 2', verified: true },
    { scan: scanV2, node: 'Scanner 1', verified: true },
  ],
  agreement: agreement([
    ['Scanner 1', v2.report],
    ['Scanner 2', v3.report],
  ]),
};

/**
 * The same round once its request entity has expired on Arkiv: the API sends
 * request: null; the scans (each still naming the request's key) and the
 * agreement come back.
 */
export const expiredRoundBody: RoundResponse = { ...roundBody, request: null };

/** A problem the API reported while still verifying the report it served. */
export const CACHE_PROBLEM = 'Arkiv read failed (timeout); served from the local cache';

export const registry: RegistryInfo = {
  mode: 'arkiv',
  network: 'arkiv-rabdi-testnet',
  explorer: 'https://rabdi.explorer.arkiv.network',
  publishing: true,
  ready: true,
};

export const sites: PublishedScan[] = [scanV3, published(vQuiet, 1, OTHER_HOST)];

/** swap.example.net v1: published on Arkiv, served from this server's cache, one problem. */
export const cachedVersionBody: VersionResponse = {
  scan: sites[1]!,
  report: vQuiet.report,
  evidence: vQuiet.bundle,
  verified: true,
  problems: [CACHE_PROBLEM],
  summary: summarise(vQuiet.report, vQuiet.bundle),
  changes: null,
  source: 'local',
  node: 'Scanner 1',
};

export function siteBody(hostname: string): SiteResponse {
  if (hostname === HOST)
    return {
      hostname,
      versions: [scanV3, scanV2, scanV1],
      scanning: null,
      rounds: [
        {
          request: REQUEST,
          scans: [
            { version: 3, key: scanV3.key, node: 'Scanner 2' },
            { version: 2, key: scanV2.key, node: 'Scanner 1' },
          ],
        },
        { request: null, scans: [{ version: 1, key: scanV1.key, node: 'Scanner 1' }] },
      ],
    };
  if (hostname === OTHER_HOST)
    return {
      hostname,
      versions: [sites[1]!],
      scanning: null,
      rounds: [{ request: null, scans: [{ version: 1, key: sites[1]!.key, node: 'Scanner 1' }] }],
    };
  return { hostname, versions: [], scanning: null, rounds: [] };
}

/** GET /api/sites/:hostname after the round's request expired: rounds keep their scans, request: null. */
export function expiredSiteBody(hostname: string): SiteResponse {
  const b = siteBody(hostname);
  return { ...b, rounds: b.rounds.map((r) => ({ ...r, request: null })) };
}

/** POST /api/sites/:hostname/scans: a retest makes a request; the first scan of NEW_HOST none. */
export function scanStarted(hostname: string): ScanStarted {
  return hostname === HOST
    ? { id: RUNNING_ID, request: RETEST_REQUEST }
    : { id: FAILED_ID, request: null };
}

/** Flows to a recipient across scanned sites (igris.flow.v1). */
export function flowsTo(domain: string): FlowEntity[] {
  const hosts = domain === 'segment.io' ? [HOST, OTHER_HOST, 'bridge.example.io'] : [HOST];
  return hosts.map((hostname, i) => ({
    key: key(100 + i),
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

/** A wallet-request evidence item the v2 report's walletRequests point at (the SIWE request). */
export const walletEvidenceId: string = (() => {
  const siwe = v2.report.walletRequests?.find((r) => r.kind === 'siwe');
  if (!siwe) throw new Error('the v2 fixture has no SIWE wallet request');
  return siwe.evidenceId;
})();
