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
  type CanaryForms,
  type Finding,
  type LeakLocation,
  type Phase,
  type Report,
  type ScanStatus,
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

  for (const req of input.capture.requests) {
    let host: string;
    try {
      host = new URL(req.url).hostname;
    } catch {
      continue; // data:, blob:, about: etc. never leave the machine
    }
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
      host = new URL(frame.url).hostname;
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
      host = new URL(req.url).hostname;
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
    };
    if (!existing.phases.includes(req.phase)) existing.phases.push(req.phase);
    existing.requestCount += 1;
    contacts.set(c.host, existing);
  }
  const thirdParties = [...contacts.values()].sort((a, b) => a.host.localeCompare(b.host));

  const { score, ledger } = scoreReport(findings, thirdParties);

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
    ledger,
    errors: input.errors,
  };
}
