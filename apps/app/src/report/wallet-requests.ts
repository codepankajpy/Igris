/**
 * Display wording for report.walletRequests (Report 3.0.0;
 * packages/core/src/contracts/wallet-request.ts). Pure functions that NAME
 * what the backend decoded and flagged — every flag is one of the backend's
 * booleans and every risk is one of its findings. Nothing here judges a
 * request. Unit-tested in test/wallet-requests.test.ts.
 */
import type { FindingV3, WalletRequestKind, WalletRequestSummary } from '@igris/core/contracts';
import { PERMIT2_ADDRESS } from '@igris/core/contracts';

/** Shown when the page asked for no signature and no transaction. */
export const EMPTY_TEXT = 'The site did not ask the wallet to sign anything during the visit.';

/** The request kind in plain words. */
export const KIND_LABEL: Record<WalletRequestKind, string> = {
  connect: 'Connect the wallet',
  'switch-chain': 'Switch the wallet to another chain',
  'add-chain': 'Add a chain to the wallet',
  'watch-asset': 'Add a token to the wallet’s list',
  siwe: 'Sign in with Ethereum',
  'personal-message': 'Sign a readable message',
  'blind-hash': 'Sign an unreadable hash',
  'eth-sign': 'Blind-sign raw data (eth_sign)',
  permit: 'Sign a token permit (EIP-2612)',
  permit2: 'Sign a token permit (Permit2)',
  'typed-data': 'Sign structured data (EIP-712)',
  approve: 'Approve token spending (transaction)',
  'set-approval-for-all': 'Approve every NFT of a collection (transaction)',
  transaction: 'Send a transaction',
};

/** What a request of this kind would allow if a real wallet granted it. */
export const KIND_ALLOWS: Record<WalletRequestKind, string> = {
  connect: 'Lets the site read the wallet address.',
  'switch-chain': 'Changes which chain the wallet uses.',
  'add-chain': 'Adds a network to the wallet’s list of chains.',
  'watch-asset': 'Shows a token in the wallet. It moves nothing.',
  siwe: 'Proves the visitor controls the address and signs them in to the site named in the message.',
  'personal-message': 'Proves the visitor controls the address by signing the text shown.',
  'blind-hash':
    'Signs bytes nobody can read, so what the signature authorises cannot be checked before signing.',
  'eth-sign':
    'Signs a raw hash, which can authorise anything a signature can — including a transaction.',
  permit:
    'Lets the spender move the token out of the wallet, up to the amount, until the deadline — without another prompt.',
  permit2:
    'Lets the spender move the token through Permit2, up to the amount, until the deadline — without another prompt.',
  'typed-data':
    'Signs structured data; what it allows depends on the contract that later verifies it.',
  approve: 'Lets the spender move the token out of the wallet, up to the amount.',
  'set-approval-for-all': 'Lets the operator move every NFT the wallet holds in the collection.',
  transaction: 'Sends a transaction from the wallet.',
};

/** Kinds that ask for a signature or a transaction (everything but wallet housekeeping). */
const SIGNING: ReadonlySet<WalletRequestKind> = new Set<WalletRequestKind>([
  'siwe',
  'personal-message',
  'blind-hash',
  'eth-sign',
  'permit',
  'permit2',
  'typed-data',
  'approve',
  'set-approval-for-all',
  'transaction',
]);
export const asksToSign = (kind: WalletRequestKind): boolean => SIGNING.has(kind);

export const OUTCOME_LABEL: Record<WalletRequestSummary['outcome'], string> = {
  answered: 'Answered',
  signed: 'Signed by the throwaway wallet',
  rejected: 'Rejected by the throwaway wallet',
  error: 'Failed with an error',
};

export const PHASE_TEXT: Record<string, string> = {
  'pre-connect': 'Before connecting',
  'post-connect': 'After connecting',
};

/** Well-known chain ids, for naming only (an unknown id is shown as a number). */
const CHAINS: Record<number, string> = {
  1: 'Ethereum',
  10: 'OP Mainnet',
  56: 'BNB Smart Chain',
  100: 'Gnosis',
  137: 'Polygon',
  324: 'zkSync Era',
  8453: 'Base',
  42161: 'Arbitrum One',
  43114: 'Avalanche C-Chain',
  59144: 'Linea',
  534352: 'Scroll',
  11155111: 'Sepolia',
};

export function chainName(id: number | null): string {
  if (id === null) return 'none named';
  const name = CHAINS[id];
  return name ? `${name} (${id})` : `chain ${id}`;
}

/** The amount as decoded; "unlimited" whenever the backend flagged it so. */
export function amountText(s: Pick<WalletRequestSummary, 'amount' | 'unlimited'>): string {
  if (s.unlimited) return 'unlimited';
  if (s.amount === null) return '—';
  return `${s.amount} (in the token’s smallest units)`;
}

/** Unix seconds (decimal string) → a date; values past any calendar date say so. */
export function deadlineText(
  deadline: string | null,
  format: (unixSeconds: number) => string,
): string {
  if (deadline === null) return '—';
  const n = Number(deadline);
  // Date supports ±8.64e15 ms; anything later has no calendar date.
  if (!/^[0-9]{1,78}$/.test(deadline) || !Number.isFinite(n) || n > 8.64e12)
    return `${deadline} (beyond any calendar date)`;
  return format(n);
}

/** Name the verifying contract when it is Permit2 (same address on every chain). */
export function contractText(address: string | null): string | null {
  if (address === null) return null;
  return address.toLowerCase() === PERMIT2_ADDRESS.toLowerCase() ? `${address} (Permit2)` : address;
}

/** "Spender" or, for setApprovalForAll, "Operator". */
export const recipientRole = (kind: WalletRequestKind): string =>
  kind === 'set-approval-for-all' ? 'Operator' : 'Spender';

export interface Flag {
  key: 'unlimited' | 'longDeadline' | 'chainIdMismatch' | 'domainMismatch' | 'preConnect';
  text: string;
}

/** The backend's flags on one request, in words (only the ones it set). */
export function flags(
  s: Pick<
    WalletRequestSummary,
    | 'unlimited'
    | 'longDeadline'
    | 'chainIdMismatch'
    | 'domainMismatch'
    | 'preConnect'
    | 'chainId'
    | 'siweDomain'
  >,
): Flag[] {
  const out: Flag[] = [];
  if (s.unlimited) out.push({ key: 'unlimited', text: 'Unlimited amount' });
  if (s.longDeadline) out.push({ key: 'longDeadline', text: 'Valid for more than 30 days' });
  if (s.chainIdMismatch)
    out.push({
      key: 'chainIdMismatch',
      text: `Names ${chainName(s.chainId)}, not the chain the wallet was on`,
    });
  if (s.domainMismatch)
    out.push({
      key: 'domainMismatch',
      text: s.siweDomain
        ? `Sign-in message is for ${s.siweDomain}, not the page that asked`
        : 'Sign-in message does not match the page that asked',
    });
  if (s.preConnect)
    out.push({ key: 'preConnect', text: 'Asked before the site requested the wallet address' });
  return out;
}

/** The request's findings (detector wallet-requests), in the order the summary lists them. */
export function findingsOf(
  s: Pick<WalletRequestSummary, 'findingIds'>,
  byId: ReadonlyMap<string, FindingV3>,
): FindingV3[] {
  return s.findingIds.map((id) => byId.get(id)).filter((f): f is FindingV3 => f !== undefined);
}

/** True when the backend raised at least one risk finding (not an observation) about it. */
export function hasRisk(
  s: Pick<WalletRequestSummary, 'findingIds'>,
  byId: ReadonlyMap<string, FindingV3>,
): boolean {
  return findingsOf(s, byId).some((f) => f.kind === 'risk');
}

/**
 * "Sign-in domain vs page": the SIWE domain and whether the backend found it
 * differs. The backend accepts the page's own hostname or a parent/subdomain
 * of it (WALLET-REQUESTS.md), so a match is worded that way.
 */
export function signInText(
  s: Pick<WalletRequestSummary, 'siweDomain' | 'domainMismatch'>,
  hostname: string,
): string | null {
  if (s.siweDomain === null) return null;
  return s.domainMismatch
    ? `${s.siweDomain} — not the page that asked (${hostname})`
    : `${s.siweDomain} — matches the page (or its parent/subdomain): ${hostname}`;
}

/**
 * Kinds whose chain id binds what is signed or sent; only for these does the
 * backend compare the named chain with the wallet's chain (walletreq.ts
 * CHAIN_BOUND). switch-chain / add-chain name a target, not a binding.
 */
const CHAIN_BOUND: ReadonlySet<WalletRequestKind> = new Set<WalletRequestKind>([
  'siwe',
  'permit',
  'permit2',
  'typed-data',
  'approve',
  'set-approval-for-all',
  'transaction',
]);

/** The detector's chain-mismatch title ("… request names chain N while the wallet is on chain M"). */
const CHAIN_MISMATCH_TITLE = /\brequest names chain \d+ while the wallet is on chain \d+$/;

/**
 * The backend's own sentence for this request's chain mismatch: the title of
 * its chain-mismatch risk finding, when that is the finding's title (a
 * request matching several rows is titled by its most severe row). It names
 * the wallet's chain at that moment, which may differ from the start chain
 * after a wallet_switchEthereumChain.
 */
export function chainMismatchTitle(findings: readonly FindingV3[]): string | null {
  return (
    findings.find((f) => f.kind === 'risk' && CHAIN_MISMATCH_TITLE.test(f.title))?.title ?? null
  );
}

/**
 * "Chain named": for switch-chain / add-chain, the target only; for
 * chain-bound kinds, compared with the wallet's chain as the backend flagged
 * it (in its finding's words when it has one). `startChain` is the chain the
 * scan's wallet started on — named only when it is not the chain named.
 */
export function chainText(
  s: Pick<WalletRequestSummary, 'kind' | 'chainId' | 'chainIdMismatch'>,
  startChain: number,
  findings: readonly FindingV3[] = [],
): string | null {
  if (s.chainId === null) return null;
  const named = chainName(s.chainId);
  if (s.kind === 'switch-chain') return `${named} — the chain it asks the wallet to switch to`;
  if (s.kind === 'add-chain') return `${named} — the chain it asks the wallet to add`;
  if (!CHAIN_BOUND.has(s.kind)) return named;
  if (!s.chainIdMismatch) return `${named} — the wallet’s chain`;
  const title = chainMismatchTitle(findings);
  if (title !== null) return `${named} — ${title}`;
  return startChain === s.chainId
    ? `${named} — not the chain the wallet was on`
    : `${named} — not the chain the wallet was on (it started on ${chainName(startChain)})`;
}

/**
 * The request's findings in words, for screen readers: "risk finding: <title>"
 * for each risk, "observation: <title>" for each observation; null when none.
 */
export function findingsText(findings: readonly FindingV3[]): string | null {
  if (findings.length === 0) return null;
  return findings
    .map((f) => `${f.kind === 'risk' ? 'risk finding' : 'observation'}: ${f.title}`)
    .join('; ');
}

/**
 * One-line description used by the timeline marker. A marker with a risk
 * finding says so — "risk finding: <title>" — so the emphasis the eye sees
 * is in the label too.
 */
export function markerLabel(
  s: Pick<WalletRequestSummary, 'kind' | 'method' | 'outcome' | 'phase' | 't'>,
  index: number,
  secs: (ms: number) => string,
  findings: readonly FindingV3[] = [],
): string {
  const when = s.t === null ? 'not timed' : `at ${secs(s.t)}`;
  const risks = findings
    .filter((f) => f.kind === 'risk')
    .map((f) => `; risk finding: ${f.title}`)
    .join('');
  return `Wallet request ${index + 1}: ${KIND_LABEL[s.kind]} (${s.method}) ${when}, ${(
    PHASE_TEXT[s.phase] ?? s.phase
  ).toLowerCase()}. ${OUTCOME_LABEL[s.outcome]}${risks}.`;
}

/**
 * Lanes for markers that would overlap: each marker (at fraction x of the
 * track, in any order) goes on the first lane where every marker already
 * placed is at least `gap` away.
 */
export function markerLanes(xs: readonly number[], gap = 0.025): number[] {
  const lanes: number[][] = [];
  return xs.map((x) => {
    let lane = lanes.findIndex((l) => l.every((e) => Math.abs(x - e) >= gap));
    if (lane === -1) lane = lanes.push([]) - 1;
    lanes[lane]!.push(x);
    return lane;
  });
}
