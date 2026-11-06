/**
 * The leaky dapp. Every leak below is DELIBERATE and asserted by the e2e
 * suite (packages/scanner/e2e). Pick the RPC library with ?variant=viem|ethers|wagmi.
 */
import { ANALYTICS_URL, ERRORS_URL, PIXEL_URL } from './config';
import { getBalanceViem } from './rpc/viem';
import { getBalanceEthers } from './rpc/ethers';
import { getBalanceWagmi } from './rpc/wagmi';

type Eip1193 = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const variant = new URLSearchParams(location.search).get('variant') ?? 'viem';

async function getBalance(address: `0x${string}`): Promise<bigint> {
  if (variant === 'ethers') return getBalanceEthers(address);
  if (variant === 'wagmi') return getBalanceWagmi(address);
  return getBalanceViem(address);
}

async function onConnect(): Promise<void> {
  const ethereum = (window as { ethereum?: Eip1193 }).ethereum;
  if (!ethereum) {
    statusEl.textContent = 'no wallet found';
    return;
  }
  const accounts = (await ethereum.request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts[0] as `0x${string}`;
  statusEl.textContent = `connected: ${address.slice(0, 6)}…${address.slice(-4)} (${variant})`;

  // LEAK 1 — public RPC read: eth_getBalance carries the address to the
  // configured RPC provider (plus the user's IP).
  try {
    const balance = await getBalance(address);
    statusEl.textContent += ` — balance ${balance}`;
  } catch (err) {
    statusEl.textContent += ` — balance read failed (${String(err).slice(0, 60)})`;
  }

  // LEAK 2 — analytics beacon with the address in the body, twice-encoded:
  // plain and base64 (a common "user id" trick).
  navigator.sendBeacon(
    ANALYTICS_URL,
    JSON.stringify({ event: 'wallet_connected', wallet: address, uid: btoa(address) }),
  );

  // LEAK 3 — error-monitor envelope with the address in a breadcrumb.
  void fetch(ERRORS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: 'fixture',
      breadcrumbs: [{ category: 'wallet', message: `user ${address} connected`, level: 'info' }],
    }),
    keepalive: true,
  }).catch(() => {});

  // LEAK 4 — tracking pixel with the address in a URL query param.
  new Image().src = `${PIXEL_URL}?ref=${address}&t=fixture`;

  // Persisted locally (reported, not scored): survives reloads.
  localStorage.setItem('leaky-dapp:lastAddress', address);

  // Exercise signing — the canary wallet signs personal_sign Node-side.
  try {
    await ethereum.request({
      method: 'personal_sign',
      params: ['Leaky dapp login', address],
    });
  } catch {
    /* ignored */
  }
}

document.querySelector('#connect')!.addEventListener('click', () => {
  void onConnect();
});
