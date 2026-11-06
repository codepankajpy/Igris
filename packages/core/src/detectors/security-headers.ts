/**
 * security-headers (security): protective response headers of the main
 * document. Observations only — they never affect the privacy score.
 *
 * Judged on the main document's final response in the pre-connect phase.
 * Nothing is emitted when no main document was observed or the page did not
 * load (absence of evidence is not evidence of absence).
 *
 * Checks:
 *  - CSP: absent (risk, medium) / report-only only (risk, low). Without an
 *    enforced CSP, any injected or compromised script — e.g. a hijacked
 *    third-party dependency — runs with full access to the wallet session.
 *  - Framing: neither X-Frame-Options DENY/SAMEORIGIN nor CSP
 *    frame-ancestors (risk, medium): clickjacking of connect/sign buttons.
 *  - Transport: https without HSTS (risk, low); plain http on a non-local
 *    host (issue, high).
 */
import type { CapturedMainDocument } from '../contracts/capture.js';
import type { Detector, DraftFinding } from '../contracts/detector.js';
import {
  DOCUMENT_HEADER_NAMES,
  MAX_HEADER_VALUE,
  type DocumentHeadersEvidence,
} from '../contracts/evidence.js';

export const SECURITY_HEADERS_DETECTOR_ID = 'security-headers';
export const SECURITY_HEADERS_DETECTOR_VERSION = '1.0.0';

export function documentHeadersEvidence(doc: CapturedMainDocument): DocumentHeadersEvidence {
  const pick = (name: string): string | null => {
    const v = doc.headers[name];
    return v === undefined ? null : v.slice(0, MAX_HEADER_VALUE);
  };
  const headers = Object.fromEntries(
    DOCUMENT_HEADER_NAMES.map((n) => [n, pick(n)]),
  ) as DocumentHeadersEvidence['headers'];
  return { type: 'document-headers', documentUrl: doc.url, status: doc.status, headers };
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h.endsWith('.localhost') ||
    h.endsWith('.test') ||
    h.endsWith('.local')
  );
}

/** Pure check over one evidence item (shared with migration). */
export function securityHeaderDrafts(e: DocumentHeadersEvidence): DraftFinding[] {
  const drafts: DraftFinding[] = [];
  const base = { confidence: 'confirmed' as const, evidence: [e], countsTowardPrivacyScore: false };
  const csp = e.headers['content-security-policy'];
  const cspRo = e.headers['content-security-policy-report-only'];
  const xfo = e.headers['x-frame-options']?.trim().toUpperCase() ?? null;
  const hsts = e.headers['strict-transport-security'];

  if (csp === null) {
    drafts.push(
      cspRo !== null
        ? {
            ...base,
            fingerprintInput: { check: 'csp-report-only' },
            kind: 'risk',
            severity: 'low',
            title: 'Content-Security-Policy is report-only (not enforced)',
            impact:
              'Violations are reported but not blocked, so an injected or compromised script still runs with full access to the page and its wallet connection.',
            remediation:
              'Promote the report-only policy to an enforced Content-Security-Policy once it is clean.',
          }
        : {
            ...base,
            fingerprintInput: { check: 'csp-missing' },
            kind: 'risk',
            severity: 'medium',
            title: 'No Content-Security-Policy on the main document',
            impact:
              'Any injected or compromised script — for example a hijacked third-party dependency — runs with full access to the page, including the wallet connection, and can request signatures or transactions.',
            remediation:
              "Serve a Content-Security-Policy that restricts script-src to your own origin plus nonces or hashes, without 'unsafe-inline'.",
          },
    );
  }

  const frameAncestors = csp !== null && /(^|;)\s*frame-ancestors\s/i.test(csp);
  if (!frameAncestors && xfo !== 'DENY' && xfo !== 'SAMEORIGIN') {
    drafts.push({
      ...base,
      fingerprintInput: { check: 'framing-allowed' },
      kind: 'risk',
      severity: 'medium',
      title: 'Page can be embedded by any site (clickjacking)',
      impact:
        'Another site can load this dapp in an invisible frame and trick users into clicking connect, approve or sign controls.',
      remediation:
        "Send `Content-Security-Policy: frame-ancestors 'self'` (or `X-Frame-Options: DENY`).",
    });
  }

  let url: URL | null = null;
  try {
    url = new URL(e.documentUrl);
  } catch {
    url = null;
  }
  if (url?.protocol === 'https:' && hsts === null) {
    drafts.push({
      ...base,
      fingerprintInput: { check: 'hsts-missing' },
      kind: 'risk',
      severity: 'low',
      title: 'No Strict-Transport-Security header',
      impact:
        'A visitor’s first plain-HTTP request can be intercepted and downgraded on hostile networks before the redirect to HTTPS.',
      remediation: 'Send `Strict-Transport-Security: max-age=31536000; includeSubDomains`.',
    });
  }
  if (url?.protocol === 'http:' && !isLocalHost(url.hostname)) {
    drafts.push({
      ...base,
      fingerprintInput: { check: 'plain-http' },
      kind: 'issue',
      severity: 'high',
      title: 'Main document served over plain HTTP',
      impact:
        'Anyone on the network path can read and modify the page, including injecting a script that asks the wallet to sign or send.',
      remediation: 'Serve the dapp only over HTTPS and redirect HTTP to HTTPS.',
    });
  }
  // Always record what was observed, so "all headers present" is evidenced
  // too and distinguishable from "no main document seen".
  const state = [
    csp !== null ? 'CSP enforced' : cspRo !== null ? 'CSP report-only' : 'no CSP',
    frameAncestors || xfo === 'DENY' || xfo === 'SAMEORIGIN'
      ? 'framing restricted'
      : 'framing allowed',
    url?.protocol === 'https:' ? (hsts !== null ? 'HSTS' : 'no HSTS') : 'plain HTTP',
  ].join(', ');
  drafts.push({
    ...base,
    fingerprintInput: { check: 'summary' },
    kind: 'observation',
    severity: 'info',
    title: `Main-document security headers: ${state}`,
    impact: 'Reference record of the protective headers the main document was served with.',
    remediation: 'None by itself; see the individual header findings, if any.',
  });
  return drafts;
}

export const securityHeadersDetector: Detector = {
  id: SECURITY_HEADERS_DETECTOR_ID,
  version: SECURITY_HEADERS_DETECTOR_VERSION,
  domain: 'security',
  run: (capture, ctx) => {
    if (ctx.coverage === 'none' || !capture.mainDocument) return [];
    return securityHeaderDrafts(documentHeadersEvidence(capture.mainDocument));
  },
};
