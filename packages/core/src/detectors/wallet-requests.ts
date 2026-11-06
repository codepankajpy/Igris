/**
 * wallet-requests (security): what the page asked the canary wallet to sign
 * or send, judged from the decoded requests (walletreq.ts). Security
 * findings only — they never reach recipients, verdicts or any score.
 *
 * One finding per request identity { method, kind, verifyingContract,
 * spender, token, flags } (identical requests share it and its evidence).
 * A request that matches several rows of the table gets ONE finding: the
 * most severe row gives the severity and title, every matched row adds its
 * explanation and remediation.
 *
 *   eth-sign                                          risk high
 *   blind-hash                                        risk medium
 *   permit / permit2 + unlimited                      risk high
 *   permit / permit2 + longDeadline (not unlimited)   risk medium
 *   approve unlimited / set-approval-for-all          risk high
 *   siwe + domainMismatch                             risk high
 *   any + chainIdMismatch                             risk medium
 *   permit / permit2 / approve / set-approval-for-all
 *     / typed-data + preConnect                       risk medium
 *   siwe (no risk row) / personal-message             observation info
 *
 * Nothing is reported for a page that did not load (coverage none).
 */
import type { Capture } from '../contracts/capture.js';
import type { Detector, DetectorContext, DraftFinding } from '../contracts/detector.js';
import type { Severity } from '../contracts/report-v2.js';
import { MAX_WALLET_REQUESTS } from '../contracts/report-v3.js';
import type { WalletRequestEvidence } from '../contracts/wallet-request.js';
import {
  decodeWalletRequests,
  type DecodedWalletRequest,
  type WalletDecodeBaseContext,
} from '../walletreq.js';

export const WALLET_REQUESTS_DETECTOR_ID = 'wallet-requests';
export const WALLET_REQUESTS_DETECTOR_VERSION = '1.0.0';

/** The decoder context of a scan: the page that loaded, its start chain and time. */
export function walletDecodeContext(
  capture: Capture,
  ctx: Pick<DetectorContext, 'canary' | 'target' | 'chainId' | 'scannedAt'>,
): WalletDecodeBaseContext {
  let pageOrigin = ctx.target.origin;
  try {
    if (capture.mainDocument) pageOrigin = new URL(capture.mainDocument.url).origin;
  } catch {
    /* keep the target's origin */
  }
  const ms = Date.parse(ctx.scannedAt);
  return {
    canary: ctx.canary,
    pageOrigin,
    chainId: ctx.chainId,
    scanTime: Number.isFinite(ms) ? Math.floor(ms / 1000) : 0,
  };
}

/**
 * The scan's wallet requests, decoded: the first MAX_WALLET_REQUESTS (the
 * scanner's own cap), none when the page did not load.
 */
export function decodeCaptureWalletRequests(
  capture: Capture,
  ctx: Pick<DetectorContext, 'canary' | 'target' | 'chainId' | 'scannedAt' | 'coverage'>,
): DecodedWalletRequest[] {
  if (ctx.coverage === 'none' || !capture.walletRequests?.length) return [];
  return decodeWalletRequests(
    capture.walletRequests.slice(0, MAX_WALLET_REQUESTS),
    walletDecodeContext(capture, ctx),
  );
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

interface Row {
  severity: Severity;
  title: string;
  impact: string;
  remediation: string;
}

/** 0x1234…abcd, or a fallback when the address is unknown. */
function short(a: string | null, fallback: string): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : fallback;
}

const FLAG_NAMES = [
  'unlimited',
  'longDeadline',
  'chainIdMismatch',
  'domainMismatch',
  'preConnect',
] as const;

/** The table rows a decoded request matches (table order). */
export function matchedRows(e: WalletRequestEvidence, walletChainId: number): Row[] {
  const rows: Row[] = [];
  const permitLike = e.kind === 'permit' || e.kind === 'permit2';
  if (e.kind === 'eth-sign') {
    rows.push({
      severity: 'high',
      title: 'Asked the wallet to eth_sign raw data (a blind signature)',
      impact:
        'eth_sign signs an arbitrary 32-byte hash that the wallet cannot explain; that hash can be a transaction or a token permit, so one signature can hand over funds.',
      remediation:
        'Never request eth_sign: use personal_sign for readable messages and eth_signTypedData_v4 for structured data.',
    });
  }
  if (e.kind === 'blind-hash') {
    rows.push({
      severity: 'medium',
      title: 'Asked to sign an unreadable hash with personal_sign',
      impact:
        'The message is a bare hash or unreadable bytes, so the wallet can only show gibberish and the user cannot tell what the signature will be used for.',
      remediation:
        'Ask users to sign readable text, or EIP-712 typed data, that states what the signature is for.',
    });
  }
  if (permitLike && e.unlimited) {
    rows.push({
      severity: 'high',
      title: `Asked for an unlimited token permit to ${short(e.spender, 'an unnamed spender')}`,
      impact:
        'One signature lets the spender move every unit of the token from the wallet, now or later, without another prompt — the usual way phishing pages drain wallets.',
      remediation:
        'Request a permit for the exact amount the action needs, with an expiration of minutes or hours.',
    });
  }
  if (permitLike && e.longDeadline && !e.unlimited) {
    rows.push({
      severity: 'medium',
      title: 'Token permit valid for more than 30 days',
      impact:
        'The signed permit stays usable for a long time, so a leaked or phished signature can still be used long after this visit.',
      remediation:
        'Use short expirations (Permit2 expiration / deadline, EIP-2612 deadline): minutes to hours.',
    });
  }
  if ((e.kind === 'approve' && e.unlimited) || e.kind === 'set-approval-for-all') {
    rows.push({
      severity: 'high',
      title:
        e.kind === 'approve'
          ? `Asked to approve unlimited spending of ${short(e.token, 'a token')} by ${short(e.spender, 'an unnamed spender')}`
          : `Asked to approve all NFTs of ${short(e.token, 'a collection')} for ${short(e.spender, 'an unnamed operator')}`,
      impact:
        e.kind === 'approve'
          ? 'The approval lets the spender transfer the wallet’s entire balance of the token at any time, until the user revokes it.'
          : 'The approval lets the operator transfer every NFT of the collection the wallet holds, now or later, until the user revokes it.',
      remediation:
        'Approve only the amount this action needs (or use Permit2 with a bounded amount and expiration); never ask for blanket approvals.',
    });
  }
  if (e.kind === 'siwe' && e.domainMismatch) {
    rows.push({
      severity: 'high',
      title: `Sign-in message is for a different site (${e.siweDomain ?? 'unknown'})`,
      impact:
        'The page asked the wallet to sign in to another site. That signature lets this page log in to the other site as the user (a sign-in relay used for phishing).',
      remediation:
        'The Sign-In with Ethereum domain and URI must be the site that asks (EIP-4361); wallets warn on or refuse a mismatch.',
    });
  }
  if (e.chainIdMismatch && e.chainId !== null) {
    const what =
      e.kind === 'approve' || e.kind === 'set-approval-for-all' || e.kind === 'transaction'
        ? 'Transaction'
        : 'Signature';
    rows.push({
      severity: 'medium',
      title: `${what} request names chain ${e.chainId} while the wallet is on chain ${walletChainId}`,
      impact:
        'A signature or transaction for a different chain than the one the wallet shows is valid where the user does not expect it, and is easy to misread.',
      remediation:
        'Ask the wallet to switch chains first (wallet_switchEthereumChain), then request a signature for the chain it is on.',
    });
  }
  if (
    e.preConnect &&
    (permitLike ||
      e.kind === 'approve' ||
      e.kind === 'set-approval-for-all' ||
      e.kind === 'typed-data')
  ) {
    rows.push({
      severity: 'medium',
      title:
        e.kind === 'approve' || e.kind === 'set-approval-for-all'
          ? 'Asked for an approval before connecting'
          : 'Asked for a signature before connecting',
      impact:
        'The page asked for a permit, approval or typed-data signature before the user had connected, so the request arrives without any action that explains it.',
      remediation:
        'Request signatures and approvals only after the user connected and started an action that needs them.',
    });
  }
  return rows;
}

/** The informational row of a request with no risk (clean SIWE, readable message). */
function infoRow(e: WalletRequestEvidence): Row | null {
  if (e.kind === 'siwe')
    return {
      severity: 'info',
      title: `Asked to sign in with Ethereum${e.siweDomain ? ` (${e.siweDomain})` : ''}`,
      impact: 'A sign-in message for this site; it does not move funds. Recorded for reference.',
      remediation: 'None needed.',
    };
  if (e.kind === 'personal-message')
    return {
      severity: 'info',
      title: 'Asked to sign a message',
      impact: 'A readable message signature; it does not move funds. Recorded for reference.',
      remediation: 'None needed.',
    };
  return null;
}

/** Drafts for decoded requests (pure; shared by the detector and its tests). */
export function walletRequestDrafts(decoded: readonly DecodedWalletRequest[]): DraftFinding[] {
  const groups = new Map<
    string,
    {
      identity: DraftFinding['fingerprintInput'];
      rows: Row[];
      info: boolean;
      items: WalletRequestEvidence[];
    }
  >();
  for (const { evidence: e, walletChainId } of decoded) {
    const risk = matchedRows(e, walletChainId);
    const info = risk.length === 0 ? infoRow(e) : null;
    if (risk.length === 0 && !info) continue;
    const identity = {
      method: e.method,
      kind: e.kind,
      verifyingContract: e.verifyingContract ?? '',
      spender: e.spender ?? '',
      token: e.token ?? '',
      flags: FLAG_NAMES.filter((f) => e[f]).join(','),
    };
    const key = JSON.stringify(identity);
    const g = groups.get(key);
    if (g) g.items.push(e);
    else
      groups.set(key, {
        identity,
        rows: risk.length ? risk : [info!],
        info: !risk.length,
        items: [e],
      });
  }
  const drafts: DraftFinding[] = [];
  for (const { identity, rows, info, items } of groups.values()) {
    const top = [...rows].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0]!;
    drafts.push({
      fingerprintInput: identity,
      kind: info ? 'observation' : 'risk',
      severity: top.severity,
      confidence: 'confirmed',
      title: top.title.slice(0, 200),
      impact: rows
        .map((r) => r.impact)
        .join(' ')
        .slice(0, 2000),
      remediation: [...new Set(rows.map((r) => r.remediation))].join(' ').slice(0, 2000),
      evidence: items,
      countsTowardPrivacyScore: false,
    });
  }
  return drafts;
}

export const walletRequestsDetector: Detector = {
  id: WALLET_REQUESTS_DETECTOR_ID,
  version: WALLET_REQUESTS_DETECTOR_VERSION,
  domain: 'security',
  run: (capture, ctx) => walletRequestDrafts(decodeCaptureWalletRequests(capture, ctx)),
};
