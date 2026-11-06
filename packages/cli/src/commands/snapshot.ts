/** `igris snapshot` — implemented in M5 (packages/registry). */
import { EXIT } from '../exit-codes.js';

export async function runSnapshot(_argv: string[]): Promise<{ exitCode: number }> {
  process.stderr.write('igris snapshot: not implemented yet (M5)\n');
  return { exitCode: EXIT.INVALID_ARGS };
}
