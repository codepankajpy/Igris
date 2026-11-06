/**
 * `igris fix <path>` — patch a dapp repo to route RPC reads through Anon-RPC.
 * Dry-run by default: prints a unified diff. `--write` applies it (twice is a
 * no-op). Patterns that cannot be auto-patched become precise manual notes.
 */
import { parseArgs } from 'node:util';
import { EXIT } from '../exit-codes.js';

export const FIX_HELP = `igris fix <path> [options]

Options:
  --write               apply the changes (default: dry-run, print the diff)
  --branch <name>       create and switch to a git branch before writing
  --specifier <addr>    Anon-RPC specifier contract (default: Nym mainnet)
`;

export async function runFix(argv: string[]): Promise<{ exitCode: number }> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        write: { type: 'boolean', default: false },
        branch: { type: 'string' },
        specifier: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`invalid arguments: ${String(err)}\n${FIX_HELP}`);
    return { exitCode: EXIT.INVALID_ARGS };
  }
  if (parsed.values.help) {
    process.stdout.write(FIX_HELP);
    return { exitCode: EXIT.OK };
  }
  const target = parsed.positionals[0];
  if (!target) {
    process.stderr.write(`igris fix: need a path\n${FIX_HELP}`);
    return { exitCode: EXIT.INVALID_ARGS };
  }

  const { fix } = await import('@igris/patcher');
  let result;
  try {
    result = fix({
      targetDir: target,
      write: parsed.values.write,
      ...(parsed.values.branch ? { branch: parsed.values.branch } : {}),
      ...(parsed.values.specifier ? { specifier: parsed.values.specifier } : {}),
    });
  } catch (err) {
    process.stderr.write(`igris fix: ${String(err)}\n`);
    return { exitCode: EXIT.INVALID_ARGS };
  }

  if (!result.diff) {
    process.stderr.write('igris fix: nothing to change (already patched, or no known RPC patterns found)\n');
  } else {
    process.stdout.write(result.diff);
    process.stderr.write(
      result.wrote
        ? `\napplied to ${result.changedFiles.length} file(s): ${result.changedFiles.join(', ')}\n`
        : `\ndry run — ${result.changedFiles.length} file(s) would change; re-run with --write to apply\n`,
    );
  }
  for (const note of result.notes) {
    process.stderr.write(`manual: ${note.file}:${note.line}: ${note.message}\n`);
  }
  return { exitCode: EXIT.OK };
}
