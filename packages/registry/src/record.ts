/**
 * What a published scan looks like in the registry: compact, queryable, and
 * free of anything sensitive. No raw URLs (they can embed the canary), no
 * snippets — just classes, hosts and the ledger. A sha256 of the full
 * report.json lets anyone holding that report prove it matches the entity.
 */
// Browser-safe module: types + pure helpers only (the viewer imports this).
// Node-only pieces (hashing, report conversion) live in from-report.ts.

export const RECORD_VERSION = 1;

/** Queryable attributes (one Arkiv entity per scan). */
export interface ScanRecord {
  hostname: string;
  /** 0–100 */
  score: number;
  /** Unix seconds — Arkiv cannot sort on $createdAt, so we store our own. */
  scannedAt: number;
  scannerVersion: string;
  reportVersion: string;
  chainId: number;
  thirdPartyCount: number;
  leakCount: number;
  /** Comma-joined recipient classes that saw the address (≤128 bytes). */
  leakClasses: string;
  usesAnonRpc: boolean;
  /** sha256 (hex) of the exact report.json bytes this record was made from. */
  reportSha256: string;
  /** Compact JSON summary (bytes payload, see SummaryPayload). */
  summary: SummaryPayload;
}

export interface SummaryPayload {
  v: number;
  status: Report['status'];
  spoofMetaMask: boolean;
  canaryAddress: string;
  findings: Array<{
    class: string;
    location: string;
    encoding: string;
    category: string;
    host: string;
    phase: string;
    counted: boolean;
  }>;
  thirdParties: Array<{ host: string; class: string; phases: string[] }>;
  ledger: Array<{ rule: string; points: number; label: string }>;
  readsViaWallet: Array<{ method: string; count: number }>;
}

/** A record as it comes back from a registry (with provenance). */
export interface RegistryRecord extends ScanRecord {
  /** Entity key (Arkiv) or a local id. */
  id: string;
  /** Scanner wallet address (Arkiv $owner), or "local". */
  scanner: string;
  /** ISO timestamp or block tag describing expiry, when known. */
  expiresAt?: string;
}

export interface RegistryQuery {
  hostname?: string;
  minScore?: number;
  maxScore?: number;
  /** Matched against the comma-joined leakClasses (client-side on Arkiv —
   * the query language has no substring operator; see arkiv/friction.md). */
  leakClass?: string;
  /** ISO date string; records scanned at/after this moment. */
  since?: string;
  usesAnonRpc?: boolean;
  /** Scanner address ($owner on Arkiv). */
  scanner?: string;
  limit?: number;
}

/** Shared client-side predicate (the local backend uses it for everything;
 * the Arkiv backend only for what the query language cannot express). */
export function matchesQuery(record: RegistryRecord, q: RegistryQuery): boolean {
  if (q.hostname !== undefined && record.hostname !== q.hostname) return false;
  if (q.minScore !== undefined && record.score < q.minScore) return false;
  if (q.maxScore !== undefined && record.score > q.maxScore) return false;
  if (q.leakClass !== undefined && !record.leakClasses.split(',').includes(q.leakClass))
    return false;
  if (q.since !== undefined && record.scannedAt < Math.floor(new Date(q.since).getTime() / 1000))
    return false;
  if (q.usesAnonRpc !== undefined && record.usesAnonRpc !== q.usesAnonRpc) return false;
  if (q.scanner !== undefined && record.scanner.toLowerCase() !== q.scanner.toLowerCase())
    return false;
  return true;
}

export interface PublishResult {
  id: string;
  scanner: string;
  txHash?: string;
  expiresAt?: string;
}

export interface RegistryBackend {
  readonly kind: 'local' | 'arkiv';
  publish(record: ScanRecord): Promise<PublishResult>;
  query(q: RegistryQuery): Promise<RegistryRecord[]>;
  /** Everything (for `igris snapshot` and the offline viewer). */
  snapshot(): Promise<RegistryRecord[]>;
}
