/**
 * All three RPC-library variants (viem / ethers / wagmi) leak the address to
 * the RPC provider before patching — the baseline `igris fix` must erase.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { scan } from '../src/index.js';
import {
  flatLeaks,
  buildFixture,
  HOST_RULES,
  PAGE_PORT,
  REPO_ROOT,
  serveDist,
  startSinkServer,
} from './helpers.js';

const FIXTURE = join(REPO_ROOT, 'fixtures/leaky-dapp');

let pageServer: Server;
let sink: { close: () => Promise<void> };

beforeAll(async () => {
  buildFixture(FIXTURE);
  pageServer = await serveDist(join(FIXTURE, 'dist'), PAGE_PORT);
  sink = await startSinkServer();
}, 180_000);

afterAll(async () => {
  await new Promise((r) => pageServer.close(() => r(undefined)));
  await sink.close();
});

describe.each(['ethers', 'wagmi'] as const)('variant %s', (variant) => {
  it(`leaks the address to the RPC provider via ${variant}`, async () => {
    const result = await scan({
      url: `http://leaky-dapp.test:${PAGE_PORT}/?variant=${variant}`,
      hostResolverRules: HOST_RULES,
      dwellMs: 1500,
    });
    expect(result.report.scan.status).toBe('completed');
    const rpcLeaks = flatLeaks(result).filter(
      (f) => f.class === 'rpc-provider' && f.location === 'request-body' && f.category === 'exact',
    );
    expect(rpcLeaks.length).toBeGreaterThanOrEqual(1);
  }, 180_000);
});
