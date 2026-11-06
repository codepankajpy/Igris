/**
 * Loader + hand-rolled schema validation for data/third-parties.json.
 *
 * We validate by hand instead of pulling in a JSON Schema engine: the file's
 * shape is small and fixed, and "prefer the stdlib over a package" is a
 * project rule. The JSON Schema document is still exported for documentation
 * and external tooling.
 */
import { readFileSync } from 'node:fs';
import { RECIPIENT_CLASSES, type RecipientClass } from './report.js';

export interface ThirdPartyEntry {
  /** Display name, e.g. "Infura". */
  name: string;
  class: RecipientClass;
  /** Registrable domains (eTLD+1) or exact hostnames. */
  domains: string[];
  /** Hostname suffixes for providers with many subdomains, e.g. "ingest.sentry.io". */
  suffixes?: string[];
  /** Where this entry came from: a URL, or "observed in fixture". */
  source: string;
}

export interface ThirdPartyDb {
  version: number;
  entries: ThirdPartyEntry[];
}

export const THIRD_PARTIES_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://igris.dev/schemas/third-parties-1.json',
  type: 'object',
  required: ['version', 'entries'],
  properties: {
    version: { type: 'integer' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'class', 'domains', 'source'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1 },
          class: { enum: [...RECIPIENT_CLASSES] },
          domains: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
          suffixes: { type: 'array', items: { type: 'string', minLength: 1 } },
          source: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} as const;

export class ThirdPartyDbError extends Error {}

function fail(path: string, msg: string): never {
  throw new ThirdPartyDbError(`third-parties.json: ${path}: ${msg}`);
}

/** Validate an arbitrary parsed JSON value against the schema above. */
export function validateThirdPartyDb(data: unknown): ThirdPartyDb {
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    fail('$', 'must be an object');
  const obj = data as Record<string, unknown>;
  if (!Number.isInteger(obj.version)) fail('version', 'must be an integer');
  if (!Array.isArray(obj.entries)) fail('entries', 'must be an array');
  const classes = new Set<string>(RECIPIENT_CLASSES);
  obj.entries.forEach((e, i) => {
    const p = `entries[${i}]`;
    if (typeof e !== 'object' || e === null) fail(p, 'must be an object');
    const entry = e as Record<string, unknown>;
    if (typeof entry.name !== 'string' || !entry.name)
      fail(`${p}.name`, 'must be a non-empty string');
    if (typeof entry.class !== 'string' || !classes.has(entry.class))
      fail(`${p}.class`, `must be one of ${[...classes].join(', ')}`);
    if (!Array.isArray(entry.domains) || entry.domains.length === 0)
      fail(`${p}.domains`, 'must be a non-empty array');
    for (const d of entry.domains)
      if (typeof d !== 'string' || !d) fail(`${p}.domains`, 'items must be non-empty strings');
    if (entry.suffixes !== undefined) {
      if (!Array.isArray(entry.suffixes)) fail(`${p}.suffixes`, 'must be an array');
      for (const s of entry.suffixes)
        if (typeof s !== 'string' || !s) fail(`${p}.suffixes`, 'items must be non-empty strings');
    }
    if (typeof entry.source !== 'string' || !entry.source)
      fail(`${p}.source`, 'must be a non-empty string');
    const known = new Set(['name', 'class', 'domains', 'suffixes', 'source']);
    for (const k of Object.keys(entry)) if (!known.has(k)) fail(`${p}.${k}`, 'unknown property');
  });
  return data as ThirdPartyDb;
}

/** Path of the canonical database, relative to this source file. */
export const DEFAULT_THIRD_PARTIES_URL = new URL(
  '../../../data/third-parties.json',
  import.meta.url,
);

export function loadThirdPartyDb(path?: string | URL): ThirdPartyDb {
  const target = path ?? DEFAULT_THIRD_PARTIES_URL;
  const raw = readFileSync(target, 'utf8');
  return validateThirdPartyDb(JSON.parse(raw));
}
