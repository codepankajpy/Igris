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

/** Known specifier contract addresses from adopters.json5 (2026-11-06). */
export const KNOWN_SPECIFIERS = {
  passthrough: '0x4fd77be300f31c5fe6ab266d35d27750a3478d27',
  torJs: '0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e',
  nym: '0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0',
  nox: '0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A',
} as const;

/** Does this wallet-routed request look like the Anon-RPC bootstrap read? */
export function isAnonRpcBootstrapCall(method: string, params: unknown): boolean {
  if (method !== 'eth_call') return false;
  if (!Array.isArray(params) || params.length === 0) return false;
  const call = params[0] as { data?: string; input?: string } | undefined;
  const data = (call?.data ?? call?.input ?? '').toLowerCase();
  return ANON_RPC_SPECIFIER_SELECTORS.some((s) => data.startsWith(s));
}
