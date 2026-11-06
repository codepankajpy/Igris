/** `igris query` — implemented in M5 (packages/registry). */
import { EXIT } from '../exit-codes.js';

export async function runQuery(_argv: string[]): Promise<{ exitCode: number }> {
  process.stderr.write('igris query: not implemented yet (M5)\n');
  return { exitCode: EXIT.INVALID_ARGS };
}
