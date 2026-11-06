/**
 * Node-side handler for read RPCs the dapp routes through the mock wallet.
 *
 * Default: answer from a fixed stub and SEND NOTHING to the network — a scan
 * must never leak the canary from the scanner's own IP. `--live-reads <url>`
 * forwards reads to a real endpoint instead (an explicit, documented opt-in).
 *
 * Every call is recorded so the report can show "reads via wallet" (the best
 * case: the dapp let the wallet choose the RPC, no penalty) and so Anon-RPC
 * bootstrap reads can be detected (see @igris/core isAnonRpcBootstrapCall).
 */
import { isAnonRpcBootstrapCall } from '@igris/core';

export interface WalletReadRecord {
  method: string;
  params: unknown;
}

export interface RpcAnswer {
  result?: unknown;
  error?: { code: number; message: string };
}

/** Fixed, deterministic chain state for stubbed answers. */
const STUB_BLOCK_NUMBER = '0x1588e85'; // 22_580_869 — fixed so scans are deterministic
const STUB_BLOCK = {
  number: STUB_BLOCK_NUMBER,
  hash: '0x' + '11'.repeat(32),
  parentHash: '0x' + '22'.repeat(32),
  timestamp: '0x65000000',
  gasLimit: '0x1c9c380',
  gasUsed: '0x0',
  baseFeePerGas: '0x3b9aca00',
  miner: '0x' + '00'.repeat(20),
  difficulty: '0x0',
  totalDifficulty: '0x0',
  extraData: '0x',
  logsBloom: '0x' + '00'.repeat(256),
  transactions: [],
  uncles: [],
  size: '0x0',
  nonce: '0x0000000000000000',
};

export class WalletReadHandler {
  readonly records: WalletReadRecord[] = [];
  anonRpcBootstrapSeen = false;

  constructor(private liveReadsUrl?: string) {}

  async handle(method: string, params: unknown): Promise<RpcAnswer> {
    this.records.push({ method, params });
    if (isAnonRpcBootstrapCall(method, params)) this.anonRpcBootstrapSeen = true;

    if (this.liveReadsUrl) {
      try {
        const res = await fetch(this.liveReadsUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        const json = (await res.json()) as RpcAnswer & { jsonrpc?: string };
        return json.error ? { error: json.error } : { result: json.result };
      } catch (err) {
        return { error: { code: -32000, message: `live read failed: ${String(err)}` } };
      }
    }

    switch (method) {
      case 'eth_getBalance':
      case 'eth_getTransactionCount':
      case 'eth_gasPrice':
      case 'eth_maxPriorityFeePerGas':
      case 'eth_estimateGas':
        return { result: '0x0' };
      case 'eth_blockNumber':
        return { result: STUB_BLOCK_NUMBER };
      case 'eth_call':
        // Empty return data. An Anon-RPC bootstrap read will treat this as a
        // failed specifier read — fine for scanning: the attempt itself is the
        // detection signal, and we never contact the network.
        return { result: '0x' };
      case 'eth_getCode':
        return { result: '0x' };
      case 'eth_getStorageAt':
        return { result: '0x' + '00'.repeat(32) };
      case 'eth_getLogs':
        return { result: [] };
      case 'eth_getBlockByNumber':
      case 'eth_getBlockByHash':
        return { result: STUB_BLOCK };
      case 'eth_feeHistory':
        return {
          result: {
            oldestBlock: STUB_BLOCK_NUMBER,
            baseFeePerGas: ['0x3b9aca00'],
            gasUsedRatio: [0],
            reward: [['0x0']],
          },
        };
      case 'eth_getTransactionByHash':
      case 'eth_getTransactionReceipt':
        return { result: null };
      default:
        return { error: { code: -32601, message: `stub: method ${method} not supported` } };
    }
  }

  /** Aggregate per-method counts for the report. */
  summary(): Array<{ method: string; count: number }> {
    const counts = new Map<string, number>();
    for (const r of this.records) counts.set(r.method, (counts.get(r.method) ?? 0) + 1);
    return [...counts.entries()]
      .map(([method, count]) => ({ method, count }))
      .sort((a, b) => a.method.localeCompare(b.method));
  }
}
