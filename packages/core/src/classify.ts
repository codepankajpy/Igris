/**
 * Recipient classification.
 *
 * Order of precedence (first hit wins):
 *   1. first-party: same registrable domain as the scan target, or in the
 *      user-supplied --first-party list
 *   2. an exact registrable-domain match in third-parties.json
 *   3. a suffix rule in third-parties.json (for providers spread across many
 *      subdomains, e.g. *.ingest.sentry.io)
 *   4. unknown-third-party
 * The scan engine (engine.ts) adds two capture-based rules around this:
 * the domain the target redirected to is first party, and an unknown domain
 * whose every observed request is pure Ethereum JSON-RPC becomes
 * rpc-provider (rpcOnlyDomains). Both are stated in the report's notes.
 */
import { getDomain } from 'tldts';
import type { RecipientClass } from './report.js';
import type { ThirdPartyEntry } from './third-parties.js';

/**
 * Registrable domain (eTLD+1) of a hostname. tldts returns null for IPs,
 * localhost and non-ICANN TLDs such as the .test names our offline fixtures
 * use; we fall back to the last two labels (or the host itself) so fixture
 * hosts still group sensibly.
 */
export function registrableDomain(host: string): string {
  const clean = host.toLowerCase().replace(/\.$/, '');
  const domain = getDomain(clean, { allowPrivateDomains: false });
  if (domain) return domain;
  const labels = clean.split('.');
  if (labels.length >= 2 && !/^\d+\.\d+\.\d+\.\d+$/.test(clean)) {
    return labels.slice(-2).join('.');
  }
  return clean;
}

export interface ClassifyOptions {
  /** Registrable domain of the scanned page. */
  targetRegistrableDomain: string;
  /** Extra hosts/domains the user declares first-party (--first-party). */
  firstParty?: string[];
  db: ThirdPartyEntry[];
}

export interface Classification {
  host: string;
  registrableDomain: string;
  class: RecipientClass;
  /** Name of the matched third-parties.json entry, if any. */
  matchedEntry?: string;
}

export function classifyHost(host: string, opts: ClassifyOptions): Classification {
  const clean = host.toLowerCase();
  const rd = registrableDomain(clean);

  const firstPartyList = (opts.firstParty ?? []).map((d) => d.toLowerCase());
  if (
    rd === opts.targetRegistrableDomain.toLowerCase() ||
    firstPartyList.some((fp) => clean === fp || rd === registrableDomain(fp))
  ) {
    return { host: clean, registrableDomain: rd, class: 'first-party' };
  }

  for (const entry of opts.db) {
    if (entry.domains.some((d) => d.toLowerCase() === rd || d.toLowerCase() === clean)) {
      return { host: clean, registrableDomain: rd, class: entry.class, matchedEntry: entry.name };
    }
  }
  for (const entry of opts.db) {
    if (
      entry.suffixes?.some((s) => {
        const suffix = s.toLowerCase();
        return clean === suffix || clean.endsWith('.' + suffix);
      })
    ) {
      return { host: clean, registrableDomain: rd, class: entry.class, matchedEntry: entry.name };
    }
  }

  return { host: clean, registrableDomain: rd, class: 'unknown-third-party' };
}
