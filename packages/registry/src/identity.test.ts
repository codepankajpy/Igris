/** P05-6: scanner identity — one key per scanner, bound to its node. */
import { describe, expect, it } from 'vitest';
import { chmodSync, cpSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  IdentityError,
  ensureNode,
  importScanner,
  initScanner,
  listScanners,
  loadScanner,
} from './identity.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'igris-home-'));

describe('scanner identity', () => {
  it('init creates a node id, a key (0600) and a profile; load returns the same address', () => {
    const home = fresh();
    const profile = initScanner({ name: 'primary', home });
    const node = ensureNode(home);
    expect(profile).toMatchObject({
      schema: 'igris.scanner.v1',
      name: 'primary',
      nodeId: node.nodeId,
      origin: 'generated',
    });
    const keyPath = join(home, 'scanners', profile.address, 'key');
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    const loaded = loadScanner({ home });
    expect(loaded.address).toBe(profile.address);
    expect(privateKeyToAccount(loaded.privateKey).address).toBe(profile.address);
  });

  it('every init generates a different key', () => {
    const home = fresh();
    const a = initScanner({ name: 'a', home });
    const b = initScanner({ name: 'b', home });
    expect(a.address).not.toBe(b.address);
    expect(listScanners(home).map((p) => p.name)).toEqual(['a', 'b']);
  });

  it('refuses a key file already claimed by another profile', () => {
    const home = fresh();
    const p = initScanner({ name: 'primary', home });
    const keyFile = join(home, 'scanners', p.address, 'key');
    expect(() => importScanner({ name: 'copy', keyFile, home })).toThrow(
      /already claimed by scanner profile "primary"/,
    );
  });

  it('imports a new key once, then refuses it a second time', () => {
    const home = fresh();
    const keyFile = join(fresh(), 'k');
    writeFileSync(keyFile, generatePrivateKey() + '\n');
    const p = importScanner({ name: 'imported', keyFile, home });
    expect(p.origin).toBe('imported');
    expect(() => importScanner({ name: 'again', keyFile, home })).toThrow(IdentityError);
  });

  it('refuses a profile copied from another node (the second Mac must init its own key)', () => {
    const primaryHome = fresh();
    initScanner({ name: 'primary', home: primaryHome });
    const secondHome = fresh();
    ensureNode(secondHome); // the second machine's own node id
    cpSync(join(primaryHome, 'scanners'), join(secondHome, 'scanners'), { recursive: true });
    expect(() => loadScanner({ home: secondHome })).toThrow(/belongs to another scanner node/);
  });

  it('refuses a group/world-readable key', () => {
    const home = fresh();
    const p = initScanner({ name: 'primary', home });
    chmodSync(join(home, 'scanners', p.address, 'key'), 0o644);
    expect(() => loadScanner({ home })).toThrow(/chmod 600/);
  });

  it('refuses a key that does not match its profile', () => {
    const home = fresh();
    const p = initScanner({ name: 'primary', home });
    const keyPath = join(home, 'scanners', p.address, 'key');
    chmodSync(keyPath, 0o600);
    writeFileSync(keyPath, generatePrivateKey());
    expect(() => loadScanner({ home })).toThrow(/does not match profile/);
  });

  it('selection: by name or address; ambiguity and absence are errors', () => {
    const home = fresh();
    expect(() => loadScanner({ home })).toThrow(/igris scanner init/);
    const a = initScanner({ name: 'a', home });
    initScanner({ name: 'b', home });
    expect(() => loadScanner({ home })).toThrow(/several scanners/);
    expect(loadScanner({ home, selector: 'a' }).address).toBe(a.address);
    expect(loadScanner({ home, selector: a.address.toLowerCase() }).address).toBe(a.address);
    expect(() => loadScanner({ home, selector: 'zzz' })).toThrow(/no scanner "zzz"/);
  });

  it('validates names and key file format; never overwrites an existing key', () => {
    const home = fresh();
    expect(() => initScanner({ name: 'Bad Name', home })).toThrow(/scanner name/);
    const keyFile = join(fresh(), 'k');
    writeFileSync(keyFile, 'not a key');
    expect(() => importScanner({ name: 'x', keyFile, home })).toThrow(/32-byte hex/);
    initScanner({ name: 'dup', home });
    expect(() => initScanner({ name: 'dup', home })).toThrow(/already exists/);
  });

  it('the key never appears in the profile', () => {
    const home = fresh();
    const p = initScanner({ name: 'primary', home });
    const key = readFileSync(join(home, 'scanners', p.address, 'key'), 'utf8').trim();
    expect(readFileSync(join(home, 'scanners', p.address, 'profile.json'), 'utf8')).not.toContain(
      key.slice(2),
    );
  });
});
