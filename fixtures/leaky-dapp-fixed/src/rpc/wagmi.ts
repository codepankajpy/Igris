/**
 * The wagmi (@wagmi/core) variant of the leaky RPC setup — `igris fix`
 * target #3. wagmi transports are viem transports under the hood.
 */
import { createConfig, getBalance, http } from '@wagmi/core';
import { mainnet } from 'viem/chains';
import { igrisAnonFetch } from '../igris-anon-rpc';

const RPC_URL = import.meta.env.VITE_RPC_URL ?? 'http://rpc.igris-rpc.test:38545';

const config = createConfig({
  chains: [mainnet],
  transports: {
    [mainnet.id]: http(RPC_URL, { fetchFn: igrisAnonFetch }),
  },
});

export async function getBalanceWagmi(address: `0x${string}`): Promise<bigint> {
  const res = await getBalance(config, { address });
  return res.value;
}
