/**
 * Public views of registry rows: everything the API returns outside report
 * and evidence payloads goes through these. Signer addresses (a scan's
 * owner, a request's creator) are never part of a response — nodes are
 * named "Scanner n" (nodes.ts) and each entity links to Arkiv, where the
 * signer is public by design.
 */
import type { FlowEntity, PublishedScan, ScanRequest, WalletRequestEntity } from '@igris/registry';

export type PublicScan = Omit<PublishedScan, 'owner'>;
export type PublicRequest = Omit<ScanRequest, 'creator'>;
export type PublicFlow = Omit<FlowEntity, 'owner'>;
export type PublicWalletRequest = Omit<WalletRequestEntity, 'owner'>;

export function publicScan(s: PublishedScan): PublicScan {
  const { owner: _owner, ...rest } = s;
  return rest;
}

export function publicRequest(r: ScanRequest): PublicRequest {
  const { creator: _creator, ...rest } = r;
  return rest;
}

export function publicFlow(f: FlowEntity): PublicFlow {
  const { owner: _owner, ...rest } = f;
  return rest;
}

/**
 * verifyingContract / spender stay: they are what the site asked the wallet
 * to sign for (the finding itself), not the identity of a scanner.
 */
export function publicWalletRequest(w: WalletRequestEntity): PublicWalletRequest {
  const { owner: _owner, ...rest } = w;
  return rest;
}

/** A 20-byte address on its own (not the prefix of a 32-byte entity key or hash). */
const ADDRESS_G = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

/**
 * Error text for logs and error responses: registry / RPC errors can quote
 * the signer (e.g. "insufficient funds … for 0xab…"); addresses are elided.
 */
export function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(ADDRESS_G, '0x…').slice(0, 300);
}
