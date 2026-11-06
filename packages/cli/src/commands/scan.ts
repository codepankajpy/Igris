/**
 * `igris scan <url>` — see README for the full contract.
 * Exit codes: 0 ok · 1 below --fail-under · 2 scan error · 3 invalid args.
 */
import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Report } from '@igris/core';
import { scan, type Recipe, type ScanOptions } from '@igris/scanner';
import { EXIT } from '../exit-codes.js';
import { renderHtmlReport } from '../html-report.js';
import { renderTable } from '../table.js';

export const SCAN_HELP = `igris scan <url> [options]

Options:
  --json                print report.json to stdout and nothing else
  --out <dir>           write report.json + report.html here (default: igris-out)
  --fail-under <n>      exit 1 when the score is below n
  --recipe <file>       JSON click-path for custom connect flows (recipes/)
  --dwell <ms>          settle time per phase (default 8000)
  --chain-id <n>        chain id the mock wallet reports (default 1)
  --live-reads <url>    forward wallet reads to a real RPC (default: local stub,
                        nothing leaves the machine)
  --first-party <csv>   extra domains to treat as first-party
  --spoof-metamask      claim isMetaMask=true (default on; --no-spoof-metamask
                        to disable; see docs/METHODOLOGY.md for the trade-off)
  --explain             print the full penalty ledger
  --host-resolver-rules <rules>   Chromium host resolver rules (offline fixtures)
`;

export interface ScanCliResult {
  exitCode: number;
  report?: Report;
}

export async function runScan(argv: string[]): Promise<ScanCliResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        out: { type: 'string' },
        'fail-under': { type: 'string' },
        recipe: { type: 'string' },
        dwell: { type: 'string' },
        'chain-id': { type: 'string' },
        'live-reads': { type: 'string' },
        'first-party': { type: 'string' },
        'spoof-metamask': { type: 'boolean', default: true },
        'no-spoof-metamask': { type: 'boolean', default: false },
        explain: { type: 'boolean', default: false },
        'host-resolver-rules': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`invalid arguments: ${String(err)}\n${SCAN_HELP}`);
    return { exitCode: EXIT.INVALID_ARGS };
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(SCAN_HELP);
    return { exitCode: EXIT.OK };
  }
  const url = positionals[0];
  if (!url || !/^https?:\/\//.test(url)) {
    process.stderr.write(`igris scan: need an http(s) URL\n${SCAN_HELP}`);
    return { exitCode: EXIT.INVALID_ARGS };
  }
  const failUnder = values['fail-under'] !== undefined ? Number(values['fail-under']) : undefined;
  const dwellMs = values.dwell !== undefined ? Number(values.dwell) : undefined;
  const chainId = values['chain-id'] !== undefined ? Number(values['chain-id']) : undefined;
  for (const [flag, n] of [
    ['--fail-under', failUnder],
    ['--dwell', dwellMs],
    ['--chain-id', chainId],
  ] as const) {
    if (n !== undefined && !Number.isFinite(n)) {
      process.stderr.write(`igris scan: ${flag} needs a number\n`);
      return { exitCode: EXIT.INVALID_ARGS };
    }
  }

  let recipe: Recipe | undefined;
  if (values.recipe) {
    try {
      recipe = JSON.parse(readFileSync(values.recipe, 'utf8')) as Recipe;
    } catch (err) {
      process.stderr.write(`igris scan: cannot read recipe ${values.recipe}: ${String(err)}\n`);
      return { exitCode: EXIT.INVALID_ARGS };
    }
  }

  const options: ScanOptions = {
    url,
    ...(chainId !== undefined ? { chainId } : {}),
    ...(dwellMs !== undefined ? { dwellMs } : {}),
    spoofMetaMask: values['no-spoof-metamask'] ? false : values['spoof-metamask'],
    ...(values['live-reads'] ? { liveReadsUrl: values['live-reads'] } : {}),
    ...(values['first-party'] ? { firstParty: values['first-party'].split(',') } : {}),
    ...(recipe ? { recipe } : {}),
    ...(values['host-resolver-rules']
      ? { hostResolverRules: values['host-resolver-rules'] }
      : {}),
  };

  let report: Report;
  try {
    report = await scan(options);
  } catch (err) {
    process.stderr.write(`igris scan: scan failed: ${String(err)}\n`);
    return { exitCode: EXIT.SCAN_ERROR };
  }

  const json = JSON.stringify(report, null, 2);

  if (values.json) {
    process.stdout.write(json + '\n');
  } else {
    const outDir = values.out ?? 'igris-out';
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'report.json'), json);
    writeFileSync(join(outDir, 'report.html'), renderHtmlReport(report));
    printSummary(report, values.explain);
    process.stdout.write(`\nreport.json and report.html written to ${outDir}/\n`);
  }

  if (report.status === 'page-load-failed') return { exitCode: EXIT.SCAN_ERROR, report };
  if (failUnder !== undefined && report.score < failUnder)
    return { exitCode: EXIT.BELOW_THRESHOLD, report };
  return { exitCode: EXIT.OK, report };
}

function printSummary(report: Report, explain: boolean): void {
  const w = process.stdout.write.bind(process.stdout);
  w(`\nIgris scan: ${report.hostname}  —  status: ${report.status}\n`);
  w(`score: ${report.score}/100   usesAnonRpc: ${report.usesAnonRpc}   canary: ${report.canaryAddress}\n\n`);

  const counted = report.findings.filter((f) => f.countsTowardScore);
  const informational = report.findings.filter((f) => !f.countsTowardScore);
  if (report.findings.length === 0) {
    w('no canary leaks found.\n');
  } else {
    w(
      renderTable(
        ['id', 'class', 'destination', 'where', 'encoding', 'phase', 'counted'],
        report.findings.map((f) => [
          f.id,
          f.class,
          f.host,
          f.location,
          f.encoding,
          f.phase,
          f.countsTowardScore ? 'yes' : 'no',
        ]),
      ) + '\n',
    );
    w(`\n${counted.length} counted finding(s), ${informational.length} informational.\n`);
  }

  w(`\nthird parties contacted (IP exposure): ${report.thirdParties.length}\n`);
  if (report.thirdParties.length) {
    w(
      renderTable(
        ['host', 'class', 'phases', 'requests'],
        report.thirdParties.map((t) => [
          t.host,
          t.class,
          t.phases.join('+'),
          String(t.requestCount),
        ]),
      ) + '\n',
    );
  }

  if (explain) {
    w('\npenalty ledger (score = 100 − Σ points, floor 0):\n');
    w(
      renderTable(
        ['#', 'rule', 'points', 'findings', 'why'],
        report.ledger.map((l) => [l.id, l.rule, `−${l.points}`, l.findingIds.join(',') || '—', l.label]),
      ) + '\n',
    );
  }
}
