/**
 * Wallet-request decoder (docs/design/WALLET-REQUESTS.md): turns what a page
 * asked the canary wallet to do (CapturedWalletRequest, raw and unredacted)
 * into canary-free `wallet-request` evidence items, and those into the
 * report's `walletRequests` summaries.
 *
 * Pure, offline and deterministic: the same capture and context always give
 * the same items. Nothing here judges severity — the `wallet-requests`
 * detector does that from the decoded flags.
 *
 * Canary handling: the raw params are never stored. Address fields equal to
 * the canary are dropped (null) — owner / holder fields are never read at
 * all; free-text fields (calling origin, SIWE domain) have every detectable
 * canary form replaced by `<CANARY>`; `paramsDigest` hashes the params with
 * every canary form replaced by `<CANARY>`.
 */
import { decodeAbiParameters, getAddress, isAddress } from 'viem';
import { registrableDomain } from './classify.js';
import { findCanary } from './detect.js';
import type { CanaryForms } from './encodings.js';
import { contentHash } from './contracts/hash.js';
import {
  MAX_SIWE_DOMAIN,
  MAX_WALLET_ORIGIN,
  evidenceId,
  type EvidenceRef,
} from './contracts/evidence.js';
import {
  PERMIT2_ADDRESS,
  type CapturedWalletRequest,
  type RecordedWalletMethod,
  type WalletRequestEvidence,
  type WalletRequestKind,
  type WalletRequestSummary,
} from './contracts/wallet-request.js';

/** 2^160 − 1: Permit2's max allowance (uint160). */
export const MAX_UINT160 = (1n << 160n) - 1n;
/** 2^256 − 1. */
export const MAX_UINT256 = (1n << 256n) - 1n;
/**
 * An amount at or above this is "unlimited": 2^160 − 1 (Permit2's max), which
 * also covers 2^255 and MAX_UINT256.
 */
export const UNLIMITED_AMOUNT = MAX_UINT160;
/** A permit / approval deadline further out than this (after the scan) is "long". */
export const LONG_DEADLINE_SECONDS = 30 * 24 * 60 * 60;
/** ERC-20 approve(address spender, uint256 amount). */
export const APPROVE_SELECTOR = '0x095ea7b3';
/** ERC-721 / ERC-1155 setApprovalForAll(address operator, bool approved). */
export const SET_APPROVAL_FOR_ALL_SELECTOR = '0xa22cb465';
/** EIP-712 primary types that make typed data a Permit2 request. */
export const PERMIT2_PRIMARY_TYPES = [
  'PermitSingle',
  'PermitBatch',
  'PermitTransferFrom',
  'PermitBatchTransferFrom',
  'PermitWitnessTransferFrom',
  'PermitBatchWitnessTransferFrom',
] as const;

const TX_METHODS: ReadonlySet<RecordedWalletMethod> = new Set([
  'eth_sendTransaction',
  'eth_signTransaction',
]);

/** What the decoder needs to know about the moment a request was made. */
export interface WalletDecodeContext {
  canary: CanaryForms;
  /**
   * Origin of the scanned page; the SIWE check uses it when the calling
   * frame's origin is opaque (about:blank, sandboxed frames).
   */
  pageOrigin: string;
  /** Chain the wallet was on when the request was made. */
  chainId: number;
  /** Scan time, unix seconds (the long-deadline reference). */
  scanTime: number;
  /** Whether the dApp had called eth_requestAccounts before this request. */
  accountsRequested: boolean;
}

/** The context for a whole capture: the wallet's chain at the start of the scan. */
export type WalletDecodeBaseContext = Omit<WalletDecodeContext, 'accountsRequested'>;

/** One decoded request with the wallet state it was judged against. */
export interface DecodedWalletRequest {
  captured: CapturedWalletRequest;
  evidence: WalletRequestEvidence;
  /** The chain the wallet was on when the request was made. */
  walletChainId: number;
}

// ---------------------------------------------------------------------------
// Small, total parsers (never throw; null = "could not tell").
// ---------------------------------------------------------------------------

/** Replace lone surrogates (they cannot be canonicalized). */
function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

/** `s` with every detectable canary form replaced by `<CANARY>`. */
export function redactCanary(s: string, canary: CanaryForms): string {
  const text = wellFormed(s);
  const hits = findCanary(text, canary);
  let out = text;
  for (const m of [...hits].sort((a, b) => b.index - a.index))
    out = out.slice(0, m.index) + '<CANARY>' + out.slice(m.index + m.length);
  return out;
}

/**
 * The canary's textual forms as hex-encoded UTF-8 (how personal_sign carries
 * a message such as SIWE: "0x" + hex of its bytes), lowercase hex.
 */
function hexTextForms(canary: CanaryForms): string[] {
  const upper = canary.coreLower.toUpperCase();
  const texts = [
    canary.checksummed,
    canary.lowercase,
    '0x' + upper,
    canary.checksummed.slice(2),
    canary.coreLower,
    upper,
  ];
  const hex = (t: string) =>
    [...new TextEncoder().encode(t)].map((b) => b.toString(16).padStart(2, '0')).join('');
  // Longest first, so a 0x-prefixed form wins over its bare core.
  return [...new Set(texts.map(hex))].sort((a, b) => b.length - a.length);
}

/** Also redact the canary inside hex-encoded text (personal_sign messages). */
function redactParamString(s: string, canary: CanaryForms): string {
  let out = redactCanary(s, canary);
  if (!/^0x[0-9a-fA-F]*$/.test(s)) return out;
  out = s.toLowerCase();
  for (const form of hexTextForms(canary)) out = out.split(form).join('<CANARY>');
  return redactCanary(out, canary);
}

function redactDeep(v: unknown, canary: CanaryForms): unknown {
  if (typeof v === 'string') return redactParamString(v, canary);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, canary));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [redactCanary(k, canary), redactDeep(x, canary)]),
    );
  return v;
}

/**
 * sha256 of the canonical params with every canary form replaced by
 * `<CANARY>` (also inside hex-encoded message text), so the same request
 * made to two scans' canaries has the same digest.
 */
export function walletParamsDigest(params: string, canary: CanaryForms): string {
  try {
    return contentHash(redactDeep(JSON.parse(params), canary));
  } catch {
    // Truncated (scanner cap) or otherwise unparseable: hash the redacted text.
    return contentHash(redactCanary(params, canary));
  }
}

/** A checksummed address, or null (invalid, or the canary itself). */
function address(v: unknown, canary: CanaryForms): string | null {
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) return null;
  const a = getAddress(v);
  return a.toLowerCase() === canary.lowercase ? null : a;
}

interface Uint {
  /** Exact decimal value, null when it cannot be stated exactly (an unsafe JS number). */
  decimal: string | null;
  /** The value for comparisons (exact for strings; the double's own value for numbers). */
  value: bigint;
}

/** A uint256 given as a decimal string, a 0x hex string or a JSON number. */
export function parseUint(v: unknown): Uint | null {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) return null;
    const value = BigInt(v);
    // Beyond 2^53 a JSON number is already rounded by the page: state no
    // exact amount, but judge its magnitude.
    return { decimal: Number.isSafeInteger(v) ? value.toString() : null, value };
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^[0-9]{1,78}$/.test(s) && !/^0x[0-9a-fA-F]{1,64}$/.test(s)) return null;
  const value = BigInt(s);
  return value > MAX_UINT256 ? null : { decimal: value.toString(), value };
}

/** A chain id (number, decimal or 0x hex string) that fits a safe integer, else null. */
export function parseChainId(v: unknown): number | null {
  const u = parseUint(v);
  if (!u || u.decimal === null || u.value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(u.value);
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The params array (a bare object is treated as a one-element array), or null. */
function parseParams(raw: string): unknown[] | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (Array.isArray(v)) return v;
  return obj(v) ? [v] : null;
}

function hostOf(origin: string): { host: string; origin: string } | null {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return { host: u.hostname.replace(/^\[|\]$/g, '').toLowerCase(), origin: u.origin };
  } catch {
    return null;
  }
}

/**
 * Same host, or one is a subdomain of the other within the same registrable
 * domain (www.x.org ~ x.org ~ app.x.org; never a public suffix such as co.uk;
 * siblings such as a.x.org / b.x.org do not match).
 */
export function relatedHost(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/\.$/, '');
  const y = b.toLowerCase().replace(/\.$/, '');
  if (x === y) return true;
  if (!x || !y || registrableDomain(x) !== registrableDomain(y)) return false;
  return x.endsWith('.' + y) || y.endsWith('.' + x);
}

// ---------------------------------------------------------------------------
// personal_sign and SIWE (EIP-4361)
// ---------------------------------------------------------------------------

const NON_PRINTABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F�]/;

/**
 * The readable text of a personal_sign message, or null when it is unreadable
 * (a hash, bytes). Hex is decoded as UTF-8 whatever its length: a 32-byte
 * payload is a blind hash only when it does NOT decode to printable text
 * (hex("Please sign this message today!!") is a readable 32-byte message).
 */
export function personalMessageText(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  let text = message;
  if (/^0x(?:[0-9a-fA-F]{2})*$/.test(message)) {
    const bytes = new Uint8Array((message.length - 2) / 2);
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = parseInt(message.slice(2 + 2 * i, 4 + 2 * i), 16);
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  } else if (/^[0-9a-fA-F]{64}$/.test(message)) {
    return null; // a 32-byte hash written without 0x: readable characters, no meaning
  }
  return NON_PRINTABLE.test(text) ? null : text;
}

/** The message of personal_sign params: [message, address], either order tolerated. */
export function personalSignMessage(params: unknown[], canary: CanaryForms): unknown {
  const [p0, p1] = params;
  const isCanary = (v: unknown) => typeof v === 'string' && v.toLowerCase() === canary.lowercase;
  const isAddr = (v: unknown) => typeof v === 'string' && isAddress(v, { strict: false });
  if (isCanary(p0) && !isCanary(p1)) return p1;
  if (isCanary(p1)) return p0;
  if (isAddr(p0) && p1 !== undefined && !isAddr(p1)) return p1;
  return p0;
}

const SIWE_HEADER =
  /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?([^\s/?#]+) wants you to sign in with your Ethereum account:$/;

export interface SiweFields {
  /** The `domain` (RFC 3986 authority: host and optional port). */
  domain: string;
  uri: string | null;
  chainId: number | null;
}

/** EIP-4361 fields of a message, or null when it is not a SIWE message. */
export function parseSiwe(text: string): SiweFields | null {
  const lines = text.split(/\r?\n/);
  const head = SIWE_HEADER.exec(lines[0] ?? '');
  if (!head || head[1]!.length > MAX_SIWE_DOMAIN) return null;
  const field = (name: string): string | null => {
    const line = lines.find((l) => l.startsWith(`${name}: `));
    return line === undefined ? null : line.slice(name.length + 2).trim();
  };
  const chain = field('Chain ID');
  return {
    domain: head[1]!,
    uri: field('URI'),
    chainId: chain !== null && /^[0-9]{1,15}$/.test(chain) ? parseChainId(chain) : null,
  };
}

/** Host of a SIWE domain (authority): strips the port, IPv6 brackets and userinfo. */
function authorityHost(authority: string): string {
  const a = authority.replace(/^.*@/, '');
  const v6 = /^\[([^\]]+)\]/.exec(a);
  if (v6) return v6[1]!.toLowerCase();
  return a.replace(/:\d*$/, '').toLowerCase();
}

/**
 * A SIWE message does not belong to the page that asked: its domain is not
 * that page's host (nor a sub/parent domain of it), or its URI is an
 * http(s) URL on an unrelated host. The same host relation applies to both,
 * so www.x.org asking for x.org with URI https://x.org is not a mismatch.
 */
export function siweDomainMismatch(siwe: SiweFields, requestOrigin: string): boolean {
  const page = hostOf(requestOrigin);
  if (!page) return false; // nothing to compare against: no claim
  if (!relatedHost(authorityHost(siwe.domain), page.host)) return true;
  if (siwe.uri !== null) {
    const uri = hostOf(siwe.uri);
    if (uri && !relatedHost(uri.host, page.host)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Typed data (EIP-712): Permit2, EIP-2612 (and DAI-style) permits
// ---------------------------------------------------------------------------

/** The typed-data param of eth_signTypedData* ([address, json] or [json, address]). */
export function typedDataParam(params: unknown[]): unknown {
  for (const p of params) {
    if (obj(p) || Array.isArray(p)) return p;
    if (typeof p === 'string') {
      const t = p.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          return JSON.parse(t);
        } catch {
          /* not JSON: keep looking */
        }
      }
    }
  }
  return null;
}

interface Grant {
  token: string | null;
  spender: string | null;
  amount: Uint | null;
  deadline: Uint | null;
  unlimited: boolean;
  /** No expiry at all (DAI-style permit with expiry 0). */
  neverExpires?: boolean;
  /**
   * Every deadline the grant carries, for `longDeadline` (PermitBatch: one
   * expiration per entry); absent = just `deadline`.
   */
  deadlines?: Array<Uint | null>;
}

/**
 * Permit2 grant. Batches (PermitBatch `details[]`, PermitBatch*TransferFrom
 * `permitted[]`) report token / amount / deadline of the FIRST entry; the
 * flags look at every entry: `unlimited` if ANY amount is, and (PermitBatch)
 * `longDeadline` if ANY entry's expiration is long.
 */
function permit2Grant(message: Record<string, unknown>, canary: CanaryForms): Grant {
  const details = message.details;
  const permitted = message.permitted;
  const allowance = details !== undefined;
  const raw = allowance ? details : permitted;
  const entries = (Array.isArray(raw) ? raw : [raw]).map(obj).filter((e) => e !== null);
  const first = entries[0] ?? null;
  const amounts = entries.map((e) => parseUint(e.amount));
  const expirations = entries.map((e) => parseUint(e.expiration));
  return {
    token: first ? address(first.token, canary) : null,
    spender: address(message.spender, canary),
    amount: amounts[0] ?? null,
    // AllowanceTransfer (PermitSingle / PermitBatch): how long the allowance
    // lasts is `expiration`; SignatureTransfer: the signature's `deadline`.
    deadline: allowance ? (expirations[0] ?? null) : parseUint(message.deadline),
    unlimited: amounts.some((a) => a !== null && a.value >= UNLIMITED_AMOUNT),
    ...(allowance ? { deadlines: expirations } : {}),
  };
}

function eip2612Grant(
  message: Record<string, unknown>,
  token: string | null,
  canary: CanaryForms,
): Grant | null {
  const has = (...keys: string[]) => keys.every((k) => k in message);
  if (has('owner', 'spender', 'value', 'nonce', 'deadline')) {
    const amount = parseUint(message.value);
    return {
      token,
      spender: address(message.spender, canary),
      amount,
      deadline: parseUint(message.deadline),
      unlimited: amount !== null && amount.value >= UNLIMITED_AMOUNT,
    };
  }
  // DAI-style permit: `allowed: true` is an unlimited approval; expiry 0 never expires.
  if (has('holder', 'spender', 'nonce', 'expiry', 'allowed')) {
    const expiry = parseUint(message.expiry);
    return {
      token,
      spender: address(message.spender, canary),
      amount: null,
      deadline: expiry,
      unlimited: message.allowed === true,
      neverExpires: expiry !== null && expiry.value === 0n,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The decoder
// ---------------------------------------------------------------------------

/** The kind a method gives on its own, before its params are read. */
function kindByMethod(method: RecordedWalletMethod): WalletRequestKind {
  switch (method) {
    case 'eth_requestAccounts':
    case 'wallet_requestPermissions':
      return 'connect';
    case 'wallet_switchEthereumChain':
      return 'switch-chain';
    case 'wallet_addEthereumChain':
      return 'add-chain';
    case 'wallet_watchAsset':
      return 'watch-asset';
    case 'personal_sign':
      return 'blind-hash'; // until a readable message is decoded
    case 'eth_sign':
      return 'eth-sign';
    case 'eth_signTypedData':
    case 'eth_signTypedData_v3':
    case 'eth_signTypedData_v4':
      return 'typed-data';
    default:
      return 'transaction';
  }
}

/** Kinds whose chain id names the chain a signature / transaction is for. */
const CHAIN_BOUND: ReadonlySet<WalletRequestKind> = new Set([
  'siwe',
  'permit',
  'permit2',
  'typed-data',
  'approve',
  'set-approval-for-all',
  'transaction',
]);

/** Decode one captured request (the wallet state at that moment is in `ctx`). */
export function decodeWalletRequest(
  c: CapturedWalletRequest,
  ctx: WalletDecodeContext,
): WalletRequestEvidence {
  const canary = ctx.canary;
  const params = parseParams(c.params) ?? [];
  const first = obj(params[0]);
  let kind = kindByMethod(c.method);
  let chainId: number | null = null;
  let verifyingContract: string | null = null;
  let grant: Grant | null = null;
  let siweDomain: string | null = null;
  let domainMismatch = false;

  switch (kind) {
    case 'switch-chain':
    case 'add-chain':
      chainId = first ? parseChainId(first.chainId) : null;
      break;
    case 'watch-asset': {
      const options = first ? obj(first.options) : null;
      grant = {
        token: options ? address(options.address, canary) : null,
        spender: null,
        amount: null,
        deadline: null,
        unlimited: false,
      };
      break;
    }
    case 'blind-hash': {
      const text = personalMessageText(personalSignMessage(params, canary));
      if (text === null) break;
      const siwe = parseSiwe(text);
      if (!siwe) {
        kind = 'personal-message';
        break;
      }
      kind = 'siwe';
      siweDomain = redactCanary(siwe.domain, canary);
      chainId = siwe.chainId;
      domainMismatch = siweDomainMismatch(siwe, hostOf(c.origin) ? c.origin : ctx.pageOrigin);
      break;
    }
    case 'typed-data': {
      const td = obj(typedDataParam(params));
      if (!td) break; // legacy v1 typed data (an array) or unreadable
      const domain = obj(td.domain);
      const message = obj(td.message) ?? {};
      chainId = domain ? parseChainId(domain.chainId) : null;
      verifyingContract = domain ? address(domain.verifyingContract, canary) : null;
      const primaryType = typeof td.primaryType === 'string' ? td.primaryType : '';
      if (
        verifyingContract?.toLowerCase() === PERMIT2_ADDRESS.toLowerCase() ||
        (PERMIT2_PRIMARY_TYPES as readonly string[]).includes(primaryType)
      ) {
        kind = 'permit2';
        grant = permit2Grant(message, canary);
      } else if (primaryType === 'Permit') {
        const g = eip2612Grant(message, verifyingContract, canary);
        if (g) {
          kind = 'permit';
          grant = g;
        }
      }
      break;
    }
    case 'transaction': {
      if (!TX_METHODS.has(c.method) || !first) break;
      chainId = parseChainId(first.chainId);
      const data = typeof first.data === 'string' ? first.data : first.input;
      if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) break;
      const selector = data.slice(0, 10).toLowerCase();
      const body = `0x${data.slice(10)}` as `0x${string}`;
      const token = address(first.to, canary);
      try {
        if (selector === APPROVE_SELECTOR) {
          const [spender, amount] = decodeAbiParameters(
            [{ type: 'address' }, { type: 'uint256' }],
            body,
          );
          const value = parseUint(`0x${amount.toString(16)}`);
          kind = 'approve';
          grant = {
            token,
            spender: address(spender, canary),
            amount: value,
            deadline: null,
            unlimited: value !== null && value.value >= UNLIMITED_AMOUNT,
          };
        } else if (selector === SET_APPROVAL_FOR_ALL_SELECTOR) {
          const [operator, approved] = decodeAbiParameters(
            [{ type: 'address' }, { type: 'bool' }],
            body,
          );
          if (approved) {
            kind = 'set-approval-for-all';
            grant = {
              token,
              spender: address(operator, canary),
              amount: null,
              deadline: null,
              unlimited: true,
            };
          } // approved = false is a revocation: an ordinary transaction
        }
      } catch {
        /* malformed calldata: an ordinary transaction */
      }
      break;
    }
    default:
      break;
  }

  const deadline = grant?.deadline ?? null;
  const longAfter = BigInt(ctx.scanTime + LONG_DEADLINE_SECONDS);
  const longDeadline =
    (kind === 'permit' || kind === 'permit2') &&
    (grant?.neverExpires === true ||
      (grant?.deadlines ?? [deadline]).some((d) => d !== null && d.value > longAfter));
  const origin = redactCanary(c.origin, canary).slice(0, MAX_WALLET_ORIGIN) || 'null';
  return {
    type: 'wallet-request',
    phase: c.phase,
    method: c.method,
    kind,
    frame: c.frame,
    origin,
    outcome: c.outcome,
    chainId,
    verifyingContract,
    spender: grant?.spender ?? null,
    token: grant?.token ?? null,
    amount: grant?.amount?.decimal ?? null,
    deadline: deadline?.decimal ?? null,
    siweDomain,
    unlimited: grant?.unlimited ?? false,
    longDeadline,
    chainIdMismatch: CHAIN_BOUND.has(kind) && chainId !== null && chainId !== ctx.chainId,
    domainMismatch,
    preConnect: kind !== 'connect' && !ctx.accountsRequested,
    paramsDigest: walletParamsDigest(c.params, canary),
  };
}

/** The chain a wallet_switchEthereumChain asks for, as the canary wallet reads it (a string). */
function switchTarget(c: CapturedWalletRequest): number | null {
  const first = obj(parseParams(c.params)?.[0]);
  return first && typeof first.chainId === 'string' ? parseChainId(first.chainId) : null;
}

/**
 * Decode a capture's requests in order. The wallet state each request is
 * judged against is threaded through, per calling frame (frame kind +
 * origin: every frame gets its own canary provider): its chain (changed by
 * an answered wallet_switchEthereumChain) and whether it had requested
 * accounts (the first eth_requestAccounts).
 */
export function decodeWalletRequests(
  captured: readonly CapturedWalletRequest[],
  base: WalletDecodeBaseContext,
): DecodedWalletRequest[] {
  const state = new Map<string, { chainId: number; accounts: boolean }>();
  return captured.map((c) => {
    const key = `${c.frame}|${c.origin}`;
    const s = state.get(key) ?? { chainId: base.chainId, accounts: false };
    state.set(key, s);
    const walletChainId = s.chainId;
    const evidence = decodeWalletRequest(c, {
      ...base,
      chainId: walletChainId,
      accountsRequested: s.accounts,
    });
    if (c.method === 'eth_requestAccounts') s.accounts = true;
    if (c.method === 'wallet_switchEthereumChain' && c.outcome === 'answered') {
      const target = switchTarget(c);
      if (target !== null) s.chainId = target;
    }
    return { captured: c, evidence, walletChainId };
  });
}

/**
 * The report's `walletRequests`: one summary per request, in request order,
 * each pointing at its (content-addressed, possibly shared) evidence item
 * and listing the findings that reference that item (sorted).
 */
export function buildWalletRequestSummaries(
  decoded: readonly DecodedWalletRequest[],
  findings: ReadonlyArray<{ id: string; evidence: readonly EvidenceRef[] }>,
): WalletRequestSummary[] {
  return decoded.map(({ captured, evidence: e }) => {
    const id = evidenceId(e);
    const t = captured.t;
    return {
      evidenceId: id,
      t: typeof t === 'number' && Number.isInteger(t) && t >= 0 ? t : null,
      kind: e.kind,
      method: e.method,
      phase: e.phase,
      outcome: e.outcome,
      frame: e.frame,
      chainId: e.chainId,
      verifyingContract: e.verifyingContract,
      spender: e.spender,
      token: e.token,
      amount: e.amount,
      deadline: e.deadline,
      siweDomain: e.siweDomain,
      unlimited: e.unlimited,
      longDeadline: e.longDeadline,
      chainIdMismatch: e.chainIdMismatch,
      domainMismatch: e.domainMismatch,
      preConnect: e.preConnect,
      findingIds: findingIdsFor(id, findings),
    };
  });
}

/** Ids of the findings that reference evidence item `id` (sorted, distinct). */
export function findingIdsFor(
  id: string,
  findings: ReadonlyArray<{ id: string; evidence: readonly EvidenceRef[] }>,
): string[] {
  return [
    ...new Set(findings.filter((f) => f.evidence.some((r) => r.id === id)).map((f) => f.id)),
  ].sort();
}
