/**
 * `pnpm demo` — the whole story from a clean clone, fully offline:
 *
 *   1. scan the deliberately leaky fixture        → examples/leaky/
 *   2. `igris fix` (dry run) on a fresh copy      → examples/diff.patch
 *   3. scan the patched fixture                   → examples/fixed/
 *   4. publish both reports to the LOCAL registry → examples/registry.json
 *   5. query it back with filters                 → printed table
 *   6. snapshot for the viewer/extension          → examples/snapshot.json
 *   7. scan the built registry viewer itself      → examples/viewer-scan/
 *   8. print the before/after table
 *
 * Everything under examples/ is REAL output of this script. Never hand-edit.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const EXAMPLES = join(ROOT, 'examples');
const HOST_RULES = 'MAP *.test 127.0.0.1';
const SINK_PORT = 38545;
const LEAKY_PORT = 38546;
const FIXED_PORT = 38548;
const VIEWER_PORT = 38550;

const t0 = Date.now();
const log = (msg: string) =>
  console.log(`[demo +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

function build(dir: string, name: string): void {
  if (existsSync(join(dir, 'dist/index.html')) && !process.env.IGRIS_FORCE_BUILD) {
    log(`${name}: dist present, skipping build (IGRIS_FORCE_BUILD=1 to rebuild)`);
    return;
  }
  log(`building ${name} …`);
  execFileSync('pnpm', ['exec', 'vite', 'build'], { cwd: dir, stdio: 'pipe', timeout: 180_000 });
}

async function main(): Promise<void> {
  const { scan } = await import('@igris/scanner');
  const { renderHtmlReport } = await import('@igris/cli');
  const { fix } = await import('@igris/patcher');
  const { LocalRegistry, recordFromReport } = await import('@igris/registry');
  const { startSink } = await import(join(ROOT, 'fixtures/third-party-sink/src/server.js'));
  const helpers = await import(join(ROOT, 'packages/scanner/e2e/helpers.ts'));

  // --- infrastructure (offline) ---
  build(join(ROOT, 'fixtures/leaky-dapp'), 'leaky-dapp');
  build(join(ROOT, 'fixtures/leaky-dapp-fixed'), 'leaky-dapp-fixed');
  build(join(ROOT, 'apps/web'), 'registry viewer');

  const { server: sink } = await startSink(SINK_PORT);
  const leakySrv = await helpers.serveDist(join(ROOT, 'fixtures/leaky-dapp/dist'), LEAKY_PORT);
  const fixedSrv = await helpers.serveDist(
    join(ROOT, 'fixtures/leaky-dapp-fixed/dist'),
    FIXED_PORT,
  );
  const viewerSrv = await helpers.serveDist(join(ROOT, 'apps/web/dist'), VIEWER_PORT);
  log('sink + fixture + viewer servers up');

  rmSync(EXAMPLES, { recursive: true, force: true });
  mkdirSync(join(EXAMPLES, 'leaky'), { recursive: true });
  mkdirSync(join(EXAMPLES, 'fixed'), { recursive: true });
  mkdirSync(join(EXAMPLES, 'viewer-scan'), { recursive: true });

  const scanOpts = { hostResolverRules: HOST_RULES, dwellMs: 2000 };

  // --- 1. scan the leaky fixture ---
  log('scanning the LEAKY fixture …');
  const leaky = await scan({ url: `http://leaky-dapp.test:${LEAKY_PORT}/`, ...scanOpts });
  const leakyJson = JSON.stringify(leaky, null, 2);
  writeFileSync(join(EXAMPLES, 'leaky/report.json'), leakyJson);
  writeFileSync(join(EXAMPLES, 'leaky/report.html'), renderHtmlReport(leaky));
  log(`leaky: score ${leaky.score}, ${leaky.findings.length} findings`);

  // --- 2. igris fix (dry run) on a pristine copy ---
  log('running igris fix (dry run) …');
  const tmp = mkdtempSync(join(tmpdir(), 'igris-demo-fix-'));
  for (const f of ['package.json', 'tsconfig.json', 'vite.config.ts', 'index.html']) {
    cpSync(join(ROOT, 'fixtures/leaky-dapp', f), join(tmp, f));
  }
  cpSync(join(ROOT, 'fixtures/leaky-dapp/src'), join(tmp, 'src'), { recursive: true });
  const fixResult = fix({ targetDir: tmp });
  writeFileSync(join(EXAMPLES, 'diff.patch'), fixResult.diff);
  log(`fix would change ${fixResult.changedFiles.length} files (examples/diff.patch)`);

  // --- 3. scan the FIXED fixture ---
  log('scanning the FIXED fixture (committed output of igris fix --write) …');
  const fixed = await scan({ url: `http://leaky-dapp.test:${FIXED_PORT}/`, ...scanOpts });
  const fixedJson = JSON.stringify(fixed, null, 2);
  writeFileSync(join(EXAMPLES, 'fixed/report.json'), fixedJson);
  writeFileSync(join(EXAMPLES, 'fixed/report.html'), renderHtmlReport(fixed));
  log(`fixed: score ${fixed.score}, usesAnonRpc=${fixed.usesAnonRpc}`);

  // --- 4./5. publish to the local registry and query back ---
  const registryPath = join(EXAMPLES, 'registry.json');
  const registry = new LocalRegistry(registryPath);
  await registry.publish(recordFromReport(leaky, leakyJson));
  await registry.publish(recordFromReport(fixed, fixedJson));
  const hits = await registry.query({ minScore: 0, leakClass: 'rpc-provider' });
  log(
    `local registry: published 2 records; query --class rpc-provider → ${hits.length} hit(s): ${hits.map((h) => `${h.hostname} (score ${h.score})`).join(', ')}`,
  );

  // --- 6. snapshot for the offline viewer / extension ---
  const snapshot = { version: 1, records: await registry.snapshot() };
  writeFileSync(join(EXAMPLES, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n');

  // --- 7. we eat our own cooking: scan the built viewer ---
  log('scanning the registry viewer itself …');
  const viewerScan = await scan({
    url: `http://igris-viewer.test:${VIEWER_PORT}/`,
    ...scanOpts,
    dwellMs: 1500,
  });
  writeFileSync(join(EXAMPLES, 'viewer-scan/report.json'), JSON.stringify(viewerScan, null, 2));
  writeFileSync(join(EXAMPLES, 'viewer-scan/report.html'), renderHtmlReport(viewerScan));
  log(
    `viewer self-scan: score ${viewerScan.score} (${viewerScan.thirdParties.length} third parties; connect n/a — it has no wallet flow)`,
  );

  // --- 8. before/after table ---
  const rpcLeaks = (r: typeof leaky) =>
    r.findings.filter((f) => f.class === 'rpc-provider' && f.countsTowardScore).length;
  console.log('\n================ BEFORE / AFTER (igris fix) ================');
  console.log('| dapp              | score | RPC leaks | usesAnonRpc |');
  console.log('|-------------------|-------|-----------|-------------|');
  console.log(
    `| leaky-dapp (before) | ${String(leaky.score).padEnd(5)} | ${String(rpcLeaks(leaky)).padEnd(9)} | ${leaky.usesAnonRpc}       |`,
  );
  console.log(
    `| leaky-dapp (fixed)  | ${String(fixed.score).padEnd(5)} | ${String(rpcLeaks(fixed)).padEnd(9)} | ${fixed.usesAnonRpc}        |`,
  );
  console.log('=============================================================');
  console.log(`\nexamples/ regenerated. Total: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  sink.close();
  leakySrv.close();
  fixedSrv.close();
  viewerSrv.close();

  // Honest exit: the demo FAILS if the story does not hold.
  if (rpcLeaks(leaky) === 0)
    throw new Error('demo invariant broken: leaky fixture shows no RPC leak');
  if (rpcLeaks(fixed) > 0)
    throw new Error('demo invariant broken: fixed fixture still leaks to RPC');
  if (!fixed.usesAnonRpc)
    throw new Error('demo invariant broken: fixed fixture not detected as Anon-RPC');
  if (fixed.score <= leaky.score) throw new Error('demo invariant broken: score did not improve');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
