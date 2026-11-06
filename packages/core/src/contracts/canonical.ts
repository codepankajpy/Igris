/**
 * Canonical JSON (RFC 8785, "JSON Canonicalization Scheme").
 *
 * Every hash IGRIS publishes is a sha256 over canonical bytes, so two parties
 * holding the same logical document always compute the same hash, whatever
 * key order or whitespace their serializer produced.
 *
 * Rules implemented (RFC 8785 §3.2):
 *  - object members sorted by key, comparing UTF-16 code units;
 *  - no insignificant whitespace;
 *  - strings serialized as ECMAScript JSON.stringify does (which is what
 *    RFC 8785 specifies), and lone surrogates are REJECTED (RFC 8785 requires
 *    valid Unicode);
 *  - numbers serialized with ECMAScript Number→String (JSON.stringify), and
 *    non-finite numbers rejected; -0 serializes as 0.
 *
 * Stricter than JSON.stringify, by design: `undefined`, functions, symbols,
 * bigint, and non-plain objects (Date, Map, class instances) are errors, not
 * silently dropped or coerced. A document is canonicalizable only if it is
 * exactly a JSON value.
 *
 * Browser-safe: no Node imports.
 */

export class CanonicalizationError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = 'CanonicalizationError';
  }
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** UTF-16 code-unit comparison (what RFC 8785 mandates; NOT localeCompare). */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serialize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalizationError('non-finite number', path);
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'string':
      if (hasLoneSurrogate(value))
        throw new CanonicalizationError('lone surrogate in string', path);
      return JSON.stringify(value);
    case 'object': {
      if (seen.has(value)) throw new CanonicalizationError('cycle', path);
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((v, i) => serialize(v, `${path}[${i}]`, seen)).join(',')}]`;
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
          throw new CanonicalizationError('non-plain object', path);
        }
        const keys = Object.keys(value).sort(compareKeys);
        const parts: string[] = [];
        for (const k of keys) {
          if (hasLoneSurrogate(k)) throw new CanonicalizationError('lone surrogate in key', path);
          const v = (value as Record<string, unknown>)[k];
          parts.push(`${JSON.stringify(k)}:${serialize(v, `${path}.${k}`, seen)}`);
        }
        return `{${parts.join(',')}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new CanonicalizationError(`unsupported type ${typeof value}`, path);
  }
}

/** RFC 8785 canonical JSON text of a JSON value. Throws CanonicalizationError. */
export function canonicalize(value: unknown): string {
  return serialize(value, '$', new Set());
}

/** Canonical JSON as UTF-8 bytes (what gets hashed and published). */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
