/**
 * Arkiv registry backend (Rabdi testnet by default).
 *
 * Trust model: an entity is an ATTESTATION BY ITS SCANNER ADDRESS, not a
 * fact. Anyone can write entities with our schema tag, so every consumer
 * (CLI and viewer) filters by $owner against pinned scanner addresses.
 */
import { createPublicClient, createWalletClient, ExpirationTime } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { and, asc, desc, eq, gt, gte, lte } from '@arkiv-network/sdk/query';
import { bool, i32, key, u64 } from '@arkiv-network/sdk/schema';
import { http, stringToBytes, hexToString, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  matchesQuery,
  type PublishResult,
  type RegistryBackend,
  type RegistryQuery,
  type RegistryRecord,
  type ScanRecord,
} from './record.js';
import { ScanSchema } from './schema.js';
import { validateRecords, type ValidatedRecords } from './validate.js';

export const RABDI_RPC_URL = 'https://rpc.rabdi.db-chain.testnet.arkiv.network';
export const RABDI_EXPLORER_URL = 'https://rabdi.explorer.arkiv.network';
export const DEFAULT_EXPIRY_DAYS = 30;

export interface ArkivRegistryOptions {
  /** Hex private key of the scanner wallet (publish only). */
  privateKey?: string;
  /** Override the RPC endpoint (reads reveal the reader's IP to it). */
  rpcUrl?: string;
  /** Arkiv Hub access key (rate limits; optional for light use). */
  accessKey?: string;
  /** Entity lifetime in days (max ~182; default 30 — see arkiv/schema.md). */
  expiryDays?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export class ArkivRegistry implements RegistryBackend {
  readonly kind = 'arkiv' as const;
  /** Validation outcome of the most recent query()/snapshot() call. */
  lastValidation: Omit<ValidatedRecords, 'records'> = { dropped: 0, reasons: [] };
  private chain;
  private transport;

  constructor(private options: ArkivRegistryOptions = {}) {
    this.chain = rabdi({ accessKey: options.accessKey ?? '' });
    this.transport = options.rpcUrl ? http(options.rpcUrl) : http();
  }

  private publicClient() {
    return createPublicClient({ chain: this.chain, transport: this.transport });
  }

  async publish(record: ScanRecord): Promise<PublishResult> {
    if (!this.options.privateKey) {
      throw new Error(
        'ArkivRegistry.publish needs ARKIV_PRIVATE_KEY (fund it at https://hub.arkiv.network/faucet), or use --registry local',
      );
    }
    const account = privateKeyToAccount(this.options.privateKey as Hex);
    const walletClient = createWalletClient({
      chain: this.chain,
      transport: this.transport,
      account,
    });
    const { entityKey, txHash, expiresAt } = await walletClient.createEntity(
      ScanSchema,
      {
        hostname: record.hostname,
        score: record.score,
        scannedAt: u64(BigInt(record.scannedAt)),
        leakCount: record.leakCount,
        thirdPartyCount: record.thirdPartyCount,
        usesAnonRpc: record.usesAnonRpc,
        leakClasses: record.leakClasses,
        scannerVersion: record.scannerVersion,
        reportVersion: record.reportVersion,
        chainId: record.chainId,
        reportSha256: record.reportSha256,
        summary: stringToBytes(JSON.stringify(record.summary)),
      },
      { expiration: ExpirationTime.fromDays(this.options.expiryDays ?? DEFAULT_EXPIRY_DAYS) },
    );
    return {
      id: entityKey,
      scanner: account.address,
      txHash,
      expiresAt: `block ${expiresAt}`,
    };
  }

  async query(q: RegistryQuery): Promise<RegistryRecord[]> {
    const conditions: any[] = [];
    if (q.hostname !== undefined) conditions.push(eq('hostname', q.hostname));
    if (q.minScore !== undefined) conditions.push(gte('score', i32(q.minScore)));
    if (q.maxScore !== undefined) conditions.push(lte('score', i32(q.maxScore)));
    if (q.usesAnonRpc !== undefined) conditions.push(eq('usesAnonRpc', bool(q.usesAnonRpc)));
    if (q.since !== undefined)
      conditions.push(
        gte('scannedAt', u64(BigInt(Math.floor(new Date(q.since).getTime() / 1000)))),
      );

    let builder: any = this.publicClient()
      .select('*')
      .from(ScanSchema)
      .orderBy(desc('scannedAt'))
      .limit(Math.min(q.limit ?? 100, 100));
    if (q.scanner) builder = builder.ownedBy(q.scanner as Hex);
    if (conditions.length === 1) builder = builder.where(conditions[0]);
    else if (conditions.length > 1) builder = builder.where(and(...conditions));

    const { entities } = await builder.fetch();
    const validated = validateRecords(entities.map(rawRowToCandidate), { source: 'arkiv' });
    this.lastValidation = { dropped: validated.dropped, reasons: validated.reasons };
    const records = validated.records;
    // leakClass has no server-side operator (no substring match in the Arkiv
    // query language) — filter client-side; recorded in arkiv/friction.md.
    const leakClass = q.leakClass;
    if (leakClass === undefined) return records;
    return records.filter((r: RegistryRecord) => matchesQuery(r, { leakClass }));
  }

  /** Walk every entity of our schema (key-cursor pagination, pages of 100). */
  async snapshot(): Promise<RegistryRecord[]> {
    const out: RegistryRecord[] = [];
    let dropped = 0;
    const reasons: string[] = [];
    let lastKey: Hex | undefined;
    for (;;) {
      let builder: any = this.publicClient()
        .select('*')
        .from(ScanSchema)
        .orderBy(asc('$key'))
        .limit(100);
      if (lastKey) builder = builder.where(gt('$key', key(lastKey)));
      const { entities } = await builder.fetch();
      const validated = validateRecords(entities.map(rawRowToCandidate), { source: 'arkiv' });
      out.push(...validated.records);
      dropped += validated.dropped;
      reasons.push(...validated.reasons.slice(0, Math.max(0, 5 - reasons.length)));
      if (entities.length < 100) break;
      lastKey = entities[entities.length - 1].$key;
    }
    this.lastValidation = { dropped, reasons };
    return out;
  }
}

/**
 * Map an SDK row (typed values with .value) onto the RegistryRecord shape
 * WITHOUT trusting it: any field may be missing or of the wrong type, and the
 * summary bytes may be anything. The result is a candidate for
 * parseRegistryRecord (validate.ts); this function itself never throws.
 */
export function rawRowToCandidate(e: any): unknown {
  const val = (k: string): unknown => (e && typeof e[k] === 'object' ? e[k]?.value : undefined);
  const num = (k: string): unknown => {
    const v = val(k);
    if (typeof v === 'bigint') return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : NaN;
    return v;
  };
  let summary: unknown = undefined;
  try {
    const raw = val('summary');
    if (typeof raw === 'string') summary = JSON.parse(hexToString(raw as Hex));
  } catch {
    summary = undefined; // invalid → the record is rejected by validation
  }
  return {
    id: e?.$key,
    scanner: e?.$owner,
    ...(e?.$expiresAt !== undefined ? { expiresAt: `block ${String(e.$expiresAt)}` } : {}),
    hostname: val('hostname'),
    score: num('score'),
    scannedAt: num('scannedAt'),
    leakCount: num('leakCount'),
    thirdPartyCount: num('thirdPartyCount'),
    usesAnonRpc: val('usesAnonRpc'),
    leakClasses: val('leakClasses'),
    scannerVersion: val('scannerVersion'),
    reportVersion: val('reportVersion'),
    chainId: num('chainId'),
    reportSha256: val('reportSha256'),
    summary,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
