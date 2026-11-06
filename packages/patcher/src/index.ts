/**
 * `igris fix` engine: patch a dapp repo so its RPC reads go through Anon-RPC.
 * Dry-run by default; --write applies; running twice yields an empty diff.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { Project } from 'ts-morph';
import { newFileDiff, unifiedDiff } from './diff.js';
import { buildShim, DEFAULT_SPECIFIER, SHIM_BASENAME } from './shim.js';
import { transformProject, type ManualNote } from './transforms.js';

export { unifiedDiff, newFileDiff } from './diff.js';
export { buildShim, DEFAULT_SPECIFIER, SHIM_BASENAME } from './shim.js';
export type { ManualNote } from './transforms.js';

export const HARNESS_DEP = '@anon-rpc/browser-harness';
export const HARNESS_VERSION = '0.4.0';

export interface FixOptions {
  targetDir: string;
  write?: boolean;
  /** Create and switch to this git branch before writing. */
  branch?: string;
  /** Anon-RPC specifier contract address (default: Nym mainnet). */
  specifier?: string;
}

export interface FixResult {
  /** Combined unified diff of every change (empty = nothing to do). */
  diff: string;
  notes: ManualNote[];
  changedFiles: string[];
  wrote: boolean;
}

export function fix(options: FixOptions): FixResult {
  const root = resolve(options.targetDir);
  if (!existsSync(root)) throw new Error(`igris fix: no such directory: ${root}`);

  const project = new Project({
    // Standalone project: we must not pick up the surrounding workspace.
    compilerOptions: { allowJs: true },
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths([
    join(root, '**/*.{ts,tsx,mts,js,jsx,mjs}'),
    '!' + join(root, '**/node_modules/**'),
    '!' + join(root, '**/dist/**'),
    '!' + join(root, '**/*.d.ts'),
    '!' + join(root, '**/*.test.*'),
    '!' + join(root, '**/vite.config.*'),
  ]);

  const before = new Map<string, string>();
  for (const sf of project.getSourceFiles()) before.set(sf.getFilePath(), sf.getFullText());

  const shimDir = existsSync(join(root, 'src')) ? join(root, 'src') : root;
  const result = transformProject(project, root, shimDir);

  const diffs: string[] = [];
  const changedFiles: string[] = [];

  for (const filePath of [...result.changed].sort()) {
    const sf = project.getSourceFile(filePath)!;
    const rel = relative(root, filePath);
    diffs.push(unifiedDiff(before.get(filePath)!, sf.getFullText(), rel));
    changedFiles.push(rel);
  }

  // The generated shim (created or updated only when something was patched).
  let shimToWrite: { path: string; content: string } | null = null;
  if (result.needsViem || result.needsEthers) {
    const shimPath = join(shimDir, `${SHIM_BASENAME}.ts`);
    const content = buildShim(
      { viem: result.needsViem, ethers: result.needsEthers },
      options.specifier ?? DEFAULT_SPECIFIER,
    );
    const existing = existsSync(shimPath) ? readFileSync(shimPath, 'utf8') : null;
    if (existing === null) {
      diffs.push(newFileDiff(relative(root, shimPath), content));
      shimToWrite = { path: shimPath, content };
      changedFiles.push(relative(root, shimPath));
    } else if (existing !== content) {
      diffs.push(unifiedDiff(existing, content, relative(root, shimPath)));
      shimToWrite = { path: shimPath, content };
      changedFiles.push(relative(root, shimPath));
    }
  }

  // package.json dependency.
  let pkgToWrite: { path: string; content: string } | null = null;
  const pkgPath = join(root, 'package.json');
  if ((result.needsViem || result.needsEthers) && existsSync(pkgPath)) {
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    if (!pkg.dependencies?.[HARNESS_DEP]) {
      pkg.dependencies = Object.fromEntries(
        Object.entries({ ...pkg.dependencies, [HARNESS_DEP]: HARNESS_VERSION }).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      );
      const next = JSON.stringify(pkg, null, 2) + '\n';
      diffs.push(unifiedDiff(raw, next, 'package.json'));
      pkgToWrite = { path: pkgPath, content: next };
      changedFiles.push('package.json');
    }
  }

  const combined = diffs.filter(Boolean).join('');
  const wrote = Boolean(options.write && combined);

  if (wrote) {
    if (options.branch) {
      execFileSync('git', ['checkout', '-b', options.branch], { cwd: root, stdio: 'pipe' });
    }
    project.saveSync();
    if (shimToWrite) writeFileSync(shimToWrite.path, shimToWrite.content);
    if (pkgToWrite) writeFileSync(pkgToWrite.path, pkgToWrite.content);
  }

  return { diff: combined, notes: result.notes, changedFiles, wrote };
}
