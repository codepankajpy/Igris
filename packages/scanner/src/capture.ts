/**
 * Traffic capture: every HTTP request (including failed/aborted and
 * keepalive/sendBeacon pings), Set-Cookie response headers, WebSocket frames,
 * end-of-phase cookies and canary-bearing storage entries.
 *
 * Service workers are blocked at the context level (serviceWorkers: 'block')
 * so their requests cannot bypass the page's network events — stated in
 * docs/METHODOLOGY.md.
 */
import type { BrowserContext, Page } from 'playwright';
import type { Capture, CapturedRequest, Phase } from '@igris/core';

/** Bodies larger than this are truncated before detection (documented cap). */
export const BODY_CAP_BYTES = 512 * 1024;

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
  };
  private phase: Phase = 'pre-connect';

  setPhase(phase: Phase): void {
    this.phase = phase;
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
        }),
      );
      ws.on('framereceived', (frame) =>
        this.capture.wsFrames.push({
          phase: this.phase,
          url,
          direction: 'received',
          payload:
            typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8'),
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
