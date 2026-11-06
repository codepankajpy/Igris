/**
 * Canary encoding catalogue.
 *
 * Given the canary address, we precompute every textual form we know how to
 * detect. Each variant is a literal string searched for in captured traffic
 * (except `partial`, which is a regex — see detect.ts). The full list is kept
 * in ONE place (this module) so the report, the docs and the tests can agree
 * on exactly what we can and cannot see.
 *
 * Categories:
 *  - exact:   a decoded, unambiguous occurrence of the address → counts as a leak
 *  - hashed:  a digest of the address → "hashed, still linkable", reduced penalty
 *  - partial: a truncated display form (0x1234…abcd) → low confidence, excluded
 *             from the score by default
 */
import { getAddress, keccak256, sha256 } from 'viem';

export type MatchCategory = 'exact' | 'hashed' | 'partial';

export interface CanaryVariant {
  /** Human-readable encoding label, e.g. "base64(lowercase)" */
  encoding: string;
  /** The literal string to search for (case-sensitive unless caseInsensitive) */
  value: string;
  category: MatchCategory;
  /**
   * Search case-insensitively. Only safe for hex forms (where case carries no
   * information); base64 is case-sensitive by construction.
   */
  caseInsensitive: boolean;
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function b64Bytes(hexNo0x: string): string {
  return Buffer.from(hexNo0x, 'hex').toString('base64');
}

function b64Variants(label: string, value: string): CanaryVariant[] {
  const out: CanaryVariant[] = [
    { encoding: `base64(${label})`, value, category: 'exact', caseInsensitive: false },
  ];
  // Unpadded form: common when base64 is embedded in tokens.
  const unpadded = value.replace(/=+$/, '');
  if (unpadded !== value) {
    out.push({
      encoding: `base64-unpadded(${label})`,
      value: unpadded,
      category: 'exact',
      caseInsensitive: false,
    });
  }
  // base64url alphabet.
  const urlSafe = unpadded.replace(/\+/g, '-').replace(/\//g, '_');
  if (urlSafe !== unpadded) {
    out.push({
      encoding: `base64url(${label})`,
      value: urlSafe,
      category: 'exact',
      caseInsensitive: false,
    });
  }
  return out;
}

/** 32-byte left-padded (ABI word) form of a 20-byte address, lowercase, no 0x. */
export function abiPadded(addressNo0xLower: string): string {
  return '0'.repeat(24) + addressNo0xLower;
}

export interface CanaryForms {
  /** EIP-55 checksummed, 0x-prefixed */
  checksummed: string;
  /** all-lowercase, 0x-prefixed */
  lowercase: string;
  /** core 40 hex chars, lowercase, no 0x */
  coreLower: string;
  /** first 6 + last 4 hex chars of the core, for the partial-display regex */
  partialFirst6: string;
  partialLast4: string;
  variants: CanaryVariant[];
}

/**
 * Build every detectable form of `address`.
 *
 * Note an honest limitation (documented in METHODOLOGY): base64 matching only
 * finds the address base64-encoded *as a standalone string*. If a site base64s
 * a whole JSON body, the address's encoding depends on its byte offset within
 * that body and no fixed substring can match it.
 */
export function buildCanaryForms(address: string): CanaryForms {
  const checksummed = getAddress(address);
  const lowercase = checksummed.toLowerCase();
  const coreLower = lowercase.slice(2);
  const coreUpper = coreLower.toUpperCase();
  const uppercase = '0x' + coreUpper;
  const padded = abiPadded(coreLower);

  const variants: CanaryVariant[] = [];

  // --- exact, hex forms ---
  // One case-insensitive search for the bare 40-hex core covers lowercase,
  // uppercase, checksummed, 0x/no-0x and any other mixed-case rendering.
  // detect.ts re-inspects the actual matched text to label which form it was.
  variants.push({
    encoding: 'hex-core',
    value: coreLower,
    category: 'exact',
    caseInsensitive: true,
  });
  // ABI 32-byte word (calldata, event topics). The core search would also hit
  // inside this; detect.ts prefers the more specific overlapping match.
  variants.push({
    encoding: 'abi-padded-32',
    value: padded,
    category: 'exact',
    caseInsensitive: true,
  });

  // --- exact, base64 of textual forms ---
  variants.push(...b64Variants('lowercase', b64(lowercase)));
  variants.push(...b64Variants('checksummed', b64(checksummed)));
  variants.push(...b64Variants('uppercase', b64(uppercase)));
  variants.push(...b64Variants('no-0x-lowercase', b64(coreLower)));
  variants.push(...b64Variants('abi-padded-32', b64('0x' + padded)));
  // --- exact, base64 of raw bytes ---
  variants.push(...b64Variants('raw-20-bytes', b64Bytes(coreLower)));
  variants.push(...b64Variants('raw-32-bytes-padded', b64Bytes(padded)));

  // --- exact, URL-encoded ---
  // Hex forms URL-encode to themselves, so the only distinct URL-encoded forms
  // come from base64 values containing + / =.
  for (const v of [...variants]) {
    if (!v.encoding.startsWith('base64')) continue;
    const enc = encodeURIComponent(v.value);
    if (enc !== v.value) {
      variants.push({
        encoding: `url-encoded(${v.encoding})`,
        value: enc,
        category: 'exact',
        caseInsensitive: false,
      });
    }
  }

  // --- hashed forms: keccak256 / sha256 of the lowercase and checksummed text ---
  const digests: Array<[string, `0x${string}`]> = [
    ['keccak256(lowercase)', keccak256(Buffer.from(lowercase, 'utf8'))],
    ['keccak256(checksummed)', keccak256(Buffer.from(checksummed, 'utf8'))],
    ['sha256(lowercase)', sha256(Buffer.from(lowercase, 'utf8'))],
    ['sha256(checksummed)', sha256(Buffer.from(checksummed, 'utf8'))],
  ];
  for (const [label, digest] of digests) {
    const hexNo0x = digest.slice(2);
    // Case-insensitive hex search covers 0x/no-0x and upper/lower digests.
    variants.push({
      encoding: `${label}-hex`,
      value: hexNo0x,
      category: 'hashed',
      caseInsensitive: true,
    });
    const b = b64Bytes(hexNo0x);
    for (const v of b64Variants(label, b)) {
      variants.push({
        ...v,
        encoding: v.encoding.replace('base64', 'base64-digest'),
        category: 'hashed',
      });
    }
  }

  // Dedupe identical literal values (keep the first/most descriptive label).
  const seen = new Set<string>();
  const deduped = variants.filter((v) => {
    const key = (v.caseInsensitive ? v.value.toLowerCase() : v.value) + '|' + v.caseInsensitive;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    checksummed,
    lowercase,
    coreLower,
    partialFirst6: coreLower.slice(0, 6),
    partialLast4: coreLower.slice(-4),
    variants: deduped,
  };
}
