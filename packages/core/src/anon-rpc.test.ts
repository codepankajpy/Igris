import { describe, expect, it } from 'vitest';
import { ANON_RPC_SPECIFIER_SELECTORS, isAnonRpcBootstrapCall } from './anon-rpc.js';

describe('anon-rpc bootstrap detection', () => {
  it('selectors are 4-byte hex', () => {
    for (const s of ANON_RPC_SPECIFIER_SELECTORS) expect(s).toMatch(/^0x[0-9a-f]{8}$/);
    expect(new Set(ANON_RPC_SPECIFIER_SELECTORS).size).toBe(2);
  });

  it('matches an eth_call to workerHash()', () => {
    const data = ANON_RPC_SPECIFIER_SELECTORS[0]!;
    expect(isAnonRpcBootstrapCall('eth_call', [{ to: '0x4fd7…', data }, 'latest'])).toBe(true);
  });

  it('matches when calldata is in `input` instead of `data`', () => {
    const input = ANON_RPC_SPECIFIER_SELECTORS[1]!;
    expect(isAnonRpcBootstrapCall('eth_call', [{ input }])).toBe(true);
  });

  it('ignores other methods and other selectors', () => {
    expect(isAnonRpcBootstrapCall('eth_getBalance', [{ data: ANON_RPC_SPECIFIER_SELECTORS[0] }])).toBe(false);
    expect(isAnonRpcBootstrapCall('eth_call', [{ data: '0x70a08231' }])).toBe(false);
    expect(isAnonRpcBootstrapCall('eth_call', [])).toBe(false);
    expect(isAnonRpcBootstrapCall('eth_call', 'nonsense')).toBe(false);
  });
});
