/**
 * Batch scan: one URL per line in a targets file (# comments allowed),
 * sequential (be polite), one report dir per host plus a dataset summary.
 *
 * Usage: pnpm exec tsx scripts/batch-scan.ts targets.txt [outDir] [-- extra scan flags]
 * Verify offline: pnpm exec tsx scripts/batch-scan.ts fixtures/targets-fixture.txt /tmp/igris-batch \
 *                   -- --host-resolver-rules "MAP *.test 127.0.0.1" --dwell 1500
 * (with the sink + fixture servers running; `pnpm demo` does this for you.)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scan } from '@igris/scanner';
import type { Report } from '@igris/core';

const [targetsFile, outDir = 'igris-batch'] = process.argv.slice(2);
const extraIdx = process.argv.indexOf('--');
const extra = extraIdx === -1 ? [] : process.argv.slice(extraIdx + 1);

function extraFlag(name: string): string | undefined {
  const i = extra.indexOf(name);
  return i === -1 ? undefined : extra[i + 1];
}

if (!targetsFile) {
  console.error('usage: batch-scan.ts <targets.txt> [outDir] [-- --dwell 1500 …]');
  process.exit(3);
}

const targets = readFileSync(targetsFile, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

mkdirSync(outDir, { recursive: true });
const summaries: Array<{
  url: string;
  hostname: string;
  status: string;
  score: number;
  leakCount: number;
  leakClasses: string[];
  thirdParties: number;
  usesAnonRpc: boolean;
}> = [];

for (const url of targets) {
  process.stderr.write(`scanning ${url} …\n`);
  const dwell = extraFlag('--dwell');
  const rules = extraFlag('--host-resolver-rules');
  let report: Report;
  try {
    report = await scan({
      url,
      ...(dwell ? { dwellMs: Number(dwell) } : {}),
      ...(rules ? { hostResolverRules: rules } : {}),
    });
  } catch (err) {
    process.stderr.write(`  FAILED: ${String(err)}\n`);
    continue;
  }
  // Hostname + port keeps two deployments of one host apart.
  const slug = `${report.hostname}${new URL(url).port ? '-' + new URL(url).port : ''}`;
  const dir = join(outDir, slug.replaceAll(/[^a-z0-9.-]/gi, '_'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  summaries.push({
    url,
    hostname: report.hostname,
    status: report.status,
    score: report.score,
    leakCount: report.findings.filter((f) => f.countsTowardScore).length,
    leakClasses: [
      ...new Set(report.findings.filter((f) => f.countsTowardScore).map((f) => f.class)),
    ].sort(),
    thirdParties: report.thirdParties.length,
    usesAnonRpc: report.usesAnonRpc,
  });
}

writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ summaries }, null, 2));
const md = [
  '| dapp | status | score | leaks | classes | third parties | anon-rpc |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...summaries.map(
    (s) =>
      `| ${s.hostname} | ${s.status} | ${s.score} | ${s.leakCount} | ${s.leakClasses.join(', ') || '—'} | ${s.thirdParties} | ${s.usesAnonRpc ? 'yes' : 'no'} |`,
  ),
].join('\n');
writeFileSync(join(outDir, 'summary.md'), md + '\n');
process.stdout.write(md + '\n');
