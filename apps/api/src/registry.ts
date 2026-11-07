/**
 * The site registry this API publishes to and reads from, chosen from the
 * environment:
 *
 *   IGRIS_REGISTRY          arkiv | local (default: arkiv when a scanner
 *                           profile exists on this machine, else local)
 *   IGRIS_SCANNER           scanner profile name or address (default: the
 *                           only profile)
 *   IGRIS_TRUSTED_SCANNERS  comma-separated owner addresses whose entities
 *                           are read (default: the publisher; the publisher
 *                           is always included so its own history is read)
 *   ARKIV_ACCESS_KEY        Arkiv access key — from process.env only (the
 *                           dev/start commands load .env.arkiv with Node's
 *                           --env-file-if-exists; this code never reads it)
 *   ARKIV_RPC_URL           optional Arkiv RPC override
 *   ARKIV_EXPIRY_DAYS       entity lifetime in days, 1–182 (default 180)
 *
 * Local mode keeps the registry in <dataDir>/registry.json; its publisher is
 * always the label "local" (unsigned rows never borrow a scanner address).
 *
 * Readiness is reported honestly: Arkiv mode without a loadable scanner key
 * is read-only (ready: false, with the reason), and the API then refuses new
 * scans rather than run scans it cannot publish.
 */
import { join } from 'node:path';
import type { LoadedScanner, ScannerProfile, SiteRegistry } from '@igris/registry';

export type RegistryMode = 'arkiv' | 'local';

export interface RegistryInfo {
  mode: RegistryMode;
  publisher: string | null;
  network: string;
  trustedOwners: string[];
  ready: boolean;
  reason?: string;
}

export interface RegistryFactories {
  listScanners: () => ScannerProfile[];
  loadScanner: (opts: { selector?: string }) => LoadedScanner;
  local: (opts: {
    file: string;
    publisher: string | null;
    trustedOwners: string[];
  }) => SiteRegistry;
  arkiv: (opts: {
    scanner: LoadedScanner | null;
    accessKey?: string;
    rpcUrl?: string;
    trustedOwners: string[];
    expiryDays: number;
  }) => SiteRegistry;
}

export const DEFAULT_EXPIRY_DAYS = 180;
export const ARKIV_NETWORK = 'arkiv-rabdi-testnet';
export const LOCAL_PUBLISHER = 'local';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function owners(raw: string | undefined, mode: RegistryMode): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (mode === 'arkiv') {
    const bad = list.find((a) => !ADDRESS_RE.test(a));
    if (bad) throw new Error(`IGRIS_TRUSTED_SCANNERS: "${bad}" is not an address`);
  }
  return list;
}

function withPublisher(list: string[], publisher: string | null): string[] {
  if (!publisher) return list;
  return list.some((a) => a.toLowerCase() === publisher.toLowerCase())
    ? list
    : [publisher, ...list];
}

export function createRegistry(
  env: NodeJS.ProcessEnv,
  dataDir: string,
  f: RegistryFactories,
): { registry: SiteRegistry; info: RegistryInfo } {
  // Empty (e.g. a blank line copied from .env.example) means not set.
  const requested = env.IGRIS_REGISTRY?.trim() || undefined;
  if (requested && requested !== 'arkiv' && requested !== 'local') {
    throw new Error(`IGRIS_REGISTRY must be "arkiv" or "local" (got "${requested}")`);
  }
  let profiles: ScannerProfile[] = [];
  let profilesError: string | null = null;
  try {
    profiles = f.listScanners();
  } catch (err) {
    profilesError = (err as Error).message;
  }
  const mode: RegistryMode =
    (requested as RegistryMode | undefined) ?? (profiles.length > 0 ? 'arkiv' : 'local');

  if (mode === 'local') {
    // Local entities are never signed, so they never carry a real scanner
    // address: a local registry claiming to be "0xabc…" would be passing off
    // unsigned rows as that scanner's attestations. IGRIS_SCANNER selects a
    // signing key, which only Arkiv mode uses.
    const publisher = LOCAL_PUBLISHER;
    const trustedOwners = withPublisher(owners(env.IGRIS_TRUSTED_SCANNERS, mode), publisher);
    const registry = f.local({ file: join(dataDir, 'registry.json'), publisher, trustedOwners });
    return {
      registry,
      info: { mode, publisher, network: 'local', trustedOwners, ready: true },
    };
  }

  const raw = env.ARKIV_EXPIRY_DAYS;
  const expiryDays = raw === undefined || raw === '' ? DEFAULT_EXPIRY_DAYS : Number(raw);
  if (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 182) {
    throw new Error(`ARKIV_EXPIRY_DAYS must be an integer in [1, 182] (got "${raw}")`);
  }
  const rpcUrl = env.ARKIV_RPC_URL?.trim() || undefined;
  let network = ARKIV_NETWORK;
  if (rpcUrl) {
    try {
      network = new URL(rpcUrl).host;
    } catch {
      throw new Error('ARKIV_RPC_URL is not a valid URL');
    }
  }

  const selector = env.IGRIS_SCANNER?.trim() || undefined;
  let scanner: LoadedScanner | null = null;
  let reason: string | undefined;
  if (profilesError) {
    reason = `scanner profiles could not be read: ${profilesError}`;
  } else if (profiles.length === 0) {
    reason = 'no scanner profile on this machine: publishing to Arkiv needs a scanner key';
  } else {
    try {
      scanner = f.loadScanner(selector ? { selector } : {});
    } catch (err) {
      reason = `scanner key could not be loaded: ${(err as Error).message}`;
    }
  }
  const publisher = scanner?.address ?? null;
  const trustedOwners = withPublisher(owners(env.IGRIS_TRUSTED_SCANNERS, mode), publisher);
  const accessKey = env.ARKIV_ACCESS_KEY?.trim() || undefined;
  const registry = f.arkiv({
    scanner,
    ...(accessKey ? { accessKey } : {}),
    ...(rpcUrl ? { rpcUrl } : {}),
    trustedOwners,
    expiryDays,
  });
  const info: RegistryInfo = {
    mode,
    publisher,
    network,
    trustedOwners,
    ready: scanner !== null,
    ...(reason ? { reason } : {}),
  };
  return { registry, info };
}
