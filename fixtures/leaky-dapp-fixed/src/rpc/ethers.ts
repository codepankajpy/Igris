import { anonJsonRpcProvider } from "../igris-anon-rpc";

const RPC_URL = import.meta.env.VITE_RPC_URL ?? 'http://rpc.igris-rpc.test:38545';

const provider = anonJsonRpcProvider(RPC_URL, 1, { staticNetwork: true });

export async function getBalanceEthers(address: string): Promise<bigint> {
  return provider.getBalance(address);
}
