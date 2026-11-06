/**
 * `igris snapshot` — dump every registry record to one JSON file, in the same
 * shape as the local registry file, so the web viewer (offline mode) and the
 * extension stub can consume either interchangeably.
 */
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { EXIT } from '../exit-codes.js';
import { makeBackend, REGISTRY_FLAG_OPTIONS } from './registry-common.js';

export const SNAPSHOT_HELP = `igris snapshot [options]

Options:
  --out <file>               output path (default: igris-snapshot.json)
  --registry <arkiv|local>   backend (default: arkiv)
  --local-file <path>        local registry file
  --rpc-url <url>            override the Arkiv RPC endpoint
`;

export async function runSnapshot(argv: string[]): Promise<{ exitCode: number }> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        ...REGISTRY_FLAG_OPTIONS,
        out: { type: 'string', default: 'igris-snapshot.json' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`invalid arguments: ${String(err)}\n${SNAPSHOT_HELP}`);
    return { exitCode: EXIT.INVALID_ARGS };
  }
  if (parsed.values.help) {
    process.stdout.write(SNAPSHOT_HELP);
    return { exitCode: EXIT.OK };
  }
  try {
    const backend = makeBackend(parsed.values);
    const records = await backend.snapshot();
    writeFileSync(parsed.values.out, JSON.stringify({ version: 1, records }, null, 2) + '\n');
    process.stdout.write(`${records.length} record(s) → ${parsed.values.out}\n`);
    return { exitCode: EXIT.OK };
  } catch (err) {
    process.stderr.write(`igris snapshot: ${String(err)}\n`);
    return { exitCode: EXIT.SCAN_ERROR };
  }
}
