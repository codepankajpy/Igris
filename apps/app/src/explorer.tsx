/**
 * Links to the public Arkiv block explorer. The base URL comes from the API
 * (GET /api/registry → explorer), so this bundle carries no third-party URL
 * and makes no request: a link is only followed when the visitor clicks it,
 * in a new tab, without a referrer.
 */
import { createContext, type ComponentChildren } from 'preact';
import { useContext } from 'preact/hooks';

export const ExplorerContext = createContext<string | null>(null);

export function useExplorer(): string | null {
  return useContext(ExplorerContext);
}

export const explorerUrl = {
  tx: (base: string, hash: string) => `${base}/tx/${hash}`,
  entity: (base: string, key: string) => `${base}/entity/${key}`,
  /** Every igris.scan.v2 entity of one site (any owner — the explorer is just a viewer). */
  versions: (base: string, hostname: string) =>
    `${base}/entity-explorer?q=${encodeURIComponent(
      `arkiv.schema = str('igris.scan.v2') AND hostname = str('${hostname}')`,
    )}`,
};

/** Hex keys and hashes only (never interpolate anything else into a URL path). */
const HEX = /^0x[0-9a-fA-F]{64}$/;

export function ExplorerLink({
  kind,
  value,
  children,
}: {
  kind: 'tx' | 'entity' | 'versions';
  value: string;
  children: ComponentChildren;
}) {
  const base = useExplorer();
  if (!base) return null;
  if (kind !== 'versions' && !HEX.test(value)) return null;
  const href =
    kind === 'tx'
      ? explorerUrl.tx(base, value)
      : kind === 'entity'
        ? explorerUrl.entity(base, value)
        : explorerUrl.versions(base, value);
  return (
    <a class="link ext-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span aria-hidden="true"> ↗</span>
      <span class="sr-only"> (opens the Arkiv explorer in a new tab)</span>
    </a>
  );
}

/** "arkiv-rabdi-testnet" → "Rabdi testnet". */
export function networkLabel(network: string): string {
  if (/rabdi/i.test(network)) return 'Rabdi testnet';
  return network;
}
