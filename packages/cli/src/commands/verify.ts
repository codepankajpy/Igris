/**
 * `igris verify <report.json> [--evidence <file>]` — schema-validate a report
 * and its evidence bundle and check their integrity (bundle hash, content ids,
 * evidence references, ledger references). Exit 0 if valid, 2 if not.
 */
import { parseArgs } from 'node:util';
import { contentHash } from '@igris/core';
import { ArtifactError, loadScanArtifacts } from '../artifacts.js';
import { EXIT } from '../exit-codes.js';

export const VERIFY_HELP = `igris verify <report.json> [options]

Checks that report.json is a valid Report v2 (v1 reports are migrated first),
that the evidence bundle validates, hashes to report.evidence.sha256, and that
every finding's evidence resolves.

Options:
  --evidence <file>   evidence bundle (default: evidence.json next to the report)
`;

export async function runVerify(argv: string[]): Promise<{ exitCode: number }> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { evidence: { type: 'string' }, help: { type: 'boolean', default: false } },
    });
  } catch (err) {
    process.stderr.write(`invalid arguments: ${String(err)}\n${VERIFY_HELP}`);
    return { exitCode: EXIT.INVALID_ARGS };
  }
  if (parsed.values.help) {
    process.stdout.write(VERIFY_HELP);
    return { exitCode: EXIT.OK };
  }
  const file = parsed.positionals[0];
  if (!file) {
    process.stderr.write(`igris verify: need a report.json path\n${VERIFY_HELP}`);
    return { exitCode: EXIT.INVALID_ARGS };
  }
  try {
    const a = loadScanArtifacts(file, parsed.values.evidence);
    const r = a.report;
    process.stdout.write(
      [
        `OK  ${r.scan.hostname} — report ${r.reportVersion}${a.migratedFrom ? ` (migrated from ${a.migratedFrom}; evidence rebuilt from the v1 report)` : ''}`,
        `  report sha256:   ${contentHash(r)}`,
        `  evidence sha256: ${r.evidence.sha256} (${r.evidence.itemCount} items, ${r.evidence.canonicalization})`,
        `  privacy findings: ${r.privacy.findings.length}, security observations: ${r.security.observations.length}`,
        `  privacy score: ${r.privacy.score === null ? 'not scored' : r.privacy.score} (coverage ${r.privacy.coverage})`,
        '',
      ].join('\n'),
    );
    return { exitCode: EXIT.OK };
  } catch (err) {
    const msg = err instanceof ArtifactError || err instanceof Error ? err.message : String(err);
    process.stderr.write(`FAIL ${file}: ${msg}\n`);
    return { exitCode: EXIT.SCAN_ERROR };
  }
}
