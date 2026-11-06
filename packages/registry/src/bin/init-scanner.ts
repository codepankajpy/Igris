/**
 * One-time operator setup: create this node's scanner key (the Arkiv
 * publisher). Usage: pnpm scanner:init <name>
 * The key is written to $IGRIS_HOME (default ~/.igris), mode 0600, bound to
 * this machine; only the address is printed.
 */
import { initScanner, listScanners } from '../identity.js';

const name = process.argv[2];
if (!name || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
  console.error('usage: pnpm scanner:init <name>   (lower-case letters, digits, dashes)');
  process.exit(3);
}
const existing = listScanners();
if (existing.length) {
  console.log(
    `scanner(s) already on this node: ${existing.map((s) => `${s.name} ${s.address}`).join(', ')}`,
  );
  process.exit(0);
}
const p = initScanner({ name });
console.log(`created scanner "${p.name}" ${p.address}`);
console.log(
  `fund it at https://hub.arkiv.network/faucet, then start the API (it publishes as this address).`,
);
