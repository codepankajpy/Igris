/** `igris query` — read scan entities back from the registry, with filters. */
import { parseArgs } from 'node:util';
import { EXIT } from '../exit-codes.js';
import { renderTable } from '../table.js';
import { makeBackend, REGISTRY_FLAG_OPTIONS } from './registry-common.js';
import type { RegistryQuery } from '@igris/registry';

export const QUERY_HELP = `igris query [options]

Options:
  --hostname <h>             exact hostname
  --min-score <n>            score >= n
  --max-score <n>            score <= n
  --class <c>                leak class (e.g. analytics) — client-side on Arkiv
  --since <iso>              scanned at/after this ISO date
  --scanner <addr>           only entities owned by this scanner address
  --uses-anon-rpc <bool>     true/false
  --limit <n>                max rows (<=100 on Arkiv)
  --json                     print JSON instead of a table
  --registry <arkiv|local>   backend (default: arkiv)
  --local-file <path>        local registry file
  --rpc-url <url>            override the Arkiv RPC endpoint
`;

export async function runQuery(argv: string[]): Promise<{ exitCode: number }> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        ...REGISTRY_FLAG_OPTIONS,
        hostname: { type: 'string' },
        'min-score': { type: 'string' },
        'max-score': { type: 'string' },
        class: { type: 'string' },
        since: { type: 'string' },
        scanner: { type: 'string' },
        'uses-anon-rpc': { type: 'string' },
        limit: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`invalid arguments: ${String(err)}\n${QUERY_HELP}`);
    return { exitCode: EXIT.INVALID_ARGS };
  }
  const v = parsed.values;
  if (v.help) {
    process.stdout.write(QUERY_HELP);
    return { exitCode: EXIT.OK };
  }
  for (const flag of ['min-score', 'max-score', 'limit'] as const) {
    if (v[flag] !== undefined && !Number.isFinite(Number(v[flag]))) {
      process.stderr.write(`igris query: --${flag} needs a number\n`);
      return { exitCode: EXIT.INVALID_ARGS };
    }
  }
  if (v['uses-anon-rpc'] !== undefined && !['true', 'false'].includes(v['uses-anon-rpc'])) {
    process.stderr.write(`igris query: --uses-anon-rpc needs true or false\n`);
    return { exitCode: EXIT.INVALID_ARGS };
  }

  const q: RegistryQuery = {
    ...(v.hostname !== undefined ? { hostname: v.hostname } : {}),
    ...(v['min-score'] !== undefined ? { minScore: Number(v['min-score']) } : {}),
    ...(v['max-score'] !== undefined ? { maxScore: Number(v['max-score']) } : {}),
    ...(v.class !== undefined ? { leakClass: v.class } : {}),
    ...(v.since !== undefined ? { since: v.since } : {}),
    ...(v.scanner !== undefined ? { scanner: v.scanner } : {}),
    ...(v['uses-anon-rpc'] !== undefined ? { usesAnonRpc: v['uses-anon-rpc'] === 'true' } : {}),
    ...(v.limit !== undefined ? { limit: Number(v.limit) } : {}),
  };

  try {
    const backend = makeBackend(v);
    const records = await backend.query(q);
    if (v.json) {
      process.stdout.write(JSON.stringify(records, null, 2) + '\n');
    } else if (records.length === 0) {
      process.stdout.write('no matching records\n');
    } else {
      process.stdout.write(
        renderTable(
          ['hostname', 'score', 'scanned', 'leaks', 'classes', 'anon-rpc', 'scanner'],
          records.map((r) => [
            r.hostname,
            String(r.score),
            new Date(r.scannedAt * 1000).toISOString().slice(0, 16),
            String(r.leakCount),
            r.leakClasses || '—',
            r.usesAnonRpc ? 'yes' : 'no',
            r.scanner.length > 12 ? `${r.scanner.slice(0, 8)}…${r.scanner.slice(-4)}` : r.scanner,
          ]),
        ) + '\n',
      );
    }
    return { exitCode: EXIT.OK };
  } catch (err) {
    process.stderr.write(`igris query: ${String(err)}\n`);
    return { exitCode: EXIT.SCAN_ERROR };
  }
}
