/**
 * Scanner identity (P05-6). Node-only.
 *
 * A *scanner node* is one machine running IGRIS. A *scanner* is a signing key
 * plus a public profile (`igris.scanner.v1`). Rules:
 *
 *  - one key per scanner, generated locally (`igris scanner init`) or
 *    imported once (`igris scanner import`); never hardcoded, never in env;
 *  - every profile is BOUND to the node that created it (`nodeId`). Loading a
 *    profile on a different node is refused — copying ~/.igris to a second
 *    machine does not make it a second, independent scanner;
 *  - a key that another profile on this node already claims cannot be
 *    imported again under a new name;
 *  - key files must not be readable by group/others (like ssh keys).
 *
 * Limitation (stated, not hidden): two machines that each import the SAME key
 * by hand cannot be detected locally. On Arkiv they would be one owner
 * address, i.e. one scanner — which is the honest reading.
 *
 * Layout under $IGRIS_HOME (default ~/.igris), dirs 0700, files 0600:
 *   node.json                       igris.node.v1
 *   scanners/<address>/profile.json igris.scanner.v1
 *   scanners/<address>/key          0x-prefixed hex private key
 */
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

export const NODE_SCHEMA = 'igris.node.v1' as const;
export const SCANNER_PROFILE_SCHEMA = 'igris.scanner.v1' as const;

export interface NodeIdentity {
  schema: typeof NODE_SCHEMA;
  nodeId: string;
  createdAt: string;
}

export interface ScannerProfile {
  schema: typeof SCANNER_PROFILE_SCHEMA;
  /** Checksummed address of the signing key (= Arkiv entity owner). */
  address: string;
  /** Human label, unique on this node. */
  name: string;
  /** The node this scanner belongs to. */
  nodeId: string;
  createdAt: string;
  /** How the key came to exist: generated here, or imported from a file. */
  origin: 'generated' | 'imported';
}

export interface LoadedScanner {
  profile: ScannerProfile;
  privateKey: Hex;
  address: string;
}

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function igrisHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.IGRIS_HOME && env.IGRIS_HOME.length > 0 ? env.IGRIS_HOME : join(homedir(), '.igris');
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}

function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600, flag: 'wx' }); // never overwrite
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new IdentityError(`cannot read ${path}: ${(err as Error).message}`);
  }
}

function parseNode(v: unknown, path: string): NodeIdentity {
  const o = v as Partial<NodeIdentity>;
  if (o?.schema !== NODE_SCHEMA || typeof o.nodeId !== 'string' || !UUID_RE.test(o.nodeId)) {
    throw new IdentityError(`${path} is not a valid ${NODE_SCHEMA} file`);
  }
  return { schema: NODE_SCHEMA, nodeId: o.nodeId, createdAt: String(o.createdAt ?? '') };
}

function parseProfile(v: unknown, path: string): ScannerProfile {
  const o = v as Partial<ScannerProfile>;
  if (
    o?.schema !== SCANNER_PROFILE_SCHEMA ||
    typeof o.address !== 'string' ||
    !ADDRESS_RE.test(o.address) ||
    typeof o.name !== 'string' ||
    !NAME_RE.test(o.name) ||
    typeof o.nodeId !== 'string' ||
    !UUID_RE.test(o.nodeId) ||
    (o.origin !== 'generated' && o.origin !== 'imported')
  ) {
    throw new IdentityError(`${path} is not a valid ${SCANNER_PROFILE_SCHEMA} profile`);
  }
  return {
    schema: SCANNER_PROFILE_SCHEMA,
    address: o.address,
    name: o.name,
    nodeId: o.nodeId,
    createdAt: String(o.createdAt ?? ''),
    origin: o.origin,
  };
}

/** This machine's node identity (created on first use). */
export function ensureNode(
  home: string = igrisHome(),
  now: () => Date = () => new Date(),
): NodeIdentity {
  ensureDir(home);
  const path = join(home, 'node.json');
  if (existsSync(path)) return parseNode(readJson(path), path);
  const node: NodeIdentity = {
    schema: NODE_SCHEMA,
    nodeId: randomUUID(),
    createdAt: now().toISOString(),
  };
  writePrivate(path, JSON.stringify(node, null, 2) + '\n');
  return node;
}

/** All scanner profiles stored under this home (validated; bound or not). */
export function listScanners(home: string = igrisHome()): ScannerProfile[] {
  const dir = join(home, 'scanners');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, 'profile.json')))
    .map((d) => parseProfile(readJson(join(dir, d, 'profile.json')), join(dir, d, 'profile.json')))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function store(
  home: string,
  name: string,
  privateKey: Hex,
  origin: ScannerProfile['origin'],
  now: () => Date,
): ScannerProfile {
  if (!NAME_RE.test(name)) {
    throw new IdentityError('scanner name must be 1–32 chars: lowercase letters, digits, hyphens');
  }
  const node = ensureNode(home, now);
  const address = privateKeyToAccount(privateKey).address;
  const existing = listScanners(home);
  const claimed = existing.find((p) => p.address.toLowerCase() === address.toLowerCase());
  if (claimed) {
    throw new IdentityError(
      `this key is already claimed by scanner profile "${claimed.name}" (${claimed.address}); one key, one scanner`,
    );
  }
  if (existing.some((p) => p.name === name)) {
    throw new IdentityError(`a scanner named "${name}" already exists on this node`);
  }
  const dir = join(home, 'scanners', address);
  ensureDir(join(home, 'scanners'));
  ensureDir(dir);
  const profile: ScannerProfile = {
    schema: SCANNER_PROFILE_SCHEMA,
    address,
    name,
    nodeId: node.nodeId,
    createdAt: now().toISOString(),
    origin,
  };
  writePrivate(join(dir, 'key'), privateKey + '\n');
  writePrivate(join(dir, 'profile.json'), JSON.stringify(profile, null, 2) + '\n');
  return profile;
}

/** Generate a brand-new scanner key and profile on this node. */
export function initScanner(opts: {
  name: string;
  home?: string;
  now?: () => Date;
}): ScannerProfile {
  return store(
    opts.home ?? igrisHome(),
    opts.name,
    generatePrivateKey(),
    'generated',
    opts.now ?? (() => new Date()),
  );
}

/** Import an existing key from a file (refused if any profile already claims it). */
export function importScanner(opts: {
  name: string;
  keyFile: string;
  home?: string;
  now?: () => Date;
}): ScannerProfile {
  let raw: string;
  try {
    raw = readFileSync(opts.keyFile, 'utf8').trim();
  } catch (err) {
    throw new IdentityError(`cannot read key file: ${(err as Error).message}`);
  }
  if (!KEY_RE.test(raw))
    throw new IdentityError('key file must contain one 0x-prefixed 32-byte hex key');
  return store(
    opts.home ?? igrisHome(),
    opts.name,
    raw as Hex,
    'imported',
    opts.now ?? (() => new Date()),
  );
}

/**
 * Load a scanner for signing. `selector` is a name or address; without it,
 * the node's only scanner is used. Refuses profiles bound to another node,
 * group/world-readable keys, and keys that do not match their profile.
 */
export function loadScanner(opts: { selector?: string; home?: string } = {}): LoadedScanner {
  const home = opts.home ?? igrisHome();
  const profiles = listScanners(home);
  if (profiles.length === 0) {
    throw new IdentityError('no scanner on this node: run `igris scanner init --name <name>`');
  }
  let profile: ScannerProfile | undefined;
  if (opts.selector) {
    const s = opts.selector.toLowerCase();
    profile = profiles.find((p) => p.name === s || p.address.toLowerCase() === s);
    if (!profile) throw new IdentityError(`no scanner "${opts.selector}" on this node`);
  } else if (profiles.length === 1) {
    profile = profiles[0]!;
  } else {
    throw new IdentityError(
      `several scanners on this node (${profiles.map((p) => p.name).join(', ')}): pass --scanner <name>`,
    );
  }
  const node = ensureNode(home);
  if (profile.nodeId !== node.nodeId) {
    throw new IdentityError(
      `scanner "${profile.name}" belongs to another scanner node (${profile.nodeId}); ` +
        'an independent scanner needs its own key: run `igris scanner init` on this machine',
    );
  }
  const keyPath = join(home, 'scanners', profile.address, 'key');
  if (process.platform !== 'win32') {
    const mode = statSync(keyPath).mode & 0o777;
    if (mode & 0o077) {
      throw new IdentityError(
        `key file ${keyPath} is accessible by group/others (mode ${mode.toString(8)}); run: chmod 600 ${keyPath}`,
      );
    }
  }
  const key = readFileSync(keyPath, 'utf8').trim();
  if (!KEY_RE.test(key)) throw new IdentityError(`key file ${keyPath} is malformed`);
  const address = privateKeyToAccount(key as Hex).address;
  if (address !== profile.address) {
    throw new IdentityError(
      `key file does not match profile "${profile.name}" (${profile.address})`,
    );
  }
  return { profile, privateKey: key as Hex, address };
}
