/**
 * Test-only fixtures (imported by *.test.ts; not exported from index).
 */
import type { ExecuteBatchParameters } from '@arkiv-network/sdk';
import {
  APPROVE_SELECTOR,
  MAX_UINT160,
  MAX_UINT256,
  PERMIT2_ADDRESS,
  bundleHash,
  type CapturedWalletRequest,
  type EvidenceBundle,
  type ScanResult,
  type WalletRequestSummary,
} from '@igris/core';
import { CANARY_A, req, sampleCapture, sampleResult } from '@igris/core/testing';
import { bytesToHex, encodeAbiParameters, keccak256, stringToHex, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { ArkivIo } from './arkiv.js';
import type { LoadedScanner } from './identity.js';
import type { WireEntity } from './payload.js';

/** The capture's walletRequests key, only when there are captured requests to set. */
const wallet = (walletRequests: CapturedWalletRequest[] | undefined) =>
  walletRequests === undefined ? {} : { walletRequests };

/**
 * The leaky sample (segment, sentry, infura) scanned at `scannedAt`.
 * `walletRequests`: what the canary wallet was asked (real captures: the
 * engine builds the report's walletRequests and their igris.evidence.v4
 * items from them).
 */
export function leaky(
  scannedAt = '2026-11-06T00:00:00.000Z',
  walletRequests?: CapturedWalletRequest[],
): ScanResult {
  return sampleResult({ scannedAt, capture: { ...sampleCapture(), ...wallet(walletRequests) } });
}

/** Same site, different behaviour: the segment tracker is gone. */
export function fixedSegment(
  scannedAt = '2026-11-07T00:00:00.000Z',
  walletRequests?: CapturedWalletRequest[],
): ScanResult {
  const capture = sampleCapture();
  return sampleResult({
    scannedAt,
    capture: {
      ...capture,
      requests: capture.requests.filter((r) => !r.url.includes('segment')),
      ...wallet(walletRequests),
    },
  });
}

/** Another site with one RPC call. */
export function otherSite(
  scannedAt = '2026-11-06T12:00:00.000Z',
  walletRequests?: CapturedWalletRequest[],
): ScanResult {
  const capture = sampleCapture();
  return sampleResult({
    target: 'https://other.example.net/',
    scannedAt,
    capture: {
      ...capture,
      ...wallet(walletRequests),
      requests: [
        req({ url: 'https://other.example.net/' }),
        ...capture.requests.filter((r) => r.url.includes('segment')),
      ],
      mainDocument: { url: 'https://other.example.net/', status: 200, headers: {} },
    },
  });
}

/** The leaky sample plus a recipient that is an IPv6 literal (no hostname). */
export const IPV6_RECIPIENT = '[2606:4700::1111]';
export function withIpv6Recipient(scannedAt = '2026-11-06T00:00:00.000Z'): ScanResult {
  const capture = sampleCapture();
  return sampleResult({
    scannedAt,
    capture: {
      ...capture,
      requests: [
        ...capture.requests,
        req({
          phase: 'post-connect',
          url: 'https://[2606:4700::1111]/dns-query',
          method: 'POST',
          resourceType: 'fetch',
          body: JSON.stringify({ q: 1 }),
        }),
      ],
    },
  });
}

/** Site `host` scanned at `scannedAt`; it calls segment.io unless `segment` is false. */
export function siteN(host: string, scannedAt: string, segment = true): ScanResult {
  const capture = sampleCapture();
  return sampleResult({
    target: `https://${host}/`,
    scannedAt,
    capture: {
      ...capture,
      requests: [
        req({ url: `https://${host}/` }),
        ...capture.requests.filter(
          (r) => r.url.includes('googleapis') || (segment && r.url.includes('segment')),
        ),
      ],
      mainDocument: { url: `https://${host}/`, status: 200, headers: {} },
    },
  });
}

// ---------------------------------------------------------------------------
// Wallet requests
// ---------------------------------------------------------------------------

export const SPENDER = '0x1111111111111111111111111111111111111111';
export const PERMIT2 = PERMIT2_ADDRESS;
export const TOKEN = '0x3333333333333333333333333333333333333333';
/** Unix seconds of the default scan time (2026-11-06T00:00:00Z). */
const SCAN_S = 1_793_923_200;

/** One captured wallet request (the scanner's TrafficRecorder shape). */
export function captured(
  method: CapturedWalletRequest['method'],
  params: unknown,
  over: Partial<CapturedWalletRequest> = {},
): CapturedWalletRequest {
  return {
    phase: 'post-connect',
    t: 1000,
    method,
    params: JSON.stringify(params),
    frame: 'main',
    origin: 'https://app.example.org',
    outcome: 'signed',
    ...over,
  };
}

/** eth_requestAccounts, answered. */
export const capturedConnect = (over: Partial<CapturedWalletRequest> = {}) =>
  captured('eth_requestAccounts', [], { outcome: 'answered', t: 900, ...over });

/** An unlimited Permit2 PermitSingle for SPENDER, on `chainId`. */
export function capturedPermit2(chainId: number, canary = CANARY_A): CapturedWalletRequest {
  return captured('eth_signTypedData_v4', [
    canary,
    JSON.stringify({
      types: { EIP712Domain: [] },
      primaryType: 'PermitSingle',
      domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS },
      message: {
        details: {
          token: TOKEN,
          amount: MAX_UINT160.toString(),
          expiration: SCAN_S + 3600,
          nonce: 0,
        },
        spender: SPENDER,
        sigDeadline: SCAN_S + 60,
      },
    }),
  ]);
}

/** A Sign-In with Ethereum message for `domain`. */
export function capturedSiwe(domain: string, canary = CANARY_A): CapturedWalletRequest {
  const message = `${domain} wants you to sign in with your Ethereum account:\n${canary}\n\nSign in.\n\nURI: https://${domain}\nVersion: 1\nChain ID: 1\nNonce: 1\nIssued At: 2026-11-06T00:00:00Z`;
  return captured('personal_sign', [stringToHex(message), canary], { t: 1200 });
}

/** eth_sendTransaction of ERC-20 approve(spender, MAX_UINT256) on TOKEN. */
export function capturedApprove(
  spender: string,
  over: Partial<CapturedWalletRequest> = {},
  canary = CANARY_A,
): CapturedWalletRequest {
  const data =
    APPROVE_SELECTOR +
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [spender as `0x${string}`, MAX_UINT256],
    ).slice(2);
  return captured('eth_sendTransaction', [{ from: canary, to: TOKEN, data }], over);
}

/** eth_sign of a raw 32-byte hash (a blind signature). */
export const capturedEthSign = (canary = CANARY_A) =>
  captured('eth_sign', [canary, '0x' + '11'.repeat(32)], { outcome: 'rejected' });

/** connect, an unlimited Permit2 on the wrong chain (10; wallet on 1), a SIWE for evil.example. */
export function sampleCapturedWalletRequests(): CapturedWalletRequest[] {
  return [capturedConnect(), capturedPermit2(10), capturedSiwe('evil.example')];
}

/**
 * `r` as a DRAFT 3.0.0 scan, exactly like the versions published on Arkiv
 * before wallet-request auditing: no `walletRequests` key, no
 * wallet-requests detector, an igris.evidence.v3 bundle (same items) and
 * report.evidence pointing at it. `r` must have no wallet-request evidence.
 */
export function asDraftV3(r: ScanResult): { report: Record<string, unknown>; bundle: unknown } {
  if (Object.values(r.bundle.items).some((i) => i.type === 'wallet-request'))
    throw new Error('asDraftV3: a draft has no wallet-request evidence');
  const bundle = { bundleVersion: 'igris.evidence.v3', items: r.bundle.items };
  const { walletRequests: _w, ...rest } = r.report;
  return {
    report: {
      ...rest,
      detectors: rest.detectors.filter((d) => d.id !== 'wallet-requests'),
      evidence: {
        ...rest.evidence,
        bundleVersion: 'igris.evidence.v3',
        sha256: bundleHash(bundle as unknown as EvidenceBundle),
      },
    },
    bundle,
  };
}

/** A schema-valid Report 3.0.0 wallet-request summary (defaults: a clean personal message). */
export function walletSummary(over: Partial<WalletRequestSummary> = {}): WalletRequestSummary {
  return {
    evidenceId: 'ev_000000000000000000000000',
    t: 1000,
    kind: 'personal-message',
    method: 'personal_sign',
    phase: 'post-connect',
    outcome: 'signed',
    frame: 'main',
    chainId: null,
    verifyingContract: null,
    spender: null,
    token: null,
    amount: null,
    deadline: null,
    siweDomain: null,
    unlimited: false,
    longDeadline: false,
    chainIdMismatch: false,
    domainMismatch: false,
    preConnect: false,
    findingIds: [],
    ...over,
  };
}

/** connect, an unlimited Permit2 on the wrong chain, a SIWE for another domain. */
export function sampleWalletRequests(): WalletRequestSummary[] {
  return [
    walletSummary({ kind: 'connect', method: 'eth_requestAccounts', outcome: 'answered' }),
    walletSummary({
      kind: 'permit2',
      method: 'eth_signTypedData_v4',
      chainId: 10,
      verifyingContract: PERMIT2,
      spender: SPENDER,
      amount: '1461501637330902918203684832716283019655932542975',
      unlimited: true,
      chainIdMismatch: true,
    }),
    walletSummary({ kind: 'siwe', siweDomain: 'evil.example', domainMismatch: true }),
  ];
}

/** The scan result with `walletRequests` set on its report (evidence unchanged). */
export function withWalletRequests(
  r: ScanResult,
  walletRequests: WalletRequestSummary[] | null | undefined,
): ScanResult {
  const report = { ...r.report } as Record<string, unknown>;
  if (walletRequests === undefined) delete report.walletRequests;
  else report.walletRequests = walletRequests;
  return { ...r, report: report as unknown as ScanResult['report'] };
}

// ---------------------------------------------------------------------------
// A fake Arkiv node
// ---------------------------------------------------------------------------

export function scanner(): LoadedScanner {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  return {
    privateKey,
    address,
    profile: {
      schema: 'igris.scanner.v1',
      address,
      name: 'test',
      nodeId: '00000000-0000-4000-8000-000000000000',
      createdAt: '2026-11-06T00:00:00.000Z',
      origin: 'generated',
    },
  };
}

export type Create = {
  schema: { name: string; columns: Record<string, { type: string }> };
  values: Record<string, unknown>;
  expiration: unknown;
  flags?: { readonly?: boolean; permissionlessExtension?: boolean };
};

type Term = { name: string; op: string; value: string | number };

/**
 * A minimal in-memory Arkiv node: stores batch creates in the JSON-RPC wire
 * shape the real node returns (u64 as 0x hex, owner lower-case, creation
 * flags as a byte) and answers the subset of the query language the
 * registry emits (=, >= and <=; OR groups of equalities on one attribute;
 * ORDER BY).
 */
export class FakeNode {
  entities: WireEntity[] = [];
  queries: string[] = [];
  batches: ExecuteBatchParameters[] = [];
  /** Simulate a node (or a proxy) that ignores the owner filter. */
  ignoreOwnerFilter = false;
  private n = 0;
  constructor(public owner: string) {}

  io: ArkivIo = {
    query: async (q, options) => {
      this.queries.push(q);
      const [where = '', order] = q.split(' ORDER BY ');
      const creators = new Set<string>();
      const terms: Term[] = [];
      for (const m of where.matchAll(
        /(\$?[A-Za-z][\w.]*) (=|>=|<=) (?:str\('((?:[^']|'')*)'\)|(?:i32|u64)\((-?\d+)\)|addr\((0x[0-9a-fA-F]{40})\)|key\((0x[0-9a-fA-F]{64})\))/g,
      )) {
        const [, name, op, s, n, a, k] = m;
        if (name === '$creator') creators.add(a!.toLowerCase());
        else
          terms.push({
            name: name!,
            op: op!,
            value:
              s !== undefined
                ? s.replaceAll("''", "'")
                : n !== undefined
                  ? Number(n)
                  : k!.toLowerCase(),
          });
      }
      const val = (e: WireEntity, name: string) => e.attributes.find((x) => x.name === name)?.value;
      const num = (v: unknown) => {
        try {
          return Number(BigInt(v as string | number));
        } catch {
          return NaN;
        }
      };
      const match = (e: WireEntity, t: Term) =>
        t.name === '$key'
          ? e.key.toLowerCase() === t.value
          : typeof t.value === 'number'
            ? t.op === '>='
              ? num(val(e, t.name)) >= t.value
              : t.op === '<='
                ? num(val(e, t.name)) <= t.value
                : num(val(e, t.name)) === t.value
            : val(e, t.name) === t.value;
      // The registry only ever ORs equalities on ONE attribute (an owner or a
      // hostname group) and ANDs everything else: group equalities by name;
      // each range term (>=, <=) is its own group.
      const groups = new Map<string, Term[]>();
      terms.forEach((t, i) => {
        const g = t.op === '=' ? t.name : `${t.name}#${i}`;
        groups.set(g, [...(groups.get(g) ?? []), t]);
      });
      let rows = this.entities.filter(
        (e) =>
          (this.ignoreOwnerFilter ||
            creators.size === 0 ||
            creators.has(e.creator.toLowerCase())) &&
          [...groups.values()].every((g) => g.some((t) => match(e, t))),
      );
      if (order) {
        const [name, rest = ''] = order.split(':');
        const asc = rest.endsWith(' ASC');
        const key = (e: WireEntity) => {
          const v = num(val(e, name!));
          return Number.isNaN(v) ? -1 : v; // the real node would not hold a mistyped value
        };
        rows = [...rows].sort((x, y) => (asc ? key(x) - key(y) : key(y) - key(x)));
      }
      const offset = options.offset ? Number(options.offset) : 0;
      rows = rows.slice(offset, offset + Number(options.limit));
      const sel = options.select.attributes;
      return {
        data: rows.map((e) => ({
          key: e.key,
          owner: e.owner,
          creator: e.creator,
          expiresAt: e.expiresAt,
          ...(options.select.creationFlags && e.creationFlags !== undefined
            ? {
                creationFlags: {
                  readonly: (e.creationFlags & 1) !== 0,
                  permissionlessExtension: (e.creationFlags & 2) !== 0,
                  raw: e.creationFlags,
                },
              }
            : {}),
          attributes:
            sel === true
              ? e.attributes
              : e.attributes.filter((x) => typeof sel === 'object' && sel[x.name]),
        })),
        blockNumber: '0x1',
      };
    },
    executeBatch: async (params) => {
      this.batches.push(params);
      const created: string[] = [];
      for (const c of (params.creates ?? []) as unknown as Create[]) {
        const key = keccak256(toHex(`entity-${++this.n}`));
        const attributes = [{ name: 'arkiv.schema', type: 'str', value: c.schema.name }];
        for (const [name, col] of Object.entries(c.schema.columns)) {
          const v = c.values[name];
          const raw =
            typeof v === 'object' && v !== null && 'type' in v && 'value' in v
              ? (v as { value: unknown }).value
              : v;
          attributes.push({
            name,
            type: col.type,
            value: (col.type === 'u64'
              ? toHex(BigInt(raw as bigint))
              : col.type === 'bytes'
                ? bytesToHex(raw as Uint8Array)
                : raw) as string,
          });
        }
        this.entities.push({
          key,
          owner: this.owner.toLowerCase(),
          creator: this.owner.toLowerCase(),
          expiresAt: '0x77d0a0',
          creationFlags: (c.flags?.readonly ? 1 : 0) | (c.flags?.permissionlessExtension ? 2 : 0),
          attributes,
        });
        created.push(key);
      }
      return { txHash: keccak256(toHex(`tx-${this.batches.length}`)), createdEntities: created };
    },
  };
}
