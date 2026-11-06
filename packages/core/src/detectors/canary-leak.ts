/**
 * canary-leak (privacy): the scan's throwaway canary address observed in
 * captured traffic, cookies or storage. Because the canary never existed
 * before the scan, a match is proof that the destination received it.
 *
 * Ported from the v1 report builder; detection, dedup and "counts toward
 * score" semantics are unchanged (migration tests assert score equality).
 * One finding per (phase, location, method, host, path, encoding) — the v1
 * dedup key, now the finding's identity.
 */
import { findCanary, redactSnippet } from '../detect.js';
import type { CanaryForms } from '../encodings.js';
import type { LeakLocation, Phase, RecipientClass } from '../report.js';
import { countsTowardScore } from '../scoring.js';
import type { Capture } from '../contracts/capture.js';
import type { Detector, DetectorContext, DraftFinding } from '../contracts/detector.js';
import type { CanaryMatchEvidence } from '../contracts/evidence.js';
import type { Confidence, FindingKind, Severity } from '../contracts/report-v2.js';

export const CANARY_LEAK_DETECTOR_ID = 'canary-leak';
export const CANARY_LEAK_DETECTOR_VERSION = '1.0.0';

/** Replace every canary occurrence in `text` with <CANARY>. */
export function redactText(text: string, forms: CanaryForms): string {
  let out = text;
  for (let m = findCanary(out, forms)[0]; m; m = findCanary(out, forms)[0]) {
    out = out.slice(0, m.index) + '<CANARY>' + out.slice(m.index + m.length);
  }
  return out;
}

const HIGH: ReadonlySet<RecipientClass> = new Set([
  'analytics',
  'error-monitoring',
  'support-chat',
  'unknown-third-party',
]);

const IMPACT: Record<RecipientClass, string> = {
  'rpc-provider':
    'The RPC provider can link this wallet address to the visitor’s IP address and request timing for every read, building a record of who controls which address.',
  'walletconnect-relay':
    'The relay operator can link the wallet address to the visitor’s IP address.',
  analytics:
    'An analytics vendor now holds the wallet address alongside the visitor’s IP, device and behaviour — a durable identity-to-address link outside the dapp’s control.',
  'error-monitoring':
    'The wallet address lands in a third-party error-tracking store (breadcrumbs, request context), usually retained long-term together with IP and device data.',
  'support-chat':
    'A support/chat vendor — which typically also collects names and emails — receives the wallet address with the visitor’s IP.',
  'ipfs-gateway':
    'A gateway operator receives the wallet address with the visitor’s IP although serving content does not require it.',
  cdn: 'A CDN receives the wallet address with the visitor’s IP although serving assets does not require it.',
  'unknown-third-party':
    'An unclassified third party receives the wallet address with the visitor’s IP; nobody can audit what it does with it.',
  'first-party':
    'The dapp’s own servers receive the address. Expected for most dapps; what happens server-side is not observable by this scan.',
  'anon-rpc':
    'The address travels through Anon-RPC, which hides the visitor’s IP from the RPC provider.',
};

const REMEDIATION: Record<RecipientClass, string> = {
  'rpc-provider':
    'Route RPC reads through Anon-RPC (`igris fix <repo>` rewrites viem / ethers / wagmi transports), or let the user’s wallet perform reads via EIP-1193.',
  'walletconnect-relay':
    'Avoid putting the address in relay metadata; if a relay is required, document the exposure or operate the relay yourself.',
  analytics:
    'Stop sending the wallet address to analytics: allowlist event properties, scrub URLs and identify() calls, or remove the SDK.',
  'error-monitoring':
    'Scrub wallet addresses before events leave the page (e.g. Sentry `beforeSend` / `beforeBreadcrumb`), including URLs and request bodies.',
  'support-chat':
    'Do not pass the wallet address to the chat widget’s user/identify API; load the widget only after explicit user action.',
  'ipfs-gateway':
    'Remove the address from gateway URLs or requests; it is not needed to fetch content.',
  cdn: 'Remove the address from asset URLs and requests; it is not needed to serve assets.',
  'unknown-third-party':
    'Identify this recipient and remove the data flow; if it is necessary, disclose it and minimise what is sent.',
  'first-party': 'No action required for the scan’s purposes; minimise what your servers log.',
  'anon-rpc': 'No action required.',
};

function lower(sev: Severity): Severity {
  return sev === 'high' ? 'medium' : sev === 'medium' ? 'low' : sev;
}

interface Classified {
  kind: FindingKind;
  severity: Severity;
  confidence: Confidence;
  title: string;
  impact: string;
  remediation: string;
}

function classifyMatch(e: CanaryMatchEvidence, counted: boolean): Classified {
  const where = `${e.registrableDomain} (${e.recipientClass})`;
  if (
    e.location === 'cookie' ||
    e.location === 'local-storage' ||
    e.location === 'session-storage'
  ) {
    return {
      kind: 'observation',
      severity: 'info',
      confidence: e.category === 'partial' ? 'possible' : 'confirmed',
      title: `Wallet address persisted in ${e.location} (${e.host})`,
      impact:
        'The address persists in browser storage and survives reloads; any script running on that origin can read it. No third party received it through this channel.',
      remediation: 'Store only what the app needs and clear it on disconnect.',
    };
  }
  if (e.category === 'partial') {
    return {
      kind: 'risk',
      severity: 'low',
      confidence: 'possible',
      title: `Possible truncated wallet address sent to ${where}`,
      impact:
        'A shortened display form of the address (first 6 + last 4 characters) was sent. On its own it is ambiguous, but combined with other data it can narrow down the address.',
      remediation: REMEDIATION[e.recipientClass],
    };
  }
  if (!counted) {
    return {
      kind: 'observation',
      severity: 'info',
      confidence: 'confirmed',
      title:
        e.recipientClass === 'anon-rpc'
          ? `Wallet address sent through Anon-RPC (${e.host})`
          : `Wallet address sent to the dapp’s own domain (${e.host})`,
      impact: IMPACT[e.recipientClass],
      remediation: REMEDIATION[e.recipientClass],
    };
  }
  const base: Severity = HIGH.has(e.recipientClass) ? 'high' : 'medium';
  if (e.category === 'hashed') {
    return {
      kind: 'issue',
      severity: lower(base),
      confidence: 'confirmed',
      title: `Hashed wallet address sent to ${where}`,
      impact: `${IMPACT[e.recipientClass]} Hashing does not anonymise an address: anyone can hash candidate addresses and join the data.`,
      remediation: REMEDIATION[e.recipientClass],
    };
  }
  return {
    kind: 'issue',
    severity: base,
    confidence: 'confirmed',
    title: `Wallet address sent to ${where}`,
    impact: IMPACT[e.recipientClass],
    remediation: REMEDIATION[e.recipientClass],
  };
}

const SCANNED_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

function run(capture: Capture, ctx: DetectorContext): DraftFinding[] {
  const forms = ctx.canary;
  const out = new Map<string, DraftFinding>();

  const scanText = (
    text: string | null | undefined,
    location: LeakLocation,
    meta: { url: string; method: string; host: string; phase: Phase },
  ) => {
    if (!text) return;
    const c = ctx.classify(meta.host);
    for (const match of findCanary(text, forms)) {
      const url = redactText(meta.url, forms);
      let path = url;
      try {
        const u = new URL(url);
        path = `${u.hostname}${u.pathname}`;
      } catch {
        /* cookie:// and storage pseudo-URLs keep the raw form */
      }
      const identity = {
        phase: meta.phase,
        location,
        method: meta.method,
        host: c.host,
        path,
        encoding: match.encoding,
      };
      const key = JSON.stringify(identity);
      if (out.has(key)) continue; // a retrying tracker is one finding (first occurrence kept)
      const evidence: CanaryMatchEvidence = {
        type: 'canary-match',
        phase: meta.phase,
        location,
        method: meta.method,
        url,
        host: c.host,
        registrableDomain: c.registrableDomain,
        recipientClass: c.class,
        encoding: match.encoding,
        category: match.category,
        snippet: redactSnippet(text, match, forms),
      };
      const counted =
        match.category !== 'partial' &&
        countsTowardScore({ category: match.category, location, class: c.class });
      out.set(key, canaryLeakDraftFromEvidence(evidence, counted, identity));
    }
  };

  for (const req of capture.requests) {
    let u: URL;
    try {
      u = new URL(req.url);
    } catch {
      continue; // data:, blob:, about: never leave the machine
    }
    if (!SCANNED_PROTOCOLS.has(u.protocol) || !u.hostname || ctx.wasBlocked(u)) continue;
    const meta = { url: req.url, method: req.method, host: u.hostname, phase: req.phase };
    scanText(req.url, 'url', meta);
    for (const [name, value] of Object.entries(req.headers)) {
      scanText(`${name}: ${value}`, 'request-header', meta);
    }
    scanText(req.body, 'request-body', meta);
    for (const sc of req.setCookies) scanText(sc, 'response-set-cookie', meta);
  }

  for (const frame of capture.wsFrames) {
    let u: URL;
    try {
      u = new URL(frame.url);
    } catch {
      continue;
    }
    if (!u.hostname || ctx.wasBlocked(u)) continue;
    scanText(frame.payload, 'websocket-frame', {
      url: frame.url,
      method: 'WS',
      host: u.hostname,
      phase: frame.phase,
    });
  }

  for (const cookie of capture.cookies) {
    scanText(`${cookie.name}=${cookie.value}`, 'cookie', {
      url: `cookie://${cookie.domain}`,
      method: '-',
      host: cookie.domain.replace(/^\./, ''),
      phase: cookie.phase,
    });
  }
  for (const item of capture.storage) {
    scanText(`${item.key}=${item.value}`, item.kind, {
      url: `${item.kind}://${ctx.target.hostname}/${redactText(item.key, forms)}`,
      method: '-',
      host: ctx.target.hostname,
      phase: item.phase,
    });
  }

  return [...out.values()];
}

export const canaryLeakDetector: Detector = {
  id: CANARY_LEAK_DETECTOR_ID,
  version: CANARY_LEAK_DETECTOR_VERSION,
  domain: 'privacy',
  run,
};

/** Exposed for the v1→v2 migration: the same classification of a v1 finding. */
export function canaryLeakDraftFromEvidence(
  evidence: CanaryMatchEvidence,
  counted: boolean,
  identity: Record<string, string>,
): DraftFinding {
  return {
    fingerprintInput: identity,
    ...classifyMatch(evidence, counted),
    evidence: [evidence],
    countsTowardPrivacyScore: counted,
  };
}
