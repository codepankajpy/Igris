/**
 * Turn raw capture into the versioned Report.
 *
 * Determinism rule: findings are deduplicated by
 * (phase, location, method, host, path, encoding) and sorted before IDs are
 * assigned, so two scans of the same page yield the same finding set even
 * when a tracker retries or reorders its requests (the e2e suite asserts
 * this). Timestamps are the only nondeterministic field.
 */
import {
  buildCanaryForms,
  classifyHost,
  countsTowardScore,
  findCanary,
  redactSnippet,
  registrableDomain,
  scoreReport,
  REPORT_VERSION,
  coverageForStatus,
  type CanaryForms,
  type Finding,
  type LeakLocation,
  type Phase,
  type Report,
  type ScanStatus,
  type SecurityHeaders,
  type ThirdPartyContact,
  type ThirdPartyEntry,
} from '@igris/core';
import type { Capture } from './capture.js';
import type { WalletReadHandler } from './stub-rpc.js';

export interface BuildReportInput {
  target: string;
  canaryAddress: string;
  chainId: number;
  spoofMetaMask: boolean;
  scannerVersion: string;
  scannedAt: string;
  status: ScanStatus;
  capture: Capture;
  readHandler: WalletReadHandler;
  thirdPartyDb: ThirdPartyEntry[];
  firstParty?: string[];
  errors: string[];
}

type RawFinding = Omit<Finding, 'id'>;

function redactText(text: string, forms: CanaryForms): string {
  let out = text;
  for (let m = findCanary(out, forms)[0]; m; m = findCanary(out, forms)[0]) {
    out = out.slice(0, m.index) + '<CANARY>' + out.slice(m.index + m.length);
  }
  return out;
}

export function buildReport(input: BuildReportInput): Report {
  const forms = buildCanaryForms(input.canaryAddress);
  const targetUrl = new URL(input.target);
  const targetRd = registrableDomain(targetUrl.hostname);
  const classifyOpts = {
    targetRegistrableDomain: targetRd,
    db: input.thirdPartyDb,
    ...(input.firstParty ? { firstParty: input.firstParty } : {}),
  };

  const raw: RawFinding[] = [];

  const scanText = (
    text: string | null | undefined,
    location: LeakLocation,
    meta: { url: string; method: string; host: string; phase: Phase },
  ) => {
    if (!text) return;
    const c = classifyHost(meta.host, classifyOpts);
    for (const match of findCanary(text, forms)) {
      const finding: RawFinding = {
        category: match.category,
        encoding: match.encoding,
        location,
        url: redactText(meta.url, forms),
        method: meta.method,
        host: c.host,
        registrableDomain: c.registrableDomain,
        class: c.class,
        phase: meta.phase,
        snippet: redactSnippet(text, match, forms),
        countsTowardScore: false, // set after classification below
      };
      finding.countsTowardScore = match.category !== 'partial' && countsTowardScore(finding);
      raw.push(finding);
    }
  };

  let preConnectRequests = 0;
  let postConnectRequests = 0;

  for (const req of input.capture.requests) {
    let host: string;
    try {
      const u = new URL(req.url);
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) continue;
      host = u.hostname;
      if (!host) continue;
    } catch {
      continue; // data:, blob:, about: etc. never leave the machine
    }

    if (req.phase === 'pre-connect') preConnectRequests++;
    else postConnectRequests++;

    const meta = { url: req.url, method: req.method, host, phase: req.phase };
    scanText(req.url, 'url', meta);
    for (const [name, value] of Object.entries(req.headers)) {
      scanText(`${name}: ${value}`, 'request-header', meta);
    }
    scanText(req.body, 'request-body', meta);
    for (const sc of req.setCookies) scanText(sc, 'response-set-cookie', meta);
  }

  for (const frame of input.capture.wsFrames) {
    let host: string;
    try {
      const u = new URL(frame.url);
      host = u.hostname;
      if (!host) continue;
    } catch {
      continue;
    }
    scanText(frame.payload, 'websocket-frame', {
      url: frame.url,
      method: 'WS',
      host,
      phase: frame.phase,
    });
  }

  // Cookies/storage: persisted locally — reported (survives reloads), not scored.
  for (const cookie of input.capture.cookies) {
    scanText(`${cookie.name}=${cookie.value}`, 'cookie', {
      url: `cookie://${cookie.domain}`,
      method: '-',
      host: cookie.domain.replace(/^\./, ''),
      phase: cookie.phase,
    });
  }
  for (const item of input.capture.storage) {
    scanText(`${item.key}=${item.value}`, item.kind, {
      url: `${item.kind}://${targetUrl.hostname}/${redactText(item.key, forms)}`,
      method: '-',
      host: targetUrl.hostname,
      phase: item.phase,
    });
  }

  // Deduplicate: a tracker that retries five times is one finding. The key
  // uses the URL path without query (query strings often carry nonces).
  const keyOf = (f: RawFinding) => {
    let path = f.url;
    try {
      const u = new URL(f.url);
      path = `${u.hostname}${u.pathname}`;
    } catch {
      /* keep raw */
    }
    return [f.phase, f.location, f.method, f.host, path, f.encoding].join('|');
  };
  const deduped = new Map<string, RawFinding>();
  for (const f of raw) if (!deduped.has(keyOf(f))) deduped.set(keyOf(f), f);

  const sorted = [...deduped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, f]) => f);
  const findings: Finding[] = sorted.map((f, i) => ({ id: `f${i + 1}`, ...f }));

  // Third-party contacts per phase (IP exposure), including hosts that never
  // saw the canary.
  const contacts = new Map<string, ThirdPartyContact>();
  for (const req of input.capture.requests) {
    let host: string;
    try {
      const u = new URL(req.url);
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) continue;
      host = u.hostname;
      if (!host) continue;
    } catch {
      continue;
    }
    const c = classifyHost(host, classifyOpts);
    if (c.class === 'first-party') continue;
    const existing = contacts.get(c.host) ?? {
      host: c.host,
      registrableDomain: c.registrableDomain,
      class: c.class,
      phases: [],
      requestCount: 0,
      methods: [],
      resourceTypes: [],
    };
    if (!existing.phases.includes(req.phase)) existing.phases.push(req.phase);
    if (req.method && !existing.methods?.includes(req.method)) {
      existing.methods?.push(req.method);
    }
    if (req.resourceType && !existing.resourceTypes?.includes(req.resourceType)) {
      existing.resourceTypes?.push(req.resourceType);
    }
    existing.requestCount += 1;
    contacts.set(c.host, existing);
  }
  const thirdParties = [...contacts.values()].sort((a, b) => a.host.localeCompare(b.host));

  // Nothing was measured when the page never loaded: no score, no ledger.
  // (A score of 100 here would claim "nothing detectable" about a page we
  // never saw.)
  const coverage = coverageForStatus(input.status);
  const { score, ledger } =
    coverage === 'none' ? { score: null, ledger: [] } : scoreReport(findings, thirdParties);

  const securityHeaders = securityHeadersFromCapture(input.capture);

  const connectionLog = input.errors.filter((e) => e.startsWith('connect: '));

  return {
    reportVersion: REPORT_VERSION,
    scannerVersion: input.scannerVersion,
    target: input.target,
    hostname: targetUrl.hostname,
    scannedAt: input.scannedAt,
    chainId: input.chainId,
    status: input.status,
    canaryAddress: input.canaryAddress,
    spoofMetaMask: input.spoofMetaMask,
    findings,
    thirdParties,
    readsViaWallet: input.readHandler.summary(),
    usesAnonRpc: input.readHandler.anonRpcBootstrapSeen,
    score,
    coverage,
    ledger,
    errors: input.errors,
    summary: {
      totalRequests: preConnectRequests + postConnectRequests,
      preConnectRequests,
      postConnectRequests,
      wsConnections: input.capture.wsConnections,
      wsFrames: input.capture.wsFrames.length,
      cookiesCount: input.capture.cookies.length,
      localStorageCount: input.capture.storage.filter((s) => s.kind === 'local-storage').length,
      sessionStorageCount: input.capture.storage.filter((s) => s.kind === 'session-storage').length,
    },
    ...(securityHeaders ? { securityHeaders } : {}),
    connectionLog,
  };
}

/**
 * Security headers from the main document's final response only. Request
 * headers never carry these (they are response headers), and subresource
 * responses describe other documents. No observed main document → undefined
 * ("unknown"), never "missing".
 */
export function securityHeadersFromCapture(capture: Capture): SecurityHeaders | undefined {
  const doc = capture.mainDocument;
  if (!doc) return undefined;
  const h = doc.headers;
  const xfo = h['x-frame-options'];
  return {
    documentUrl: doc.url,
    documentStatus: doc.status,
    cspPresent: h['content-security-policy'] !== undefined,
    cspReportOnly: h['content-security-policy-report-only'] !== undefined,
    hstsPresent: h['strict-transport-security'] !== undefined,
    ...(xfo !== undefined ? { xFrameOptions: xfo } : {}),
  };
}
