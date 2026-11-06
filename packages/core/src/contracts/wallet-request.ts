/**
 * Wallet requests (design: docs/design/WALLET-REQUESTS.md). What the dApp
 * asked the canary wallet to do — connect, sign a message, sign typed data,
 * send a transaction — captured, decoded and published. SHARED TYPES: the
 * core/scanner, registry, API and website all build against these.
 *
 * Browser-safe (types and constants only).
 */
import type { Phase } from '../report.js';

/** Methods the canary wallet records (reads such as eth_call are not requests). */
export const RECORDED_WALLET_METHODS = [
  'eth_requestAccounts',
  'wallet_requestPermissions',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'wallet_watchAsset',
  'personal_sign',
  'eth_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
  'eth_signTransaction',
  'eth_sendRawTransaction',
] as const;
export type RecordedWalletMethod = (typeof RECORDED_WALLET_METHODS)[number];

/** One request as the scanner saw it (capture: internal, unredacted). */
export interface CapturedWalletRequest {
  phase: Phase;
  /** ms since navigation start. */
  t?: number;
  method: RecordedWalletMethod;
  /** The raw params, JSON-serialised by the page (may contain the canary). */
  params: string;
  /** Which frame called the provider. */
  frame: 'main' | 'iframe';
  /** Origin of the calling frame. */
  origin: string;
  /** What the canary wallet did. */
  outcome: 'answered' | 'signed' | 'rejected' | 'error';
}

/** What a request is, decoded (deterministic, offline). */
export const WALLET_REQUEST_KINDS = [
  'connect', // eth_requestAccounts / wallet_requestPermissions
  'switch-chain',
  'add-chain',
  'watch-asset',
  'siwe', // personal_sign of an EIP-4361 message
  'personal-message', // personal_sign of readable text
  'blind-hash', // personal_sign of a bare 32-byte hash / unreadable bytes
  'eth-sign', // eth_sign (raw hash signing)
  'permit', // EIP-2612 Permit typed data
  'permit2', // Uniswap Permit2 typed data (PermitSingle / PermitBatch / PermitTransferFrom…)
  'typed-data', // any other EIP-712 typed data
  'approve', // tx: ERC-20 approve(spender, amount)
  'set-approval-for-all', // tx: setApprovalForAll(operator, true)
  'transaction', // any other transaction request
] as const;
export type WalletRequestKind = (typeof WALLET_REQUEST_KINDS)[number];

/**
 * Evidence item (bundle igris.evidence.v4): the decoded request, canary-free.
 * Raw params are never stored; `paramsDigest` = sha256 of the canonical
 * params with every canary form replaced by "<CANARY>".
 */
export interface WalletRequestEvidence {
  type: 'wallet-request';
  phase: Phase;
  method: RecordedWalletMethod;
  kind: WalletRequestKind;
  frame: 'main' | 'iframe';
  origin: string;
  outcome: 'answered' | 'signed' | 'rejected' | 'error';
  /** Chain id the request names (typed-data domain, SIWE Chain ID, switch target), else null. */
  chainId: number | null;
  /** EIP-712 domain verifyingContract (checksummed), else null. */
  verifyingContract: string | null;
  /** Permit / approve spender or setApprovalForAll operator (checksummed), else null. */
  spender: string | null;
  /** Token being permitted / approved (checksummed), else null. */
  token: string | null;
  /** Amount as a decimal string, else null. */
  amount: string | null;
  /** Deadline / expiration as a decimal string (unix seconds), else null. */
  deadline: string | null;
  /** SIWE `domain` field, else null. */
  siweDomain: string | null;
  /** Amount ≥ 2^160 − 1 (Permit2 max) or ≥ 2^255, or MAX_UINT256. */
  unlimited: boolean;
  /** Deadline > scan time + 30 days (or the max value). */
  longDeadline: boolean;
  /** Named chain ≠ the chain the wallet was on. */
  chainIdMismatch: boolean;
  /** SIWE domain/URI does not match the page that asked. */
  domainMismatch: boolean;
  /** Asked before the dApp requested accounts. */
  preConnect: boolean;
  paramsDigest: string;
}

/**
 * Report 3.0.0 `walletRequests[]`: one per recorded request, in request order
 * (identical requests share one content-addressed evidence item).
 */
export interface WalletRequestSummary {
  evidenceId: string;
  /** ms since navigation start, null when not recorded. */
  t: number | null;
  kind: WalletRequestKind;
  method: RecordedWalletMethod;
  phase: Phase;
  outcome: WalletRequestEvidence['outcome'];
  frame: 'main' | 'iframe';
  chainId: number | null;
  verifyingContract: string | null;
  spender: string | null;
  token: string | null;
  amount: string | null;
  deadline: string | null;
  siweDomain: string | null;
  unlimited: boolean;
  longDeadline: boolean;
  chainIdMismatch: boolean;
  domainMismatch: boolean;
  preConnect: boolean;
  /** Finding ids (detector wallet-requests) about this request. */
  findingIds: string[];
}

/** Uniswap's Permit2 contract (same address on every chain). */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
