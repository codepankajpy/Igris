/**
 * The mock "Igris Canary Wallet" injected into every scanned page.
 *
 * `igrisInitWallet` below is SERIALIZED with .toString() and evaluated in the
 * page before any page script runs (Playwright addInitScript), so it must be
 * fully self-contained: no imports, no outer-scope references (its config,
 * including the recorded method list, is passed in as JSON). Node-side
 * callbacks are reached through bindings exposed on the context:
 *
 *   __igrisWalletRead(method, params) — answer read RPCs (stubbed by default)
 *   __igrisSign(kind, params, id, nonce)
 *       — sign with the throwaway canary key; Node-side it signs only for a
 *         pending recorded request `id` of that method (capture.ts
 *         signWalletRequest), so a page calling it directly gets nothing
 *   __igrisWalletEvent(event)         — "the dApp requested accounts"
 *   __igrisWalletRequest(method, paramsJSON, outcome, id, nonce)
 *       — every call of a RECORDED_WALLET_METHODS method, reported twice:
 *         outcome "pending" before the wallet acts, then answered | signed |
 *         rejected | error after. The scanner adds the calling frame (main
 *         frame of the scan page or not) and its origin from the binding
 *         source (docs/design/WALLET-REQUESTS.md). Reporting never changes
 *         what the wallet does.
 *
 * `nonce` is a per-scan secret generated Node-side and passed in the config:
 * it lives only in this closure (never on window), and the recorder ignores
 * reports and sign calls without it. Both bindings are taken from window when
 * the wallet is installed (Playwright installs bindings before init scripts),
 * so a page that later replaces them neither hides its requests nor receives
 * the nonce. Defence in depth (the binding transport itself runs in the
 * page's world): the recorder also accepts only outcomes the canary can
 * produce per method, records `signed` only from the Node-side signer, and
 * the signer signs only requests already recorded.
 *
 * Signing happens Node-side so the private key never enters the page. The
 * page only ever sees the canary ADDRESS — which is the whole point: anything
 * that ships it to a third party is a provable leak.
 */
import { RECORDED_WALLET_METHODS } from '@igris/core';

export interface WalletInitConfig {
  /** Canary address (0x…40 hex). */
  address: string;
  chainId: number;
  /** Also set isMetaMask=true so MetaMask-only dapps connect (documented trade-off). */
  spoofMetaMask: boolean;
  /** Per-scan secret carried by every report and sign call (TrafficRecorder.walletNonce). */
  nonce: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function igrisInitWallet(cfg: {
  address: string;
  chainId: number;
  spoofMetaMask: boolean;
  /** Methods reported through __igrisWalletRequest (RECORDED_WALLET_METHODS). */
  recordedMethods?: string[];
  /** Per-scan secret passed to the bindings (see the header). */
  nonce?: string;
}): void {
  const w = window as any;
  if (w.__igrisWalletInstalled) return;
  w.__igrisWalletInstalled = true;

  // Keep the reporting binding in this closure as soon as it exists, so a
  // page that later overwrites window.__igrisWalletRequest cannot hide its
  // own requests from the scan.
  const recorded = new Set(cfg.recordedMethods ?? []);
  const nonce = cfg.nonce ?? '';
  let reportBinding: any =
    typeof w.__igrisWalletRequest === 'function' ? w.__igrisWalletRequest : null;
  let signBinding: any = typeof w.__igrisSign === 'function' ? w.__igrisSign : null;
  let requestSeq = 0;
  /** Report a call; resolves once the scanner has recorded it (never rejects). */
  function reportRequest(
    method: string,
    paramsJSON: string,
    outcome: string,
    id: number,
  ): Promise<void> {
    try {
      if (!reportBinding && typeof w.__igrisWalletRequest === 'function')
        reportBinding = w.__igrisWalletRequest;
      const sent = reportBinding?.(method, paramsJSON, outcome, id, nonce);
      if (sent && typeof sent.then === 'function')
        return sent.then(
          () => {},
          () => {},
        );
    } catch {
      /* binding absent (e.g. discovery tooling) */
    }
    return Promise.resolve();
  }
  function sign(kind: string, params: any[], id: number | undefined): Promise<any> {
    if (!signBinding && typeof w.__igrisSign === 'function') signBinding = w.__igrisSign;
    if (!signBinding) return Promise.reject(rpcError(4200, 'Igris Canary Wallet: cannot sign'));
    return signBinding(kind, params, id, nonce);
  }

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

  const SIGNS = new Set(['personal_sign', 'eth_signTypedData_v4']);

  async function handle(args: { method: string; params?: any[] }, id?: number): Promise<any> {
    const method = args?.method;
    const params = args?.params ?? [];
    switch (method) {
      case 'eth_accounts':
        return connected ? [cfg.address] : [];
      case 'eth_requestAccounts': {
        // Tell the scanner (Node side) that the dapp asked for accounts:
        // this, not DOM guessing, is the connection signal.
        try {
          void w.__igrisWalletEvent?.('eth_requestAccounts');
        } catch {
          /* binding absent (e.g. discovery tooling) */
        }
        if (!connected) {
          connected = true;
          provider.selectedAddress = cfg.address;
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
        return await sign('personal_sign', params, id);
      case 'eth_signTypedData_v4':
        return await sign('eth_signTypedData_v4', params, id);
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
  }

  const provider: any = {
    isIgrisCanary: true,
    async request(args: { method: string; params?: any[] }): Promise<any> {
      const method = args?.method;
      if (typeof method !== 'string' || !recorded.has(method)) return handle(args);
      const id = ++requestSeq;
      let paramsJSON = '[]';
      try {
        paramsJSON = JSON.stringify(args.params ?? []) ?? '[]';
      } catch {
        paramsJSON = '"<unserialisable params>"';
      }
      // Before the wallet acts: fixes the order, phase and time of the
      // request. A signature waits until it is recorded: the signer only
      // signs recorded requests.
      const recordedNow = reportRequest(method, paramsJSON, 'pending', id);
      if (SIGNS.has(method)) await recordedNow;
      try {
        const result = await handle(args, id);
        reportRequest(method, '', SIGNS.has(method) ? 'signed' : 'answered', id);
        return result;
      } catch (err: any) {
        reportRequest(method, '', err?.code === 4001 ? 'rejected' : 'error', id);
        throw err;
      }
    },
    isConnected() {
      return true;
    },
    selectedAddress: null,
    chainId: chainIdHex,
    networkVersion: String(parseInt(chainIdHex, 16)),
    on(event: string, fn: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return provider;
    },
    addListener(event: string, fn: Listener) {
      return provider.on(event, fn);
    },
    removeListener(event: string, fn: Listener) {
      listeners.get(event)?.delete(fn);
      return provider;
    },
    off(event: string, fn: Listener) {
      return provider.removeListener(event, fn);
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

  if (cfg.spoofMetaMask) {
    provider.isMetaMask = true;
    provider._metamask = {
      isUnlocked: () => Promise.resolve(true),
      isControllable: () => Promise.resolve(true),
    };
  }

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
  const metaMaskInfo = cfg.spoofMetaMask
    ? Object.freeze({
        uuid: 'c76a13a8-4eb4-44ec-b8f9-5ec6be13508f',
        name: 'MetaMask',
        icon:
          'data:image/svg+xml;base64,' +
          btoa(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
              '<rect width="32" height="32" rx="6" fill="#e2761b"/>' +
              '<circle cx="16" cy="16" r="8" fill="#ffffff"/></svg>',
          ),
        rdns: 'io.metamask',
      })
    : null;

  function announce(): void {
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info, provider }),
      }),
    );
    if (metaMaskInfo) {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: Object.freeze({ info: metaMaskInfo, provider }),
        }),
      );
    }
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
  const full = { ...cfg, recordedMethods: [...RECORDED_WALLET_METHODS] };
  // esbuild-based runtimes (tsx, vitest) transpile this module with
  // keepNames, which rewrites inner functions to `__name(fn, "fn")` calls —
  // a helper that lives OUTSIDE the serialized function. Shim it so the
  // stringified source runs in the page under every toolchain (plain tsc
  // emits no helper; the shim is then unused).
  const nameShim = 'var __name = (fn) => fn;';
  return `(() => { ${nameShim} (${igrisInitWallet.toString()})(${JSON.stringify(full)}); })();`;
}
