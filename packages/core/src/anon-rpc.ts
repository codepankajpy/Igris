/**
 * Anon-RPC detection constants.
 *
 * Anonymized Anon-RPC traffic deliberately has no stable wire signature (KPS
 * peers are raw ip:port:certhash over WebRTC — see docs/ANON_RPC_NOTES.md).
 * The documented, reliable signal is the harness's single bootstrap read: one
 * eth_call through the page's EIP-1193 provider whose calldata starts with the
 * selector of workerHash() or workerResolvers() on an IWorkerSpecifier
 * contract (anon-rpc spec v0.4.0 §4).
 */
import { keccak256, toBytes } from 'viem';

function selector(signature: string): string {
  return keccak256(toBytes(signature)).slice(0, 10);
}

/** 4-byte selectors (0x-prefixed) of IWorkerSpecifier's two view functions. */
export const ANON_RPC_SPECIFIER_SELECTORS: readonly string[] = [
  selector('workerHash()'),
  selector('workerResolvers()'),
];

/** Does this wallet-routed request look like the Anon-RPC bootstrap read? */
export function isAnonRpcBootstrapCall(method: string, params: unknown): boolean {
  if (method !== 'eth_call') return false;
  if (!Array.isArray(params) || params.length === 0) return false;
  const call = params[0] as { data?: string; input?: string } | undefined;
  const data = (call?.data ?? call?.input ?? '').toLowerCase();
  return ANON_RPC_SPECIFIER_SELECTORS.some((s) => data.startsWith(s));
}
