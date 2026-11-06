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
  type FailureCategory,
  type ScanFailure,
  type ScanResult,
  type ScanStatus,
  type ThirdPartyEntry,
} from '@igris/core';
import { classifyLoad, observeLoad } from './load-state.js';
import { collectKitSignals, identifyKit } from './connect/fingerprint.js';
import { TrafficRecorder } from './capture.js';
import { connectWallet, isWalletConnected, type Recipe } from './connect.js';
import { WalletReadHandler } from './stub-rpc.js';
import { buildWalletInitScript } from './wallet-init.js';
import {
  egressChromiumArgs,
  startEgressProxy,
  type EgressProxy,
  type EgressProxyOptions,
} from './egress/proxy.js';

export const SCANNER_VERSION = '0.2.0'; // 0.2.0: emits Report v2 + evidence bundle

/**
 * Network egress policy for the scanned page.
 *  - unrestricted (default for the local CLI): the browser reaches anything
 *    the scanning machine can — needed for localhost / dev / LAN dapps the
 *    user scans on their own machine.
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
  recipe?: Recipe;
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
   * the returned report has status page-load-failed and no score.
   */
  signal?: AbortSignal;
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
    emit(
      'browser',
      'started',
      `isolated Chromium, egress ${options.egress?.mode ?? 'unrestricted'}${egressProxy ? ' (filtering proxy)' : ''}`,
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
    await context.exposeFunction('__igrisSign', async (kind: string, params: unknown[]) => {
      // personal_sign params: [message, address]; typed data: [address, json]
      if (kind === 'personal_sign') {
        const message = String(params[0] ?? '');
        return account.signMessage({
          message: message.startsWith('0x') ? { raw: message as `0x${string}` } : message,
        });
      }
      if (kind === 'eth_signTypedData_v4') {
        const json = JSON.parse(String(params[1] ?? '{}'));
        return account.signTypedData(json);
      }
      throw new Error(`unsupported sign kind ${kind}`);
    });

    await context.exposeFunction('__igrisWalletEvent', (event: string) => {
      if (event === 'eth_requestAccounts') requestAccountsCalls += 1;
    });

    await context.addInitScript(
      buildWalletInitScript({ address: canaryAddress, chainId, spoofMetaMask }),
    );

    const page = await context.newPage();
    recorder.attachPage(page);
    emit('browser', 'completed', `canary wallet injected (EIP-1193/6963), service workers blocked`);

    // --- Phase A: pre-connect ---
    recorder.setPhase('pre-connect');
    let response: import('playwright').Response | null = null;
    let navError: string | undefined;
    emit('navigation', 'started', options.url);
    try {
      response = await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      navError = String(err);
    }
    // Not the dapp (unavailable, bot wall, unsupported browser, HTTP error):
    // never scored — a score would describe a page nobody intended to scan.
    const verdict = classifyLoad(
      navError ? { error: navError } : await observeLoad(page, response),
    );
    if (!verdict.ok) {
      status = 'page-load-failed';
      failure = { category: verdict.category!, detail: verdict.detail ?? '' };
      errors.push(`page load failed: ${verdict.detail ?? verdict.category}`);
      emit('navigation', 'failed', `${verdict.category}: ${verdict.detail ?? ''}`);
      for (const st of ['observe-pre-connect', 'wallet', 'observe-post-connect'] as const)
        emit(st, 'skipped', 'page did not load');
    } else {
      emit('navigation', 'completed', `HTTP ${response?.status() ?? '?'} · ${page.url()}`, true);
    }
    if (status === 'completed') {
      await observe('observe-pre-connect', page);
      await recorder.snapshotState(context, page);

      // --- Phase B: post-connect ---
      recorder.setPhase('post-connect');
      const connectLog: string[] = [];
      emit('wallet', 'started', 'looking for a connect control and wallet option');
      const t0 = Date.now();
      const startUrl = page.url();
      try {
        await connectWallet(page, options.recipe, connectLog);
      } catch (err) {
        connectLog.push(`connect error: ${String(err).slice(0, 200)}`);
      }
      let connected = await isWalletConnected(page);
      if (!connected) {
        for (let poll = 0; poll < 6; poll++) {
          await page.waitForTimeout(500);
          connected = await isWalletConnected(page);
          if (connected) break;
        }
      }
      const hosts = new Set(
        recorder.capture.requests.map((r) => {
          try {
            return new URL(r.url).hostname;
          } catch {
            return '';
          }
        }),
      );
      connection = legacyDiagnostics({
        connected,
        log: connectLog,
        recipeFile: Boolean(options.recipe),
        requestAccountsCalls,
        fingerprint: identifyKit(await collectKitSignals(page, hosts)),
        startUrl,
        endUrl: page.url(),
        ms: Date.now() - t0,
      });
      if (!connected) {
        status = 'wallet-connect-failed';
        errors.push(`could not connect wallet (${connectLog.join('; ') || 'no steps ran'})`);
        emit('wallet', 'failed', connection.failure?.category ?? 'not connected');
      } else {
        errors.push(...connectLog.map((l) => `connect: ${l}`));
        emit(
          'wallet',
          'completed',
          `connected (eth_requestAccounts ×${requestAccountsCalls})${connection.kit.id !== 'none' ? ` · ${connection.kit.id}` : ''}`,
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

  // An aborted scan measured an unknown fraction of the page: never score it.
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

  emit('detection', 'started', 'canary-leak, ip-exposure, security-headers');
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
    r.privacy.score === null ? 'not scored' : `privacy score ${r.privacy.score}/100`,
  );
  return built;
}

/**
 * Diagnostics for the LEGACY connect heuristic (kept until the P1 connect
 * engine replaces it): the outcome plus a coarse failure step reconstructed
 * from its log. Labelled legacy-heuristic@0 so baseline numbers are never
 * mistaken for the new engine's.
 */
function legacyDiagnostics(a: {
  connected: boolean;
  log: string[];
  recipeFile: boolean;
  requestAccountsCalls: number;
  fingerprint: ReturnType<typeof identifyKit>;
  startUrl: string;
  endUrl: string;
  ms: number;
}): ConnectionDiagnostics {
  const clickedConnect = a.log.some((l) => l.startsWith('clicked connect button'));
  const clickedOption = a.log.some((l) => l.startsWith('clicked wallet option'));
  const navigated = a.startUrl !== a.endUrl;
  let category: FailureCategory | null = null;
  let step = '';
  if (!a.connected) {
    if (navigated && new URL(a.startUrl).origin !== new URL(a.endUrl).origin) {
      category = 'unexpected-navigation';
      step = 'open-connect-ui';
    } else if (!clickedConnect && !a.recipeFile) {
      category = 'no-connect-control';
      step = 'find-connect-control';
    } else if (!clickedOption && !a.recipeFile) {
      category = 'wallet-option-missing';
      step = 'select-wallet';
    } else {
      category = 'request-not-issued';
      step = 'await-connection';
    }
  }
  return {
    kit: a.fingerprint,
    strategy: a.recipeFile ? 'recipe-file' : 'generic',
    recipe: a.recipeFile ? 'recipe-file@1' : 'legacy-heuristic@0',
    outcome: a.connected ? 'connected' : 'failed',
    failure: category ? { category, step, detail: a.log.join('; ').slice(0, 480) } : null,
    steps: a.log
      .slice(0, 50)
      .map((l) => ({ step: 'legacy', result: 'ok' as const, detail: l.slice(0, 480), ms: 0 })),
    navigation: { urlChanges: navigated ? [a.endUrl.slice(0, 480)] : [], aborted: false },
    requestAccountsCalls: a.requestAccountsCalls,
  };
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
