/**
 * Content hashing. All IGRIS content hashes are sha256 over RFC 8785
 * canonical JSON bytes, rendered as 64 lowercase hex characters (no prefix).
 * Browser-safe (viem's sha256 is pure JS).
 */
import { sha256 } from 'viem';
import { canonicalBytes } from './canonical.js';

export const HASH_ALGORITHM = 'sha256' as const;
export const CANONICALIZATION = 'RFC8785' as const;

/** sha256 of raw bytes → 64 lowercase hex chars. */
export function sha256Hex(bytes: Uint8Array): string {
  return sha256(bytes).slice(2);
}

/** sha256 over the canonical JSON of `value`. */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalBytes(value));
}
