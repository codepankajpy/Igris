/**
 * The viem variant of the leaky RPC setup — `igris fix` target #1.
 * A public RPC read for the connected address: the RPC provider learns
 * (address, IP) pairs for every visitor.
 */
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';

const RPC_URL = import.meta.env.VITE_RPC_URL ?? 'http://rpc.igris-rpc.test:38545';

const client = createPublicClient({
  chain: mainnet,
  transport: http(RPC_URL),
});

export async function getBalanceViem(address: `0x${string}`): Promise<bigint> {
  return client.getBalance({ address });
}
