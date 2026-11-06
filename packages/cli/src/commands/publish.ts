/** `igris publish <report.json>` — implemented in M5 (packages/registry). */
import { EXIT } from '../exit-codes.js';

export async function runPublish(_argv: string[]): Promise<{ exitCode: number }> {
  process.stderr.write('igris publish: not implemented yet (M5)\n');
  return { exitCode: EXIT.INVALID_ARGS };
}
