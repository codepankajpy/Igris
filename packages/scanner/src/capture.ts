/**
 * Traffic capture: every HTTP request (including failed/aborted and
 * keepalive/sendBeacon pings), Set-Cookie response headers, WebSocket frames,
 * end-of-phase cookies and canary-bearing storage entries.
 *
 * Service workers are blocked at the context level (serviceWorkers: 'block')
 * so their requests cannot bypass the page's network events — stated in
 * docs/METHODOLOGY.md.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';
import {
  MAX_WALLET_REQUESTS,
  RECORDED_WALLET_METHODS,
  type Capture,
  type CapturedRequest,
  type CapturedWalletRequest,
  type MilestoneEvent,
  type Phase,
} from '@igris/core';

/** Bodies larger than this are truncated before detection (documented cap). */
export const BODY_CAP_BYTES = 512 * 1024;
/** At most this many wallet requests are recorded per scan (docs/design/WALLET-REQUESTS.md). */
export const WALLET_REQUESTS_CAP = MAX_WALLET_REQUESTS;
/** A wallet request's JSON params are cut to this many characters (64 KiB). */
export const WALLET_PARAMS_CAP = 64 * 1024;

const RECORDED: ReadonlySet<string> = new Set(RECORDED_WALLET_METHODS);

type WalletOutcome = CapturedWalletRequest['outcome'];

/** Methods the canary wallet always rejects (EIP-1193 4001): it never signs transactions or raw data. */
const REJECTED_METHODS: ReadonlySet<string> = new Set([
  'eth_sendTransaction',
  'eth_signTransaction',
  'eth_sendRawTransaction',
  'eth_sign',
]);
/** Methods that ask for a signature (the canary signs personal_sign / v4 typed data, errors on the rest). */
const SIGNING_METHODS: ReadonlySet<string> = new Set([
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
]);

/**
 * The outcomes the canary wallet can actually produce for `method`
 * (wallet-init.ts): transactions / eth_sign → rejected; signature requests →
 * signed | error; everything else → answered | error. A report of any other
 * outcome is page-forged and ignored.
 */
export function canaryOutcomes(method: string): readonly WalletOutcome[] {
  if (REJECTED_METHODS.has(method)) return ['rejected'];
  if (SIGNING_METHODS.has(method)) return ['signed', 'error'];
  return ['answered', 'error'];
}

/** A per-scan secret for the canary wallet's reports (32 hex chars). */
export function newWalletNonce(): string {
  return randomBytes(16).toString('hex');
}

/** One recorded call not completed yet. */
interface PendingWalletCall {
  method: string;
  /** The recorded entry; null past WALLET_REQUESTS_CAP (still tracked so signing stays gated). */
  entry: CapturedWalletRequest | null;
  /** The Node-side signer is working on it. */
  signing: boolean;
}

/** One report from the page's canary wallet (see wallet-init.ts), plus its calling frame. */
export interface WalletRequestReport {
  /** Opaque key of the calling frame (correlates the before/after reports of one call). */
  frameKey: object;
  frame: 'main' | 'iframe';
  origin: string;
  method: unknown;
  params: unknown;
  /** 'pending' before the wallet acts, then the outcome. */
  outcome: unknown;
  /** Per-frame call number. */
  id: unknown;
  /** The scan's wallet nonce, as the init script passed it; reports without it are ignored. */
  nonce: unknown;
}

// The capture SHAPE is a core contract (detectors consume it); the recorder
// that fills it lives here.
export type {
  Capture,
  CapturedRequest,
  CapturedWsFrame,
  CapturedStorage,
  CapturedCookie,
  CapturedMainDocument,
} from '@igris/core';

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

export class TrafficRecorder {
  readonly capture: Capture = {
    requests: [],
    wsFrames: [],
    wsConnections: 0,
    storage: [],
    cookies: [],
    walletRequests: [],
  };
  private phase: Phase = 'pre-connect';
  /** Wallet requests not answered yet, per calling frame and call number. */
  private pendingWallet = new WeakMap<object, Map<number, PendingWalletCall>>();
  private readonly nonceBytes: Buffer;

  /**
   * @param walletNonce the per-scan secret injected into the canary wallet's
   *   init script (buildWalletInitScript): only reports carrying it are
   *   recorded, only requests recorded with it can be signed.
   */
  constructor(readonly walletNonce: string = newWalletNonce()) {
    this.nonceBytes = Buffer.from(walletNonce, 'utf8');
  }

  /** Whether a page-supplied value is this scan's wallet nonce (constant time). */
  private nonceOk(nonce: unknown): boolean {
    if (typeof nonce !== 'string') return false;
    const given = Buffer.from(nonce, 'utf8');
    return given.length === this.nonceBytes.length && timingSafeEqual(given, this.nonceBytes);
  }
  /** Navigation start (ms epoch); timeline offsets are relative to it. */
  private origin: number | null = null;

  setPhase(phase: Phase): void {
    this.phase = phase;
  }

  /** Start the timeline clock (call right before page.goto). */
  startClock(now = Date.now()): void {
    this.origin = now;
  }

  /** ms since navigation start, or undefined before the clock started. */
  private elapsed(now = Date.now()): number | undefined {
    return this.origin === null ? undefined : Math.max(0, Math.round(now - this.origin));
  }

  /** Record a scan milestone once (first occurrence wins). */
  milestone(event: MilestoneEvent, now = Date.now()): void {
    const t = this.elapsed(now);
    if (t === undefined) return;
    const list = (this.capture.milestones ??= []);
    if (!list.some((m) => m.event === event)) list.push({ event, t });
  }

  /**
   * Record a wallet request reported by the page's canary wallet. The page
   * reports each call twice: `pending` before the wallet acts (fixes its
   * order, phase and time) and the outcome after. Input is page-controlled,
   * so: reports without the scan's wallet nonce are ignored; unknown methods
   * are ignored; an outcome the canary cannot produce for that method
   * (canaryOutcomes) is ignored; `signed` is never taken from the page — only
   * the Node-side signer records it (signWalletRequest); params are cut to
   * WALLET_PARAMS_CAP and at most WALLET_REQUESTS_CAP requests are kept. A
   * request never answered before the scan ended keeps outcome `error`.
   */
  walletRequest(r: WalletRequestReport, now = Date.now()): void {
    if (!this.nonceOk(r.nonce)) return;
    if (typeof r.id !== 'number' || !Number.isInteger(r.id)) return;
    const list = (this.capture.walletRequests ??= []);
    let pending = this.pendingWallet.get(r.frameKey);
    if (r.outcome === 'pending') {
      if (typeof r.method !== 'string' || !RECORDED.has(r.method)) return;
      let entry: CapturedWalletRequest | null = null;
      if (list.length < WALLET_REQUESTS_CAP) {
        entry = {
          phase: this.phase,
          method: r.method as CapturedWalletRequest['method'],
          params: (typeof r.params === 'string' ? r.params : '[]').slice(0, WALLET_PARAMS_CAP),
          frame: r.frame,
          origin: r.origin.slice(0, 2048) || 'null',
          outcome: 'error',
        };
        const t = this.elapsed(now);
        if (t !== undefined) entry.t = t;
        list.push(entry);
      }
      if (!pending) this.pendingWallet.set(r.frameKey, (pending = new Map()));
      pending.set(r.id, { method: r.method, entry, signing: false });
      return;
    }
    const call = pending?.get(r.id);
    if (!call || call.signing || typeof r.outcome !== 'string' || r.outcome === 'signed') return;
    if (!(canaryOutcomes(call.method) as readonly string[]).includes(r.outcome)) return;
    if (call.entry) call.entry.outcome = r.outcome as WalletOutcome;
    pending!.delete(r.id);
  }

  /**
   * Sign for a recorded wallet request (the `__igrisSign` binding). Signs only
   * when the calling frame has a pending request `id` of exactly `method`,
   * recorded with the scan's nonce and not completed or signed yet;
   * otherwise refuses (throws) and `sign` is never called — so the page
   * cannot get a canary signature that is not in `walletRequests`. The
   * outcome (`signed`, or `error` when signing fails) is recorded here,
   * Node-side, and completes the request.
   */
  async signWalletRequest<T>(
    frameKey: object,
    method: unknown,
    id: unknown,
    nonce: unknown,
    sign: () => Promise<T>,
  ): Promise<T> {
    const pending = this.pendingWallet.get(frameKey);
    const call = typeof id === 'number' ? pending?.get(id) : undefined;
    if (
      !this.nonceOk(nonce) ||
      !call ||
      call.signing ||
      typeof method !== 'string' ||
      call.method !== method ||
      !SIGNING_METHODS.has(method)
    )
      throw new Error('Igris Canary Wallet: no matching wallet request to sign');
    call.signing = true;
    try {
      const signature = await sign();
      if (call.entry) call.entry.outcome = 'signed';
      return signature;
    } catch (err) {
      if (call.entry) call.entry.outcome = 'error';
      throw err;
    } finally {
      if (pending!.get(id as number) === call) pending!.delete(id as number);
    }
  }

  attach(context: BrowserContext): void {
    context.on('request', (request) => {
      let body: string | null = null;
      try {
        body = request.postData();
      } catch {
        body = null;
      }
      if (body && body.length > BODY_CAP_BYTES) body = body.slice(0, BODY_CAP_BYTES);
      const entry: CapturedRequest = {
        phase: this.phase,
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        body,
        resourceType: request.resourceType(),
        failed: false,
        setCookies: [],
      };
      const t = this.elapsed();
      if (t !== undefined) entry.t = t;
      this.capture.requests.push(entry);
      const phaseAtRequest = this.phase;
      let isMainDocument = false;
      try {
        isMainDocument =
          request.isNavigationRequest() &&
          request.resourceType() === 'document' &&
          request.frame().parentFrame() === null;
      } catch {
        /* requests without a frame (e.g. service workers) are never the main document */
      }
      // Mark failures (aborted, DNS, connection refused) on the same entry.
      request
        .response()
        .then(async (response) => {
          if (!response) {
            entry.failed = true;
            return;
          }
          try {
            const headers: Record<string, string> = {};
            for (const h of await response.headersArray()) {
              const name = h.name.toLowerCase();
              if (name === 'set-cookie') entry.setCookies.push(h.value);
              headers[name] =
                headers[name] === undefined ? h.value : `${headers[name]}, ${h.value}`;
            }
            const status = response.status();
            if (
              isMainDocument &&
              phaseAtRequest === 'pre-connect' &&
              !this.capture.mainDocument &&
              !isRedirectStatus(status)
            ) {
              this.capture.mainDocument = { url: response.url(), status, headers };
            }
          } catch {
            /* response may be gone (page closed) */
          }
        })
        .catch(() => {
          entry.failed = true;
        });
    });
  }

  attachPage(page: Page): void {
    page.on('websocket', (ws) => {
      this.capture.wsConnections += 1;
      const url = ws.url();
      ws.on('framesent', (frame) =>
        this.capture.wsFrames.push({
          phase: this.phase,
          url,
          direction: 'sent',
          payload:
            typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8'),
          ...(this.elapsed() !== undefined ? { t: this.elapsed()! } : {}),
        }),
      );
      ws.on('framereceived', (frame) =>
        this.capture.wsFrames.push({
          phase: this.phase,
          url,
          direction: 'received',
          payload:
            typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8'),
          ...(this.elapsed() !== undefined ? { t: this.elapsed()! } : {}),
        }),
      );
    });
  }

  /** Snapshot cookies + storage at the end of a phase. */
  async snapshotState(context: BrowserContext, page: Page): Promise<void> {
    const phase = this.phase;
    try {
      for (const c of await context.cookies()) {
        this.capture.cookies.push({ phase, name: c.name, value: c.value, domain: c.domain });
      }
    } catch {
      /* context may already be closing */
    }
    try {
      const storage = await page.evaluate(() => {
        const dump = (s: Storage) => {
          const out: Array<{ key: string; value: string }> = [];
          for (let i = 0; i < s.length; i++) {
            const key = s.key(i);
            if (key !== null) out.push({ key, value: s.getItem(key) ?? '' });
          }
          return out;
        };
        return {
          local: dump(window.localStorage),
          session: dump(window.sessionStorage),
        };
      });
      for (const { key, value } of storage.local)
        this.capture.storage.push({ phase, kind: 'local-storage', key, value });
      for (const { key, value } of storage.session)
        this.capture.storage.push({ phase, kind: 'session-storage', key, value });
    } catch {
      /* page may have navigated away or storage may be inaccessible */
    }
  }
}
