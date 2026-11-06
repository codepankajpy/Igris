/**
 * `igris scanner <init|import|list|show>` — manage this node's scanner
 * identities (one signing key per scanner, bound to this machine). Keys are
 * never printed.
 */
import { parseArgs } from 'node:util';
import {
  IdentityError,
  ensureNode,
  igrisHome,
  importScanner,
  initScanner,
  listScanners,
  loadScanner,
} from '@igris/registry';
import { EXIT } from '../exit-codes.js';

export const SCANNER_HELP = `igris scanner <command>

Commands:
  init --name <name>                     generate a new scanner key on this node
  import --name <name> --key-file <f>    adopt an existing key (refused if already claimed)
  list                                   scanners on this node
  show [name|address]                    profile of one scanner

Keys live in $IGRIS_HOME (default ~/.igris), mode 0600, bound to this node.
A second machine must run "igris scanner init" itself; copied profiles are refused.
Fund a new scanner's address at https://hub.arkiv.network/faucet before publishing.
`;

export async function runScanner(argv: string[]): Promise<{ exitCode: number }> {
  const [sub, ...rest] = argv;
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        name: { type: 'string' },
        'key-file': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`invalid arguments: ${String(err)}\n${SCANNER_HELP}`);
    return { exitCode: EXIT.INVALID_ARGS };
  }
  if (!sub || sub === 'help' || parsed.values.help) {
    process.stdout.write(SCANNER_HELP);
    return { exitCode: sub ? EXIT.OK : EXIT.INVALID_ARGS };
  }
  const out = (s: string) => process.stdout.write(s + '\n');
  try {
    switch (sub) {
      case 'init':
      case 'import': {
        if (!parsed.values.name) throw new IdentityError('--name is required');
        const p =
          sub === 'init'
            ? initScanner({ name: parsed.values.name })
            : importScanner({
                name: parsed.values.name,
                keyFile:
                  parsed.values['key-file'] ??
                  (() => {
                    throw new IdentityError('--key-file is required');
                  })(),
              });
        out(`${sub === 'init' ? 'created' : 'imported'} scanner "${p.name}"`);
        out(`  address: ${p.address}`);
        out(`  node:    ${p.nodeId}`);
        out(`  home:    ${igrisHome()}`);
        out(`next: fund ${p.address} at https://hub.arkiv.network/faucet, then igris publish …`);
        return { exitCode: EXIT.OK };
      }
      case 'list': {
        const node = ensureNode();
        const all = listScanners();
        if (!all.length) out('no scanners on this node (igris scanner init --name <name>)');
        for (const p of all) {
          out(
            `${p.name.padEnd(16)} ${p.address}  ${p.origin}${p.nodeId === node.nodeId ? '' : '  [OTHER NODE — unusable here]'}`,
          );
        }
        return { exitCode: EXIT.OK };
      }
      case 'show': {
        const s = loadScanner(parsed.positionals[0] ? { selector: parsed.positionals[0] } : {});
        out(JSON.stringify(s.profile, null, 2));
        return { exitCode: EXIT.OK };
      }
      default:
        process.stderr.write(`igris scanner: unknown command "${sub}"\n${SCANNER_HELP}`);
        return { exitCode: EXIT.INVALID_ARGS };
    }
  } catch (err) {
    process.stderr.write(`igris scanner: ${(err as Error).message}\n`);
    return { exitCode: err instanceof IdentityError ? EXIT.INVALID_ARGS : EXIT.SCAN_ERROR };
  }
}
