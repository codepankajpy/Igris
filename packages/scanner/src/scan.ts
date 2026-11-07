/**
 * The scan orchestrator: launch Chromium, inject the canary wallet, run the
 * two phases, build the report.
 *
 * Phase A (pre-connect): load the page, wait for it to settle — this is the
 * IP-exposure baseline (what every visitor leaks before touching a wallet).
 * Phase B (post-connect): click "connect", pick our provider, wait, scroll
 * once to trigger lazy loads. Every capture is tagged with its phase.
 */
import { chromium, type Browser, type LaunchOptions } from 'playwright';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  buildScanResult,
  loadThirdPartyDb,
  type ConnectionDiagnostics,
  type ScanFailure,
  type ScanResult,
  type ScanStatus,
  type ThirdPartyEntry,
} from '@igris/core';
import { classifyLoad, observeLoad } from './load-state.js';
import { connectWithEngine } from './connect/engine.js';
import { TrafficRecorder } from './capture.js';
import { WalletReadHandler } from './stub-rpc.js';
import { buildWalletInitScript } from './wallet-init.js';
import {
  egressChromiumArgs,
  startEgressProxy,
  type EgressProxy,
  type EgressProxyOptions,
} from './egress/proxy.js';

export const SCANNER_VERSION = '0.4.1'; // 0.4.1: connect controls named without icon-font text (app.ens.domains); 0.4.0: wallet requests recorded and decoded; 0.3.0: connect engine (dialog-scoped wallet choice), RPC by behaviour; 0.2.0: Report v2 + evidence bundle

/**
 * Network egress policy for the scanned page.
 *  - unrestricted (the default when no policy is passed; used by the offline
 *    e2e tests, which scan fixtures on *.test → 127.0.0.1): the browser
 *    reaches anything the scanning machine can.
 *  - public-only (mandatory for any hosted scanner): all browser traffic is
 *    forced through an egress-filtering proxy that refuses non-public
 *    addresses and non-allowlisted ports (see egress/proxy.ts).
 */
export type EgressPolicy =
  { mode: 'unrestricted' } | ({ mode: 'public-only' } & EgressProxyOptions);

/** Scan stages, in execution order. Emitted only when the work really happens. */
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

/** A progress event from a running scan (scanner API, not a published contract). */
export interface ScanProgressEvent {
  stage: ScanStage;
  status: 'started' | 'completed' | 'failed' | 'skipped' | 'update';
  at: string;
  detail?: string;
  /** Live capture counters, read from the recorder (never estimated). */
  counters?: { requests: number; hosts: number; wsConnections: number };
}

export interface ScanOptions {
  url: string;
  chainId?: number;
  /** Dwell time after network settle, per phase (ms). */
  dwellMs?: number;
  /** Also claim isMetaMask (default true, documented trade-off). */
  spoofMetaMask?: boolean;
  /** Forward wallet reads to a real RPC endpoint instead of the stub. */
  liveReadsUrl?: string;
  /** Extra first-party domains. */
  firstParty?: string[];
  thirdPartyDb?: ThirdPartyEntry[];
  /** Extra Chromium host-resolver rules, e.g. offline fixture DNS. */
  hostResolverRules?: string;
  headless?: boolean;
  /** Injected for tests; defaults to real wall clock. */
  now?: () => Date;
  /** Default { mode: 'unrestricted' }. Hosted scanners MUST pass public-only. */
  egress?: EgressPolicy;
  /** Called at real execution points (see ScanProgressEvent). Errors in it are ignored. */
  onProgress?: (event: ScanProgressEvent) => void;
  /**
   * Abort the scan (e.g. a hard timeout). The browser is closed immediately;
   * the returned report has status page-load-failed and coverage none.
   */
  signal?: AbortSignal;
  /**
   * Run Chromium inside its own OS sandbox (default false). Needs a host
   * that allows it (Docker: --cap-add=SYS_ADMIN or a Chrome seccomp
   * profile); when it cannot start, the scan fails — it never silently
   * falls back to an unsandboxed browser.
   */
  chromiumSandbox?: boolean;
}

async function settle(page: import('playwright').Page, dwellMs: number): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
  } catch {
    /* busy pages never go idle; the dwell below still applies */
  }
  await page.waitForTimeout(dwellMs);
}

export async function scan(options: ScanOptions): Promise<ScanResult> {
  const chainId = options.chainId ?? 1;
  const dwellMs = options.dwellMs ?? 8000;
  const spoofMetaMask = options.spoofMetaMask ?? true;
  const errors: string[] = [];
  let status: ScanStatus = 'completed';
  let failure: ScanFailure | undefined;
  let connection: ConnectionDiagnostics | undefined;
  let requestAccountsCalls = 0;

  // Fresh throwaway key per scan; the canary is its address. The key signs
  // personal_sign / typed-data requests Node-side and is never logged.
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const canaryAddress = account.address;

  const readHandler = new WalletReadHandler(options.liveReadsUrl);
  const recorder = new TrafficRecorder();
  const counters = () => {
    const hosts = new Set<string>();
    for (const r of recorder.capture.requests) {
      try {
        hosts.add(new URL(r.url).hostname);
      } catch {
        /* data:, blob: */
      }
    }
    return {
      requests: recorder.capture.requests.length,
      hosts: hosts.size,
      wsConnections: recorder.capture.wsConnections,
    };
  };
  const emit = (
    stage: ScanStage,
    status: ScanProgressEvent['status'],
    detail?: string,
    withCounters = false,
  ) => {
    try {
      options.onProgress?.({
        stage,
        status,
        at: new Date().toISOString(),
        ...(detail ? { detail } : {}),
        ...(withCounters ? { counters: counters() } : {}),
      });
    } catch {
      /* a listener must never break a scan */
    }
  };
  /** Settle while streaming live counters once per second. */
  const observe = async (stage: ScanStage, page: import('playwright').Page) => {
    emit(stage, 'started', undefined, true);
    const timer = setInterval(() => emit(stage, 'update', undefined, true), 1000);
    try {
      await settle(page, dwellMs);
    } finally {
      clearInterval(timer);
    }
    emit(stage, 'completed', undefined, true);
  };

  const launchOptions: LaunchOptions = { headless: options.headless ?? true };
  const args: string[] = [];
  if (options.hostResolverRules) args.push(`--host-resolver-rules=${options.hostResolverRules}`);
  let browser: Browser | null = null;
  let egressProxy: EgressProxy | null = null;

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void browser?.close().catch(() => {});
  };
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (aborted) throw new Error('scan aborted before start');
    if (options.egress?.mode === 'public-only') {
      const { mode: _mode, ...proxyOptions } = options.egress;
      egressProxy = await startEgressProxy(proxyOptions);
      args.push(...egressChromiumArgs(egressProxy.url));
    }
    if (args.length) launchOptions.args = args;
    if (options.chromiumSandbox === true) launchOptions.chromiumSandbox = true;
    emit(
      'browser',
      'started',
      `isolated Chromium${options.chromiumSandbox === true ? ' (OS sandbox on)' : ''}, egress ${options.egress?.mode ?? 'unrestricted'}${egressProxy ? ' (filtering proxy)' : ''}`,
    );
    browser = await chromium.launch(launchOptions);
    if (aborted) throw new Error('scan aborted');
    const context = await browser.newContext({
      viewport: { width: 1280, height: 960 },
      serviceWorkers: 'block', // so SW-mediated requests can't dodge capture
      ignoreHTTPSErrors: true,
    });
    recorder.attach(context);

    await context.exposeFunction('__igrisWalletRead', (method: string, params: unknown) =>
      readHandler.handle(method, params),
    );
    // Signs only for a pending request the canary wallet recorded (same
    // frame, call id and method, with the scan's nonce): a page calling
    // __igrisSign itself is refused and nothing is signed.
    await context.exposeBinding(
      '__igrisSign',
      (source, kind: unknown, params: unknown, id: unknown, nonce: unknown) =>
        recorder.signWalletRequest(source.frame, kind, id, nonce, async () => {
          const p = Array.isArray(params) ? params : [];
          // personal_sign params: [message, address]; typed data: [address, json]
          if (kind === 'personal_sign') {
            const message = String(p[0] ?? '');
            return account.signMessage({
              message: message.startsWith('0x') ? { raw: message as `0x${string}` } : message,
            });
          }
          if (kind === 'eth_signTypedData_v4') {
            const json = JSON.parse(String(p[1] ?? '{}'));
            return account.signTypedData(json);
          }
          throw new Error(`unsupported sign kind ${String(kind)}`);
        }),
    );

    // Only the dApp's own main frame counts as "the dApp asked for accounts";
    // a third-party iframe or popup with its own provider does not.
    let mainPage: import('playwright').Page | null = null;
    await context.exposeBinding('__igrisWalletEvent', (source, event: string) => {
      if (
        event === 'eth_requestAccounts' &&
        source.page === mainPage &&
        source.frame === source.page.mainFrame()
      ) {
        requestAccountsCalls += 1;
        recorder.milestone('accounts-requested');
      }
    });

    // Every request the page makes to the canary wallet (connect, sign, send):
    // "main" only for the scan page's own main frame, like accounts above.
    await context.exposeBinding(
      '__igrisWalletRequest',
      (source, method: unknown, params: unknown, outcome: unknown, id: unknown, nonce: unknown) => {
        let origin = 'null';
        try {
          origin = new URL(source.frame.url()).origin;
        } catch {
          /* about:blank, data: … keep "null" */
        }
        recorder.walletRequest({
          frameKey: source.frame,
          frame:
            source.page === mainPage && source.frame === source.page.mainFrame()
              ? 'main'
              : 'iframe',
          origin,
          method,
          params,
          outcome,
          id,
          nonce,
        });
      },
    );

    await context.addInitScript(
      buildWalletInitScript({
        address: canaryAddress,
        chainId,
        spoofMetaMask,
        nonce: recorder.walletNonce,
      }),
    );

    const page = await context.newPage();
    mainPage = page;
    recorder.attachPage(page);
    emit('browser', 'completed', `canary wallet injected (EIP-1193/6963), service workers blocked`);

    // --- Phase A: pre-connect ---
    recorder.setPhase('pre-connect');
    let response: import('playwright').Response | null = null;
    let navError: string | undefined;
    emit('navigation', 'started', options.url);
    recorder.startClock();
    try {
      response = await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      navError = String(err);
    }
    // Not the dapp (unavailable, bot wall, unsupported browser, HTTP error):
    // nothing is reported about a page nobody intended to scan.
    const targetHost = new URL(options.url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const proxyRefusal = egressProxy?.blocked.find(
      (b) => b.host.toLowerCase() === targetHost,
    )?.reason;
    const verdict = classifyLoad(
      navError
        ? { error: navError, ...(proxyRefusal ? { proxyRefusal } : {}) }
        : await observeLoad(page, response),
    );
    if (!verdict.ok) {
      status = 'page-load-failed';
      failure = { category: verdict.category!, detail: verdict.detail ?? '' };
      errors.push(`page load failed: ${verdict.detail ?? verdict.category}`);
      emit('navigation', 'failed', `${verdict.category}: ${verdict.detail ?? ''}`);
      for (const st of ['observe-pre-connect', 'wallet', 'observe-post-connect'] as const)
        emit(st, 'skipped', 'page did not load');
    } else {
      recorder.milestone('page-loaded');
      emit('navigation', 'completed', `HTTP ${response?.status() ?? '?'} · ${page.url()}`, true);
    }
    if (status === 'completed') {
      await observe('observe-pre-connect', page);
      await recorder.snapshotState(context, page);

      // --- Phase B: post-connect ---
      recorder.setPhase('post-connect');
      emit('wallet', 'started', 'opening the connect UI and choosing the canary wallet');
      recorder.milestone('connect-started');
      const hostsSeen = () =>
        new Set(
          recorder.capture.requests.map((r) => {
            try {
              return new URL(r.url).hostname;
            } catch {
              return '';
            }
          }),
        );
      let connected: boolean;
      {
        try {
          connection = await connectWithEngine(page, {
            requestAccounts: () => requestAccountsCalls,
            hosts: hostsSeen,
          });
        } catch (err) {
          // An engine crash must not discard a page that loaded: the scan
          // stays reported as pre-connect-only, with the reason recorded.
          connection = {
            kit: { id: 'none', confidence: 'none', signals: [] },
            strategy: 'generic',
            recipe: 'generic@1',
            outcome: 'failed',
            failure: {
              category: 'scanner-error',
              step: 'connect-engine',
              detail: String(err).slice(0, 480),
            },
            steps: [],
            navigation: { urlChanges: [], aborted: false },
            requestAccountsCalls,
          };
        }
        connected = connection.outcome === 'connected';
      }
      recorder.milestone('connect-finished');
      const stepLog = connection.steps.map((st) => `${st.step} ${st.result}: ${st.detail}`);
      if (!connected) {
        status = 'wallet-connect-failed';
        const f = connection.failure;
        errors.push(
          `could not connect wallet (${f ? `${f.category} at ${f.step}: ${f.detail}` : 'not connected'})`,
        );
        emit('wallet', 'failed', f ? `${f.category}: ${f.detail}` : 'not connected');
      } else {
        errors.push(...stepLog.map((l) => `connect: ${l}`));
        emit(
          'wallet',
          'completed',
          `connected (eth_requestAccounts ×${requestAccountsCalls})${connection.kit.id !== 'none' ? ` · ${connection.kit.id}` : ''} · ${connection.recipe}`,
        );
      }
      await observe('observe-post-connect', page);
      // One scroll to trigger lazy loads.
      try {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000);
      } catch {
        /* non-fatal */
      }
      await recorder.snapshotState(context, page);
      recorder.milestone('observation-ended');
    }

    await context.close();
  } catch (err) {
    if (status === 'completed') {
      status = 'page-load-failed';
      failure = { category: 'scanner-error', detail: String(err).slice(0, 300) };
    }
    errors.push(`scan error: ${String(err).slice(0, 300)}`);
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    await browser?.close().catch(() => {});
    await egressProxy?.close().catch(() => {});
  }

  // An aborted scan measured an unknown fraction of the page: report nothing.
  if (aborted) {
    status = 'page-load-failed';
    failure = { category: 'scanner-error', detail: 'scan aborted (timeout or cancellation)' };
    errors.push('scan aborted (timeout or cancellation); partial capture discarded from scoring');
  }

  if (egressProxy && egressProxy.blocked.length) {
    const shown = egressProxy.blocked.slice(0, 20);
    for (const b of shown) errors.push(`egress blocked: ${b.host}:${b.port} (${b.reason})`);
    if (egressProxy.blocked.length > shown.length)
      errors.push(`egress blocked: ${egressProxy.blocked.length - shown.length} more`);
  }

  emit('detection', 'started', 'canary-leak, ip-exposure, security-headers, wallet-requests');
  let built: ScanResult;
  try {
    built = buildReportFromScan({
      options,
      canaryAddress,
      chainId,
      spoofMetaMask,
      status,
      errors,
      recorder,
      readHandler,
      ...(egressProxy ? { egressBlockedHosts: egressProxy.blockedHosts } : {}),
      ...(connection ? { connection } : {}),
      ...(failure ? { failure } : {}),
    });
  } catch (err) {
    emit('detection', 'failed', String(err).slice(0, 200));
    throw err;
  }
  const r = built.report;
  emit(
    'detection',
    'completed',
    `${r.privacy.findings.length} privacy findings, ${r.security.observations.length} security observations`,
  );
  emit(
    'evidence',
    'completed',
    `${r.evidence.itemCount} items · sha256 ${r.evidence.sha256.slice(0, 16)}…`,
  );
  emit(
    'report',
    'completed',
    r.privacy.coverage === 'none'
      ? 'nothing observed'
      : `${r.recipients.length} recipients · ${r.recipients.filter((x) => x.learned.address === 'exact' || x.learned.address === 'hashed').length} received the address · ${r.recipients.filter((x) => x.verdict === 'tracking' || x.verdict === 'unidentified').length} tracking or unidentified`,
  );
  return built;
}

interface InternalBuildArgs {
  options: ScanOptions;
  canaryAddress: string;
  chainId: number;
  spoofMetaMask: boolean;
  status: ScanStatus;
  errors: string[];
  recorder: TrafficRecorder;
  readHandler: WalletReadHandler;
  egressBlockedHosts?: Set<string>;
  connection?: ConnectionDiagnostics;
  failure?: ScanFailure;
}

function buildReportFromScan(args: InternalBuildArgs): ScanResult {
  const db = args.options.thirdPartyDb ?? loadThirdPartyDb().entries;
  return buildScanResult({
    target: args.options.url,
    canaryAddress: args.canaryAddress,
    chainId: args.chainId,
    spoofMetaMask: args.spoofMetaMask,
    scannerVersion: SCANNER_VERSION,
    scannedAt: (args.options.now?.() ?? new Date()).toISOString(),
    status: args.status,
    egress: args.options.egress?.mode ?? 'unrestricted',
    capture: args.recorder.capture,
    wallet: {
      readsViaWallet: args.readHandler.summary(),
      usesAnonRpc: args.readHandler.anonRpcBootstrapSeen,
    },
    thirdPartyDb: db,
    ...(args.options.firstParty ? { firstParty: args.options.firstParty } : {}),
    notes: args.errors.filter((e) => !e.startsWith('connect: ')),
    connectionLog: args.errors.filter((e) => e.startsWith('connect: ')),
    ...(args.egressBlockedHosts ? { excludeHosts: args.egressBlockedHosts } : {}),
    ...(args.connection ? { connection: args.connection } : {}),
    ...(args.failure ? { failure: args.failure } : {}),
  });
}
