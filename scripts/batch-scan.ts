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
import { countedLeaks, type ScanResult } from '@igris/core';
import { writeScanArtifacts } from '@igris/cli';

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
  score: number | null;
  leakCount: number;
  leakClasses: string[];
  thirdParties: number;
  usesAnonRpc: boolean;
}> = [];

for (const url of targets) {
  process.stderr.write(`scanning ${url} …\n`);
  const dwell = extraFlag('--dwell');
  const rules = extraFlag('--host-resolver-rules');
  let result: ScanResult;
  try {
    result = await scan({
      url,
      ...(dwell ? { dwellMs: Number(dwell) } : {}),
      ...(rules ? { hostResolverRules: rules } : {}),
    });
  } catch (err) {
    process.stderr.write(`  FAILED: ${String(err)}\n`);
    continue;
  }
  // Hostname + port keeps two deployments of one host apart.
  const report = result.report;
  const slug = `${report.scan.hostname}${new URL(url).port ? '-' + new URL(url).port : ''}`;
  const dir = join(outDir, slug.replaceAll(/[^a-z0-9.-]/gi, '_'));
  mkdirSync(dir, { recursive: true });
  writeScanArtifacts(dir, result);
  summaries.push({
    url,
    hostname: report.scan.hostname,
    status: report.scan.status,
    score: report.privacy.score,
    leakCount: countedLeaks(result).length,
    leakClasses: [...new Set(countedLeaks(result).map((l) => l.evidence.recipientClass))].sort(),
    thirdParties: report.contacts.length,
    usesAnonRpc: report.wallet.usesAnonRpc,
  });
}

writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ summaries }, null, 2));
const md = [
  '| dapp | status | score | leaks | classes | third parties | anon-rpc |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...summaries.map(
    (s) =>
      `| ${s.hostname} | ${s.status} | ${s.score === null ? 'not scored' : s.score} | ${s.leakCount} | ${s.leakClasses.join(', ') || '—'} | ${s.thirdParties} | ${s.usesAnonRpc ? 'yes' : 'no'} |`,
  ),
].join('\n');
writeFileSync(join(outDir, 'summary.md'), md + '\n');
process.stdout.write(md + '\n');
