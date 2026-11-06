import { describe, expect, it } from 'vitest';
import { jsonRpcMethods } from './rpc.js';
import { CANARY_A, req, sampleCapture, sampleResult } from './test-helpers.js';

describe('RPC inventory (report 3.0.0 rpc section)', () => {
  it('reads single calls and batches; ignores non-RPC JSON', () => {
    expect(jsonRpcMethods('{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[]}')).toEqual([
      'eth_call',
    ]);
    expect(
      jsonRpcMethods(
        '[{"jsonrpc":"2.0","method":"eth_chainId"},{"event":"x"},{"jsonrpc":"2.0","method":"eth_getBalance"}]',
      ),
    ).toEqual(['eth_chainId', 'eth_getBalance']);
    expect(jsonRpcMethods('{"method":"eth_call"}')).toEqual([]);
    expect(jsonRpcMethods(null)).toEqual([]);
  });

  it('lists each endpoint with method counts and whether the address appeared', () => {
    const c = sampleCapture();
    c.requests.push(
      req({
        phase: 'pre-connect',
        url: 'https://mainnet.infura.io/v3/key',
        method: 'POST',
        resourceType: 'fetch',
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] }),
      }),
    );
    const { report } = sampleResult({ capture: c });
    const infura = report.rpc!.find((e) => e.host === 'mainnet.infura.io')!;
    expect(infura).toMatchObject({ class: 'rpc-provider', requests: 2, addressSeen: true });
    expect(infura.phases).toEqual(['pre-connect', 'post-connect']);
    expect(infura.calls).toEqual([
      { method: 'eth_blockNumber', count: 1 },
      { method: 'eth_getBalance', count: 1 },
    ]);
    // A non-RPC POST (segment) is not an RPC endpoint.
    expect(report.rpc!.some((e) => e.host === 'api.segment.io')).toBe(false);
    expect(CANARY_A).toMatch(/^0x/);
  });
});
