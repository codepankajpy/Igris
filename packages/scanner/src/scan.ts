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
  loadThirdPartyDb,
  type Report,
  type ScanStatus,
  type ThirdPartyEntry,
} from '@igris/core';
import { TrafficRecorder } from './capture.js';
import { connectWallet, isWalletConnected, type Recipe } from './connect.js';
import { WalletReadHandler } from './stub-rpc.js';
import { buildWalletInitScript } from './wallet-init.js';

export const SCANNER_VERSION = '0.1.0';

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
}

async function settle(page: import('playwright').Page, dwellMs: number): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
  } catch {
    /* busy pages never go idle; the dwell below still applies */
  }
  await page.waitForTimeout(dwellMs);
}

export async function scan(options: ScanOptions): Promise<Report> {
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
  if (options.hostResolverRules) {
    launchOptions.args = [`--host-resolver-rules=${options.hostResolverRules}`];
  }
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
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
      await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
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
      const connected = await isWalletConnected(page);
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
    await browser?.close().catch(() => {});
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
}

async function buildReportFromScan(args: InternalBuildArgs): Promise<Report> {
  const { buildReport } = await import('./report-builder.js');
  const db = args.options.thirdPartyDb ?? loadThirdPartyDb().entries;
  return buildReport({
    target: args.options.url,
    canaryAddress: args.canaryAddress,
    chainId: args.chainId,
    spoofMetaMask: args.spoofMetaMask,
    scannerVersion: SCANNER_VERSION,
    scannedAt: (args.options.now?.() ?? new Date()).toISOString(),
    status: args.status,
    capture: args.recorder.capture,
    readHandler: args.readHandler,
    thirdPartyDb: db,
    ...(args.options.firstParty ? { firstParty: args.options.firstParty } : {}),
    errors: args.errors,
  });
}
