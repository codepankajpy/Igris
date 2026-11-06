/**
 * The ethers v6 variant of the leaky RPC setup — `igris fix` target #2.
 */
import { JsonRpcProvider } from 'ethers';

const RPC_URL = import.meta.env.VITE_RPC_URL ?? 'http://rpc.igris-rpc.test:38545';

const provider = new JsonRpcProvider(RPC_URL, 1, { staticNetwork: true });

export async function getBalanceEthers(address: string): Promise<bigint> {
  return provider.getBalance(address);
}
