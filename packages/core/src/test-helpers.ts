/**
 * Test-only builders (excluded from the build). A synthetic capture that
 * exercises every built-in detector: exact, hashed and stored canary forms,
 * third-party contacts in both phases, and a main document without
 * protective headers.
 */
import { getAddress, keccak256, stringToBytes } from 'viem';
import type { Capture, CapturedRequest } from './contracts/capture.js';
import { buildScanResult, type ScanResult, type ScanResultInput } from './engine.js';
import { loadThirdPartyDb } from './third-parties.js';

// EIP-55 checksummed, as the scanner's wallet hands them out.
export const CANARY_A = getAddress('0x8ba1f109551bd432803012645ac136ddd64dba72');
export const CANARY_B = getAddress('0x52908400098527886e0f7030069857d2e4169ee7');

export function req(over: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    phase: 'pre-connect',
    url: 'https://app.example.org/',
    method: 'GET',
    headers: {},
    body: null,
    resourceType: 'document',
    failed: false,
    setCookies: [],
    ...over,
  };
}

export function sampleCapture(canary: string = CANARY_A): Capture {
  const lower = canary.toLowerCase();
  const hashed = keccak256(stringToBytes(lower)).slice(2); // hash of the UTF-8 text
  return {
    requests: [
      req(),
      req({ url: 'https://fonts.googleapis.com/css2?family=X', resourceType: 'stylesheet' }),
      req({
        phase: 'post-connect',
        url: 'https://mainnet.infura.io/v3/key',
        method: 'POST',
        resourceType: 'fetch',
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_getBalance',
          params: [lower, 'latest'],
        }),
      }),
      req({
        phase: 'post-connect',
        url: 'https://api.segment.io/v1/t',
        method: 'POST',
        resourceType: 'fetch',
        body: JSON.stringify({ event: 'connect', userId: canary, ts: 1 }),
      }),
      // retry of the same event: must not create a second finding
      req({
        phase: 'post-connect',
        url: 'https://api.segment.io/v1/t',
        method: 'POST',
        resourceType: 'fetch',
        body: JSON.stringify({ event: 'connect', userId: canary, ts: 2 }),
      }),
      req({
        phase: 'post-connect',
        url: `https://o1.ingest.sentry.io/api/1/envelope/?h=${hashed}`,
        method: 'POST',
        resourceType: 'fetch',
      }),
    ],
    wsFrames: [],
    wsConnections: 0,
    storage: [{ phase: 'post-connect', kind: 'local-storage', key: 'wallet', value: canary }],
    cookies: [],
    mainDocument: { url: 'https://app.example.org/', status: 200, headers: {} },
  };
}

export function sampleInput(over: Partial<ScanResultInput> = {}): ScanResultInput {
  return {
    target: 'https://app.example.org/',
    canaryAddress: CANARY_A,
    chainId: 1,
    spoofMetaMask: true,
    scannerVersion: 'test',
    scannedAt: '2026-11-06T00:00:00.000Z',
    status: 'completed',
    egress: 'unrestricted',
    capture: sampleCapture(over.canaryAddress ?? CANARY_A),
    wallet: { readsViaWallet: [], usesAnonRpc: false },
    thirdPartyDb: loadThirdPartyDb().entries,
    notes: [],
    ...over,
  };
}

export function sampleResult(over: Partial<ScanResultInput> = {}): ScanResult {
  return buildScanResult(sampleInput(over));
}
