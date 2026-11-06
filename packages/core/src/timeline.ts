/**
 * The scan timeline of report 3.0.0 (docs/design/REPORT-3.0.0.md): when each
 * recipient was first contacted, when it first received the address, the
 * scan milestones, and requests per second split first / third party.
 *
 * Volatile telemetry, like `telemetry`: built from the capture's optional
 * times (`CapturedRequest.t`, `CapturedWsFrame.t`, `Capture.milestones`);
 * the evidence bundle never contains times. Pure and deterministic.
 *
 *  - firstContactMs: min t of the recipient's requests and WebSocket frames;
 *  - firstAddressMs: min t of those that carried an exact or hashed form of
 *    the canary in a place the canary-leak detector searches (URL, request
 *    headers, body, Set-Cookie; frame payload) — the same texts, the same
 *    matcher, so it agrees with learned.address;
 *  - requestsPerSecond: dense 1 s buckets from t = 0 (at most 600), counting
 *    the requests the telemetry counts (http/https/ws/wss with a host, not
 *    refused by the egress proxy).
 */
import type { Classification } from './classify.js';
import type { CanaryForms } from './encodings.js';
import { findCanary } from './detect.js';
import { MILESTONE_EVENTS, type Capture } from './contracts/capture.js';
import {
  TIMELINE_MAX_MILESTONES,
  TIMELINE_MAX_SECONDS,
  type RecipientV3Class,
  type Timeline,
  type TimelineMilestone,
} from './contracts/report-v3.js';
import { requestTexts } from './detectors/canary-leak.js';

export interface TimelineOptions {
  /** The scan's classifier (the engine's, including redirect and RPC-by-behaviour rules). */
  classify(host: string): Pick<Classification, 'registrableDomain' | 'class'>;
  canary: CanaryForms;
  /** True when the egress proxy refused this URL (never sent). */
  wasBlocked?: (url: URL) => boolean;
  /** The report's recipients: the timeline has one entry per recipient, same order. */
  recipients: readonly { registrableDomain: string; class: RecipientV3Class }[];
}

const SCANNED_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const EVENT_ORDER = new Map<string, number>(MILESTONE_EVENTS.map((e, i) => [e, i]));

/** Integer ms ≥ 0, or undefined for a missing / non-finite time. */
function ms(t: number | undefined): number | undefined {
  return typeof t === 'number' && Number.isFinite(t) ? Math.max(0, Math.round(t)) : undefined;
}

function hasAddress(texts: Iterable<string | null>, forms: CanaryForms): boolean {
  for (const text of texts) {
    if (text && findCanary(text, forms).some((m) => m.category !== 'partial')) return true;
  }
  return false;
}

/** Null when the capture recorded no times at all. */
export function buildTimeline(capture: Capture, opts: TimelineOptions): Timeline | null {
  const timed =
    capture.requests.some((r) => ms(r.t) !== undefined) ||
    capture.wsFrames.some((f) => ms(f.t) !== undefined) ||
    (capture.milestones ?? []).some((m) => ms(m.t) !== undefined);
  if (!timed) return null;

  const firstContact = new Map<string, number>();
  const firstAddress = new Map<string, number>();
  const note = (map: Map<string, number>, key: string, t: number) => {
    const prev = map.get(key);
    if (prev === undefined || t < prev) map.set(key, t);
  };
  const buckets: Array<{ firstParty: number; thirdParty: number }> = [];
  const blocked = opts.wasBlocked ?? (() => false);

  for (const r of capture.requests) {
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }
    if (!SCANNED_PROTOCOLS.has(u.protocol) || !u.hostname || blocked(u)) continue;
    const t = ms(r.t);
    if (t === undefined) continue;
    const c = opts.classify(u.hostname);
    const second = Math.floor(t / 1000);
    if (second < TIMELINE_MAX_SECONDS) {
      for (let i = buckets.length; i <= second; i++) buckets.push({ firstParty: 0, thirdParty: 0 });
      buckets[second]![c.class === 'first-party' ? 'firstParty' : 'thirdParty'] += 1;
    }
    if (c.class === 'first-party') continue;
    const key = `${c.registrableDomain}|${c.class}`;
    note(firstContact, key, t);
    if (
      hasAddress(
        requestTexts(r).map(([, text]) => text),
        opts.canary,
      )
    )
      note(firstAddress, key, t);
  }

  for (const f of capture.wsFrames) {
    let u: URL;
    try {
      u = new URL(f.url);
    } catch {
      continue;
    }
    if (!u.hostname || blocked(u)) continue;
    const t = ms(f.t);
    if (t === undefined) continue;
    const c = opts.classify(u.hostname);
    if (c.class === 'first-party') continue;
    const key = `${c.registrableDomain}|${c.class}`;
    note(firstContact, key, t);
    if (hasAddress([f.payload], opts.canary)) note(firstAddress, key, t);
  }

  const milestones: TimelineMilestone[] = [];
  for (const m of capture.milestones ?? []) {
    const t = ms(m.t);
    if (t === undefined || !EVENT_ORDER.has(m.event)) continue;
    milestones.push({ event: m.event, t });
  }
  milestones.sort((a, b) => a.t - b.t || EVENT_ORDER.get(a.event)! - EVENT_ORDER.get(b.event)!);

  return {
    origin: 'navigation-start',
    milestones: milestones.slice(0, TIMELINE_MAX_MILESTONES),
    recipients: opts.recipients.map((r) => {
      const key = `${r.registrableDomain}|${r.class}`;
      return {
        registrableDomain: r.registrableDomain,
        class: r.class,
        firstContactMs: firstContact.get(key) ?? null,
        // Anon-RPC relaying the address is not an exposure (matches verdicts.ts).
        firstAddressMs: key.endsWith('|anon-rpc') ? null : (firstAddress.get(key) ?? null),
      };
    }),
    requestsPerSecond: buckets.map((b, i) => ({ t: i * 1000, ...b })),
  };
}
