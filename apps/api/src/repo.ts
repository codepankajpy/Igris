/**
 * Repository intake for /api/scan-repo: strict URL validation, a hardened
 * `git clone`, and size limits enforced BEFORE any parsing.
 *
 * Threats handled:
 *  - option injection: the URL is validated against a strict pattern and
 *    passed after `--`, so it can never be read as a git option;
 *  - other transports (file://, ssh, ext::): only https is allowed, both by
 *    the URL pattern and by git's protocol allowlist;
 *  - symlinks pointing outside the clone (which would let the patcher read
 *    and diff server files): `core.symlinks=false` checks them out as plain
 *    files, and the size walk never follows links;
 *  - hooks, credential helpers, global/system config: disabled;
 *  - resource exhaustion: clone timeout, total size, file count and
 *    per-source-file limits are checked before ts-morph sees anything.
 */
import { execFile } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** https://github.com/<owner>/<repo>[.git] — nothing else. */
const GITHUB_REPO_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

export class RepoRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoRejectedError';
  }
}

/** Returns the canonical clone URL, or throws RepoRejectedError. */
export function validateRepoUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 300) {
    throw new RepoRejectedError('repoUrl must be a string');
  }
  const m = input.match(GITHUB_REPO_RE);
  if (!m) {
    throw new RepoRejectedError('repoUrl must be https://github.com/<owner>/<repo>');
  }
  const [, owner, repo] = m as unknown as [string, string, string];
  if (repo === '.' || repo === '..' || repo.startsWith('.')) {
    throw new RepoRejectedError('invalid repository name');
  }
  return `https://github.com/${owner}/${repo}.git`;
}

/** Argument vector for a hardened shallow clone. */
export function buildCloneArgs(url: string, dest: string): string[] {
  return [
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.https.allow=always',
    '-c',
    'core.symlinks=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'credential.helper=',
    '-c',
    'http.followRedirects=false',
    '-c',
    'submodule.recurse=false',
    'clone',
    '--depth',
    '1',
    '--single-branch',
    '--no-tags',
    '--',
    url,
    dest,
  ];
}

/** Environment for git: no prompts, no user/system config, no LFS smudge. */
export function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_ASKPASS: '/bin/false',
  };
}

export async function cloneRepo(
  url: string,
  dest: string,
  home: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await execFileAsync('git', buildCloneArgs(url, dest), {
    env: gitEnv(home),
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
}

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs']);

export interface RepoLimits {
  maxBytes: number;
  maxFiles: number;
  maxSourceFileBytes: number;
}

/**
 * Walk the checkout (excluding .git) WITHOUT following symlinks and enforce
 * limits. Throws RepoRejectedError on the first violation.
 */
export function enforceRepoLimits(
  root: string,
  limits: RepoLimits,
): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      if (dir === root && name === '.git') continue;
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) continue; // never followed (and core.symlinks=false)
      if (st.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!st.isFile()) continue;
      files += 1;
      bytes += st.size;
      if (files > limits.maxFiles)
        throw new RepoRejectedError(`repository has more than ${limits.maxFiles} files`);
      if (bytes > limits.maxBytes)
        throw new RepoRejectedError(`repository exceeds ${limits.maxBytes} bytes`);
      if (
        SOURCE_EXT.has(extname(name)) &&
        !path.includes('/node_modules/') &&
        st.size > limits.maxSourceFileBytes
      ) {
        throw new RepoRejectedError(`source file larger than ${limits.maxSourceFileBytes} bytes`);
      }
    }
  }
  return { bytes, files };
}
