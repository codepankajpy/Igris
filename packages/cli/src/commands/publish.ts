/** `igris publish <report.json>` — write a scan entity to the registry. */
import { parseArgs } from 'node:util';
import { EXIT } from '../exit-codes.js';
import { loadScanArtifacts } from '../artifacts.js';
import { makeBackend, REGISTRY_FLAG_OPTIONS, SCANNER_FLAG_OPTION } from './registry-common.js';

export const PUBLISH_HELP = `igris publish <report.json> [options]

Options:
  --registry <arkiv|local>   backend (default: arkiv; signs with this node's scanner key)
  --scanner <name|address>   which scanner signs (default: the node's only scanner)
  --evidence <file>          evidence bundle (default: evidence.json next to the report)
  --local-file <path>        local registry file (default: igris-registry.json)
  --rpc-url <url>            override the Arkiv RPC endpoint
  --expiry-days <n>          entity lifetime (default 30; max ~182)
`;

export async function runPublish(argv: string[]): Promise<{ exitCode: number }> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        ...REGISTRY_FLAG_OPTIONS,
        ...SCANNER_FLAG_OPTION,
        evidence: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`invalid arguments: ${String(err)}\n${PUBLISH_HELP}`);
    return { exitCode: EXIT.INVALID_ARGS };
  }
  if (parsed.values.help) {
    process.stdout.write(PUBLISH_HELP);
    return { exitCode: EXIT.OK };
  }
  const file = parsed.positionals[0];
  if (!file) {
    process.stderr.write(`igris publish: need a report.json path\n${PUBLISH_HELP}`);
    return { exitCode: EXIT.INVALID_ARGS };
  }

  try {
    const { recordFromReport } = await import('@igris/registry');
    // Schema + integrity verified (v1 reports are migrated) before anything is signed.
    const loaded = loadScanArtifacts(file, parsed.values.evidence);
    if (loaded.migratedFrom) {
      process.stderr.write(
        `note: ${file} is report ${loaded.migratedFrom}; migrated to 2.0.0 before publishing\n`,
      );
    }
    const record = recordFromReport(loaded.report, loaded.bundle);
    const backend = makeBackend(parsed.values, true);
    const result = await backend.publish(record);
    process.stdout.write(
      [
        `published ${record.hostname} (score ${record.score}) to ${backend.kind}`,
        `  id:        ${result.id}`,
        `  scanner:   ${result.scanner}`,
        ...(result.txHash ? [`  tx:        ${result.txHash}`] : []),
        ...(result.expiresAt ? [`  expires:   ${result.expiresAt}`] : []),
        `  reportSha: ${record.reportSha256}`,
        `  evidence:  ${loaded.report.evidence.sha256}`,
        '',
      ].join('\n'),
    );
    return { exitCode: EXIT.OK };
  } catch (err) {
    process.stderr.write(`igris publish: ${String(err)}\n`);
    return { exitCode: EXIT.SCAN_ERROR };
  }
}
