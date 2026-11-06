/** `igris publish <report.json>` — write a scan entity to the registry. */
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { EXIT } from '../exit-codes.js';
import { makeBackend, REGISTRY_FLAG_OPTIONS } from './registry-common.js';

export const PUBLISH_HELP = `igris publish <report.json> [options]

Options:
  --registry <arkiv|local>   backend (default: arkiv; needs ARKIV_PRIVATE_KEY)
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
      options: { ...REGISTRY_FLAG_OPTIONS, help: { type: 'boolean', default: false } },
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
    const raw = readFileSync(file, 'utf8');
    const report = JSON.parse(raw);
    const record = recordFromReport(report, raw);
    const backend = makeBackend(parsed.values);
    const result = await backend.publish(record);
    process.stdout.write(
      [
        `published ${record.hostname} (score ${record.score}) to ${backend.kind}`,
        `  id:        ${result.id}`,
        `  scanner:   ${result.scanner}`,
        ...(result.txHash ? [`  tx:        ${result.txHash}`] : []),
        ...(result.expiresAt ? [`  expires:   ${result.expiresAt}`] : []),
        `  reportSha: ${record.reportSha256}`,
        '',
      ].join('\n'),
    );
    return { exitCode: EXIT.OK };
  } catch (err) {
    process.stderr.write(`igris publish: ${String(err)}\n`);
    return { exitCode: EXIT.SCAN_ERROR };
  }
}
