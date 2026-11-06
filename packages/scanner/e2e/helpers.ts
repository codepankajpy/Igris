/**
 * Offline e2e plumbing: build + serve a fixture dapp, start the sink, and
 * provide the host-resolver rule that makes *.test resolve to 127.0.0.1
 * inside Chromium only. No test here may touch the internet.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SINK_PORT = 38545;
export const PAGE_PORT = 38546;
export const HOST_RULES = 'MAP *.test 127.0.0.1';

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

/** Build a fixture dapp with Vite (skipped when dist is already present and FORCE not set). */
export function buildFixture(fixtureDir: string): void {
  const dist = join(fixtureDir, 'dist', 'index.html');
  if (existsSync(dist) && !process.env.IGRIS_FORCE_BUILD) return;
  execFileSync('pnpm', ['exec', 'vite', 'build'], {
    cwd: fixtureDir,
    stdio: 'pipe',
    timeout: 120_000,
  });
}

/** Serve a built fixture's dist directory on 127.0.0.1:port for any Host. */
export function serveDist(distDir: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const file = join(distDir, path === '/' ? 'index.html' : path);
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolveP) => {
    server.listen(port, '127.0.0.1', () => resolveP(server));
  });
}

export async function startSinkServer(): Promise<{ server: Server; close: () => Promise<void> }> {
  const mod = await import(
    join(REPO_ROOT, 'fixtures/third-party-sink/src/server.js')
  );
  const { server } = await mod.startSink(SINK_PORT);
  return {
    server,
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
}
