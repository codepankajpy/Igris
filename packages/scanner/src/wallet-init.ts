/**
 * The mock "Igris Canary Wallet" injected into every scanned page.
 *
 * `igrisInitWallet` below is SERIALIZED with .toString() and evaluated in the
 * page before any page script runs (Playwright addInitScript), so it must be
 * fully self-contained: no imports, no outer-scope references. Node-side
 * callbacks are reached through two bindings exposed with
 * context.exposeFunction:
 *
 *   __igrisWalletRead(method, params) — answer read RPCs (stubbed by default)
 *   __igrisSign(kind, params)         — sign with the throwaway canary key
 *
 * Signing happens Node-side so the private key never enters the page. The
 * page only ever sees the canary ADDRESS — which is the whole point: anything
 * that ships it to a third party is a provable leak.
 */

export interface WalletInitConfig {
  /** Canary address (0x…40 hex). */
  address: string;
  chainId: number;
  /** Also set isMetaMask=true so MetaMask-only dapps connect (documented trade-off). */
  spoofMetaMask: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function igrisInitWallet(cfg: {
  address: string;
  chainId: number;
  spoofMetaMask: boolean;
}): void {
  const w = window as any;
  if (w.__igrisWalletInstalled) return;
  w.__igrisWalletInstalled = true;

  let chainIdHex = '0x' + cfg.chainId.toString(16);
  let connected = false;

  type Listener = (...args: any[]) => void;
  const listeners = new Map<string, Set<Listener>>();
  function emit(event: string, payload: any): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch {
        /* dapp listener errors are not our problem */
      }
    }
  }

  // Read-style methods are forwarded to the Node-side handler (stubbed by
  // default so a scan sends nothing to the network).
  const FORWARDED = new Set([
    'eth_getBalance',
    'eth_call',
    'eth_blockNumber',
    'eth_gasPrice',
    'eth_maxPriorityFeePerGas',
    'eth_feeHistory',
    'eth_estimateGas',
    'eth_getTransactionCount',
    'eth_getCode',
    'eth_getStorageAt',
    'eth_getLogs',
    'eth_getBlockByNumber',
    'eth_getBlockByHash',
    'eth_getTransactionByHash',
    'eth_getTransactionReceipt',
  ]);

  function rpcError(code: number, message: string): Error {
    const err = new Error(message) as any;
    err.code = code;
    return err;
  }

  const provider: any = {
    isIgrisCanary: true,
    async request(args: { method: string; params?: any[] }): Promise<any> {
      const method = args?.method;
      const params = args?.params ?? [];
      switch (method) {
        case 'eth_accounts':
          return connected ? [cfg.address] : [];
        case 'eth_requestAccounts': {
          if (!connected) {
            connected = true;
            emit('connect', { chainId: chainIdHex });
            emit('accountsChanged', [cfg.address]);
          }
          return [cfg.address];
        }
        case 'eth_chainId':
          return chainIdHex;
        case 'net_version':
          return String(parseInt(chainIdHex, 16));
        case 'wallet_switchEthereumChain': {
          const target = params[0]?.chainId;
          if (typeof target === 'string') {
            chainIdHex = target;
            emit('chainChanged', chainIdHex);
          }
          return null;
        }
        case 'wallet_addEthereumChain':
          return null; // accept silently
        case 'wallet_requestPermissions':
        case 'wallet_getPermissions':
          return [{ parentCapability: 'eth_accounts' }];
        case 'personal_sign':
          return await w.__igrisSign('personal_sign', params);
        case 'eth_signTypedData_v4':
          return await w.__igrisSign('eth_signTypedData_v4', params);
        case 'eth_sendTransaction':
        case 'eth_sign':
        case 'eth_signTransaction':
        case 'eth_sendRawTransaction':
          // A scanner must never move funds or produce reusable signatures
          // over raw data. EIP-1193 user-rejected code.
          throw rpcError(4001, 'Igris Canary Wallet: rejected (scanner never signs transactions)');
        default:
          if (FORWARDED.has(method)) {
            const res = await w.__igrisWalletRead(method, params);
            if (res && res.error) throw rpcError(res.error.code ?? -32000, res.error.message);
            return res.result;
          }
          throw rpcError(4200, 'Igris Canary Wallet: unsupported method ' + method);
      }
    },
    on(event: string, fn: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return provider;
    },
    removeListener(event: string, fn: Listener) {
      listeners.get(event)?.delete(fn);
      return provider;
    },
    removeAllListeners(event?: string) {
      if (event) listeners.delete(event);
      else listeners.clear();
      return provider;
    },
    // Legacy APIs some dapps still probe.
    enable() {
      return provider.request({ method: 'eth_requestAccounts' });
    },
    send(methodOrPayload: any, paramsOrCb?: any) {
      if (typeof methodOrPayload === 'string')
        return provider.request({ method: methodOrPayload, params: paramsOrCb });
      return provider.request(methodOrPayload);
    },
    sendAsync(payload: any, cb: (err: any, res?: any) => void) {
      provider
        .request(payload)
        .then((result: any) => cb(null, { id: payload?.id, jsonrpc: '2.0', result }))
        .catch((err: any) => cb(err));
    },
  };

  if (cfg.spoofMetaMask) provider.isMetaMask = true;

  // EIP-6963 announcement (plus the legacy window.ethereum global).
  const info = Object.freeze({
    uuid: 'a9c2de43-7a11-4f3b-9c1e-8f52ab77cafe',
    name: 'Igris Canary Wallet',
    icon:
      'data:image/svg+xml;base64,' +
      btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
          '<rect width="32" height="32" rx="6" fill="#1a1a2e"/>' +
          '<circle cx="16" cy="16" r="8" fill="#e9c46a"/></svg>',
      ),
    rdns: 'network.igris.canary',
  });
  function announce(): void {
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info, provider }),
      }),
    );
  }
  window.addEventListener('eip6963:requestProvider', announce);
  announce();

  try {
    Object.defineProperty(w, 'ethereum', { value: provider, configurable: true });
  } catch {
    w.ethereum = provider;
  }
  w.dispatchEvent(new Event('ethereum#initialized'));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Build the raw init-script source injected via addInitScript. */
export function buildWalletInitScript(cfg: WalletInitConfig): string {
  // esbuild-based runtimes (tsx, vitest) transpile this module with
  // keepNames, which rewrites inner functions to `__name(fn, "fn")` calls —
  // a helper that lives OUTSIDE the serialized function. Shim it so the
  // stringified source runs in the page under every toolchain (plain tsc
  // emits no helper; the shim is then unused).
  const nameShim = 'var __name = (fn) => fn;';
  return `(() => { ${nameShim} (${igrisInitWallet.toString()})(${JSON.stringify(cfg)}); })();`;
}
