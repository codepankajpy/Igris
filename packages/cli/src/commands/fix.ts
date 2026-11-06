/** `igris fix <path>` — implemented in M4 (packages/patcher). */
import { EXIT } from '../exit-codes.js';

export async function runFix(_argv: string[]): Promise<{ exitCode: number }> {
  process.stderr.write('igris fix: not implemented yet (M4)\n');
  return { exitCode: EXIT.INVALID_ARGS };
}
