import { describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fix } from './index.js';
import { unifiedDiff } from './diff.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
const FIXTURE = join(REPO_ROOT, 'fixtures/leaky-dapp');

/** Copy the fixture's sources (not node_modules/dist) into a temp dir. */
function freshCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'igris-fix-'));
  for (const f of ['package.json', 'tsconfig.json', 'vite.config.ts', 'index.html']) {
    cpSync(join(FIXTURE, f), join(dir, f));
  }
  cpSync(join(FIXTURE, 'src'), join(dir, 'src'), { recursive: true });
  return dir;
}

describe('unifiedDiff', () => {
  it('is empty for identical inputs', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'x.ts')).toBe('');
  });
  it('produces hunks git can apply', () => {
    const dir = mkdtempSync(join(tmpdir(), 'igris-diff-'));
    const before = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n';
    const after = 'line1\nline2\nCHANGED\nline4\nline5\nline6\nline7\nADDED\nline8\n';
    writeFileSync(join(dir, 'x.txt'), before);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const diff = unifiedDiff(before, after, 'x.txt');
    writeFileSync(join(dir, 'change.patch'), diff);
    execFileSync('git', ['apply', 'change.patch'], { cwd: dir });
    expect(readFileSync(join(dir, 'x.txt'), 'utf8')).toBe(after);
  });
});

describe('igris fix on the leaky fixture', () => {
  it('dry run patches all three framework variants (snapshot)', () => {
    const dir = freshCopy();
    const result = fix({ targetDir: dir });
    expect(result.wrote).toBe(false);
    // viem + wagmi: http() gains fetchFn
    expect(result.diff).toContain('fetchFn: igrisAnonFetch');
    expect(result.diff).toContain('src/rpc/viem.ts');
    expect(result.diff).toContain('src/rpc/wagmi.ts');
    // ethers: constructor swapped
    expect(result.diff).toContain('anonJsonRpcProvider');
    expect(result.diff).toContain('src/rpc/ethers.ts');
    // shim created, dependency added
    expect(result.diff).toContain('igris-anon-rpc.ts');
    expect(result.diff).toContain('@anon-rpc/browser-harness');
    // normalize the temp path out of nothing — diff paths are relative already
    expect(result.diff).toMatchSnapshot();
  });

  it('the diff applies cleanly with git apply', () => {
    const dir = freshCopy();
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const { diff } = fix({ targetDir: dir });
    writeFileSync(join(dir, 'igris.patch'), diff);
    execFileSync('git', ['apply', 'igris.patch'], { cwd: dir });
    expect(readFileSync(join(dir, 'src/rpc/viem.ts'), 'utf8')).toContain('fetchFn: igrisAnonFetch');
    expect(readFileSync(join(dir, 'src/igris-anon-rpc.ts'), 'utf8')).toContain('AnonRpcWorker');
  });

  it('--write applied twice yields an empty diff (idempotent)', () => {
    const dir = freshCopy();
    const first = fix({ targetDir: dir, write: true });
    expect(first.wrote).toBe(true);
    expect(readFileSync(join(dir, 'src/rpc/viem.ts'), 'utf8')).toContain('fetchFn: igrisAnonFetch');
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('@anon-rpc/browser-harness');

    const second = fix({ targetDir: dir, write: true });
    expect(second.diff).toBe('');
    expect(second.wrote).toBe(false);
    expect(second.changedFiles).toEqual([]);
  });

  it('keeps the RPC URL (and env sourcing) intact', () => {
    const dir = freshCopy();
    const { diff } = fix({ targetDir: dir });
    // The patch must not touch the URL expression itself.
    expect(diff).not.toContain('-const RPC_URL');
    const applied = fix({ targetDir: dir, write: true });
    expect(applied.wrote).toBe(true);
    const viem = readFileSync(join(dir, 'src/rpc/viem.ts'), 'utf8');
    expect(viem).toContain("import.meta.env.VITE_RPC_URL ?? 'http://rpc.igris-rpc.test:38545'");
    expect(viem).toContain('http(RPC_URL, { fetchFn: igrisAnonFetch })');
  });
});

describe('manual notes for unpatchable patterns', () => {
  it('spread args, aliased imports, BrowserProvider', () => {
    const dir = mkdtempSync(join(tmpdir(), 'igris-fix-manual-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: {} }, null, 2),
    );
    writeFileSync(
      join(dir, 'src/odd.ts'),
      [
        "import { http as viemHttp } from 'viem';",
        "import { BrowserProvider } from 'ethers';",
        'const args = [] as unknown as [string];',
        'export const t = viemHttp(...args);',
        'export const aliased = viemHttp("https://rpc.example");',
        'export const bp = new BrowserProvider((globalThis as never)); ',
      ].join('\n'),
    );
    const result = fix({ targetDir: dir });
    // Aliased import still patched.
    expect(result.diff).toContain('viemHttp("https://rpc.example", { fetchFn: igrisAnonFetch })');
    // Spread call → manual note with file and line.
    const spreadNote = result.notes.find((n) => n.message.includes('spread'));
    expect(spreadNote).toBeDefined();
    expect(spreadNote!.file).toBe('src/odd.ts');
    expect(spreadNote!.line).toBe(4);
    // BrowserProvider informational note.
    expect(result.notes.some((n) => n.message.includes('BrowserProvider'))).toBe(true);
  });

  it('does nothing on a repo with no known patterns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'igris-fix-none-'));
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;');
    const result = fix({ targetDir: dir });
    expect(result.diff).toBe('');
    expect(result.notes).toEqual([]);
  });
});
