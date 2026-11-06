/**
 * Canary detection over captured text (URLs, headers, bodies, WS frames,
 * cookies, storage values).
 *
 * Detection is substring search over the precomputed variant catalogue from
 * encodings.ts, plus one regex for truncated display forms. Searching decoded
 * literals (rather than decoding the traffic) means a JSON-RPC batch body, a
 * query string or a header all work the same way.
 *
 * Overlap rule: when two matches cover overlapping character ranges, the more
 * specific (longer) one wins — e.g. the bare 40-hex core always matches inside
 * an ABI-padded 32-byte word, and a full address also satisfies the partial
 * display regex; we report only `abi-padded-32` / the exact form respectively.
 */
import type { CanaryForms, MatchCategory } from './encodings.js';

export interface CanaryMatch {
  /** Final encoding label, e.g. "checksummed", "abi-padded-32", "base64(lowercase)" */
  encoding: string;
  category: MatchCategory;
  /** Character offset of the match in the searched text */
  index: number;
  /** Length of the matched substring */
  length: number;
}

/** How many characters of context to keep on each side of a redacted match. */
export const SNIPPET_CONTEXT = 40;

function findAll(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

/**
 * Refine the generic `hex-core` label by looking at the actual matched text
 * and its 0x prefix, so the report can say *which* case form leaked.
 */
function labelHexCoreMatch(text: string, index: number, forms: CanaryForms): CanaryMatch {
  const matched = text.slice(index, index + 40);
  const prefixed = index >= 2 && text.slice(index - 2, index).toLowerCase() === '0x';
  let caseLabel: string;
  if (matched === forms.coreLower) caseLabel = 'lowercase';
  else if (matched === forms.coreLower.toUpperCase()) caseLabel = 'uppercase';
  else if ('0x' + matched === forms.checksummed) caseLabel = 'checksummed';
  else caseLabel = 'mixed-case';
  const encoding = prefixed ? caseLabel : `no-0x-${caseLabel}`;
  return {
    encoding,
    category: 'exact',
    index: prefixed ? index - 2 : index,
    length: prefixed ? 42 : 40,
  };
}

/**
 * Find every occurrence of the canary (exact, hashed and partial forms) in
 * `text`. Results are sorted by index and de-overlapped (most specific wins).
 */
export function findCanary(text: string, forms: CanaryForms): CanaryMatch[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const matches: CanaryMatch[] = [];

  for (const v of forms.variants) {
    const haystack = v.caseInsensitive ? lower : text;
    const needle = v.caseInsensitive ? v.value.toLowerCase() : v.value;
    for (const idx of findAll(haystack, needle)) {
      if (v.encoding === 'hex-core') {
        matches.push(labelHexCoreMatch(text, idx, forms));
      } else if (v.encoding === 'abi-padded-32') {
        const prefixed = idx >= 2 && lower.slice(idx - 2, idx) === '0x';
        matches.push({
          encoding: 'abi-padded-32',
          category: 'exact',
          index: prefixed ? idx - 2 : idx,
          length: prefixed ? v.value.length + 2 : v.value.length,
        });
      } else {
        matches.push({
          encoding: v.encoding,
          category: v.category,
          index: idx,
          length: v.value.length,
        });
      }
    }
  }

  // Partial display form: first6 … last4 with a non-hex separator between, so
  // the full address can never satisfy it. Case-insensitive.
  const partialRe = new RegExp(
    `(?:0x)?${forms.partialFirst6}[^0-9a-fA-F]{1,4}${forms.partialLast4}`,
    'gi',
  );
  for (const m of lower.matchAll(partialRe)) {
    matches.push({
      encoding: 'truncated-display',
      category: 'partial',
      index: m.index ?? 0,
      length: m[0].length,
    });
  }

  // De-overlap: prefer longer matches; among equal lengths, prefer exact over
  // hashed over partial, then first label. Sort by (index, -length) and sweep.
  const rank: Record<MatchCategory, number> = { exact: 0, hashed: 1, partial: 2 };
  matches.sort(
    (a, b) => a.index - b.index || b.length - a.length || rank[a.category] - rank[b.category],
  );
  const kept: CanaryMatch[] = [];
  for (const m of matches) {
    const overlapping = kept.find(
      (k) => m.index < k.index + k.length && k.index < m.index + m.length,
    );
    if (!overlapping) kept.push(m);
    // If it overlaps, the earlier/longer match already covers this region.
  }
  return kept;
}

/**
 * Redact the matched canary form with `<CANARY>` and keep SNIPPET_CONTEXT
 * characters of context on each side. Any *other* canary occurrences that
 * happen to fall inside the context window are redacted too, so a snippet can
 * never re-leak the address it reports.
 */
export function redactSnippet(text: string, match: CanaryMatch, forms: CanaryForms): string {
  // Redact EVERY occurrence in the full text first, then slice the context
  // window. Slicing first could cut a neighbouring occurrence mid-address and
  // leave most of its hex chars visible — a snippet must never re-leak the
  // address it reports.
  const all = findCanary(text, forms);
  let redacted = text;
  let targetIndex = match.index;
  for (const m of [...all].sort((a, b) => b.index - a.index)) {
    redacted = redacted.slice(0, m.index) + '<CANARY>' + redacted.slice(m.index + m.length);
    if (m.index < targetIndex) targetIndex += '<CANARY>'.length - m.length;
  }
  const tagLen = '<CANARY>'.length;
  const start = Math.max(0, targetIndex - SNIPPET_CONTEXT);
  const end = Math.min(redacted.length, targetIndex + tagLen + SNIPPET_CONTEXT);
  const snippet =
    (start > 0 ? '…' : '') + redacted.slice(start, end) + (end < redacted.length ? '…' : '');
  // Normalize control characters so snippets stay single-line in reports.
  return snippet.replace(/[\r\n\t]+/g, ' ');
}
