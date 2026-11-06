/** Shared --registry plumbing for publish/query/snapshot. */
import { ArkivRegistry, LocalRegistry, loadScanner, type RegistryBackend } from '@igris/registry';

export interface RegistryFlags {
  registry?: string;
  'local-file'?: string;
  'rpc-url'?: string;
  'expiry-days'?: string;
  scanner?: string;
}

export const REGISTRY_FLAG_OPTIONS = {
  registry: { type: 'string' as const, default: 'arkiv' },
  'local-file': { type: 'string' as const },
  'rpc-url': { type: 'string' as const },
  'expiry-days': { type: 'string' as const },
};

/** publish only: which scanner identity signs (default: this node's only scanner). */
export const SCANNER_FLAG_OPTION = { scanner: { type: 'string' as const } };

/**
 * `forWrite`: load this node's scanner key (signing). Reads never touch keys.
 * Keys come only from the node's scanner store (igris scanner init), never
 * from environment variables.
 */
export function makeBackend(flags: RegistryFlags, forWrite = false): RegistryBackend {
  if (flags.registry === 'local') {
    return new LocalRegistry(flags['local-file']);
  }
  if (flags.registry !== 'arkiv') {
    throw new Error(`unknown --registry "${flags.registry}" (expected: arkiv, local)`);
  }
  const expiryDays = flags['expiry-days'] !== undefined ? Number(flags['expiry-days']) : undefined;
  if (expiryDays !== undefined && !Number.isFinite(expiryDays)) {
    throw new Error('--expiry-days needs a number');
  }
  const rpcUrl = flags['rpc-url'] ?? process.env.ARKIV_RPC_URL;
  return new ArkivRegistry({
    ...(forWrite
      ? { privateKey: loadScanner(flags.scanner ? { selector: flags.scanner } : {}).privateKey }
      : {}),
    ...(rpcUrl ? { rpcUrl } : {}),
    ...(process.env.ARKIV_ACCESS_KEY ? { accessKey: process.env.ARKIV_ACCESS_KEY } : {}),
    ...(expiryDays !== undefined ? { expiryDays } : {}),
  });
}
