/**
 * Capture v1: the raw, scanner-produced record of one scan that detectors
 * consume. It is the input of the detector pipeline, NOT a published
 * artifact: it contains unredacted traffic, including the canary address.
 * Detectors turn it into redacted evidence (evidence.ts).
 *
 * Defined in core (not the scanner) so detectors are pure functions that can
 * be tested without a browser.
 */
import type { Phase } from '../report.js';

export const CAPTURE_VERSION = 1 as const;

export interface CapturedRequest {
  phase: Phase;
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Request body, truncated at the scanner's body cap. */
  body: string | null;
  resourceType: string;
  failed: boolean;
  /** Set-Cookie headers observed on the response. */
  setCookies: string[];
  /** ms since navigation start when the request was issued (timeline only; never evidence). */
  t?: number;
}

export interface CapturedWsFrame {
  phase: Phase;
  url: string;
  direction: 'sent' | 'received';
  payload: string;
  /** ms since navigation start (timeline only; never evidence). */
  t?: number;
}

export interface CapturedStorage {
  phase: Phase;
  kind: 'local-storage' | 'session-storage';
  key: string;
  value: string;
}

export interface CapturedCookie {
  phase: Phase;
  name: string;
  value: string;
  domain: string;
}

/**
 * The main document's final (non-redirect) response during the pre-connect
 * phase. Header names lower-cased; repeated headers joined with ", ".
 */
export interface CapturedMainDocument {
  url: string;
  status: number;
  headers: Record<string, string>;
}

export interface Capture {
  requests: CapturedRequest[];
  wsFrames: CapturedWsFrame[];
  /** Distinct WebSocket connections opened by the page. */
  wsConnections: number;
  storage: CapturedStorage[];
  cookies: CapturedCookie[];
  /** Undefined when no main-document response was observed. */
  mainDocument?: CapturedMainDocument;
  /** Scan milestones, ms since navigation start (timeline only). */
  milestones?: CapturedMilestone[];
}

export const MILESTONE_EVENTS = [
  'page-loaded',
  'connect-started',
  'accounts-requested',
  'connect-finished',
  'observation-ended',
] as const;
export type MilestoneEvent = (typeof MILESTONE_EVENTS)[number];

export interface CapturedMilestone {
  event: MilestoneEvent;
  t: number;
}
