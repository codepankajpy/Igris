#!/usr/bin/env node
/**
 * The `igris` CLI. Subcommands: scan, fix, verify, publish, query, snapshot, scanner.
 * Exit codes: 0 ok · 1 score below threshold · 2 scan error · 3 invalid args.
 */
import { EXIT } from './exit-codes.js';

const HELP = `igris — Lighthouse for dapp privacy: scan, explain, fix, publish.

Usage:
  igris scan <url> [options]        scan a dapp with a canary wallet
  igris fix <path> [options]        patch a dapp repo to use Anon-RPC
  igris verify <report.json>        validate a report + evidence bundle (hashes, schemas)
  igris publish <report.json>       publish a scan result to the registry
  igris scanner <init|import|list|show>   manage this node's scanner identities
  igris query [filters]             query the registry
  igris snapshot [--out file]       dump the registry for offline use

Run any subcommand with --help for its options.
`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'scan': {
      const { runScan } = await import('./commands/scan.js');
      return (await runScan(rest)).exitCode;
    }
    case 'fix': {
      const { runFix } = await import('./commands/fix.js');
      return (await runFix(rest)).exitCode;
    }
    case 'verify': {
      const { runVerify } = await import('./commands/verify.js');
      return (await runVerify(rest)).exitCode;
    }
    case 'scanner': {
      const { runScanner } = await import('./commands/scanner.js');
      return (await runScanner(rest)).exitCode;
    }
    case 'publish': {
      const { runPublish } = await import('./commands/publish.js');
      return (await runPublish(rest)).exitCode;
    }
    case 'query': {
      const { runQuery } = await import('./commands/query.js');
      return (await runQuery(rest)).exitCode;
    }
    case 'snapshot': {
      const { runSnapshot } = await import('./commands/snapshot.js');
      return (await runSnapshot(rest)).exitCode;
    }
    case undefined:
    case '--help':
    case 'help':
      process.stdout.write(HELP);
      return EXIT.OK;
    default:
      process.stderr.write(`igris: unknown command "${cmd}"\n\n${HELP}`);
      return EXIT.INVALID_ARGS;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`igris: ${String(err?.stack ?? err)}\n`);
    process.exit(EXIT.SCAN_ERROR);
  },
);
