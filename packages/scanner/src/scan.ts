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
  type ScanResult,
  type ScanStatus,
  type ThirdPartyEntry,
} from '@igris/core';
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

  // Fresh throwaway key per scan; the canary is its address. The key signs
  // personal_sign / typed-data requests Node-side and is never logged.
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const canaryAddress = account.address;

  const readHandler = new WalletReadHandler(options.liveReadsUrl);
  const recorder = new TrafficRecorder();

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

    await context.addInitScript(
      buildWalletInitScript({ address: canaryAddress, chainId, spoofMetaMask }),
    );

    const page = await context.newPage();
    recorder.attachPage(page);

    // --- Phase A: pre-connect ---
    recorder.setPhase('pre-connect');
    try {
      const response = await page.goto(options.url, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      // An HTTP error page is not the dapp: scoring it would publish a claim
      // about a page we never saw (bot walls, 404s, 5xx).
      if (response && response.status() >= 400) {
        status = 'page-load-failed';
        errors.push(`page load failed: main document returned HTTP ${response.status()}`);
      }
    } catch (err) {
      status = 'page-load-failed';
      errors.push(`page load failed: ${String(err).slice(0, 300)}`);
    }
    if (status === 'completed') {
      await settle(page, dwellMs);
      await recorder.snapshotState(context, page);

      // --- Phase B: post-connect ---
      recorder.setPhase('post-connect');
      const connectLog: string[] = [];
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
      if (!connected) {
        status = 'wallet-connect-failed';
        errors.push(`could not connect wallet (${connectLog.join('; ') || 'no steps ran'})`);
      } else {
        errors.push(...connectLog.map((l) => `connect: ${l}`));
      }
      await settle(page, dwellMs);
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
    status = status === 'completed' ? 'page-load-failed' : status;
    errors.push(`scan error: ${String(err).slice(0, 300)}`);
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    await browser?.close().catch(() => {});
    await egressProxy?.close().catch(() => {});
  }

  // An aborted scan measured an unknown fraction of the page: never score it.
  if (aborted) {
    status = 'page-load-failed';
    errors.push('scan aborted (timeout or cancellation); partial capture discarded from scoring');
  }

  if (egressProxy && egressProxy.blocked.length) {
    const shown = egressProxy.blocked.slice(0, 20);
    for (const b of shown) errors.push(`egress blocked: ${b.host}:${b.port} (${b.reason})`);
    if (egressProxy.blocked.length > shown.length)
      errors.push(`egress blocked: ${egressProxy.blocked.length - shown.length} more`);
  }

  return buildReportFromScan({
    options,
    canaryAddress,
    chainId,
    spoofMetaMask,
    status,
    errors,
    recorder,
    readHandler,
    ...(egressProxy ? { egressBlockedHosts: egressProxy.blockedHosts } : {}),
  });
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
  });
}
