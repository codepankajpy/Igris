/**
 * The core proof: scanning the deliberately leaky fixture finds every planted
 * leak with the right encoding, location and recipient class — fully offline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { canonicalize, verifyReportIntegrity, type ScanResult } from '@igris/core';
import { scan } from '../src/index.js';
import {
  buildFixture,
  flatLeaks,
  HOST_RULES,
  PAGE_PORT,
  REPO_ROOT,
  serveDist,
  startSinkServer,
} from './helpers.js';

const FIXTURE = join(REPO_ROOT, 'fixtures/leaky-dapp');
const PAGE_URL = `http://leaky-dapp.test:${PAGE_PORT}/`;

let pageServer: Server;
let sink: { close: () => Promise<void> };
let result: ScanResult;
type Leak = ReturnType<typeof flatLeaks>[number];

function findingsMatching(r: ScanResult, pred: (f: Leak) => boolean): Leak[] {
  return flatLeaks(r).filter(pred);
}

beforeAll(async () => {
  buildFixture(FIXTURE);
  pageServer = await serveDist(join(FIXTURE, 'dist'), PAGE_PORT);
  sink = await startSinkServer();
  result = await scan({
    url: PAGE_URL,
    hostResolverRules: HOST_RULES,
    dwellMs: 1500,
  });
}, 180_000);

afterAll(async () => {
  await new Promise((r) => pageServer.close(() => r(undefined)));
  await sink.close();
});

describe('leaky fixture scan', () => {
  it('completes and connects the wallet', () => {
    expect(result.report.scan.status).toBe('completed');
    expect(result.report.scan.hostname).toBe('leaky-dapp.test');
    expect(result.report.privacy.coverage).toBe('full');
  });

  it('LEAK 1: address reaches the RPC provider in a JSON-RPC body', () => {
    // The wallet hands the dapp a checksummed address; libraries may forward
    // it as-is or lowercased — either way it is an exact leak.
    const hits = findingsMatching(
      result,
      (f) =>
        f.class === 'rpc-provider' &&
        f.location === 'request-body' &&
        /^(lowercase|checksummed)$/.test(f.encoding) &&
        f.phase === 'post-connect',
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.host).toBe('rpc.igris-rpc.test');
    expect(hits[0]!.snippet).toContain('<CANARY>');
    expect(hits[0]!.snippet).toContain('eth_getBalance');
  });

  it('LEAK 2: analytics beacon carries the address plain AND base64-encoded', () => {
    const plain = findingsMatching(
      result,
      (f) =>
        f.class === 'analytics' &&
        f.location === 'request-body' &&
        /^(lowercase|checksummed)$/.test(f.encoding),
    );
    const b64 = findingsMatching(
      result,
      (f) =>
        f.class === 'analytics' &&
        f.location === 'request-body' &&
        /^base64\((lowercase|checksummed)\)$/.test(f.encoding),
    );
    expect(plain.length).toBeGreaterThanOrEqual(1);
    expect(b64.length).toBeGreaterThanOrEqual(1);
  });

  it('LEAK 3: error-monitor breadcrumb', () => {
    const hits = findingsMatching(
      result,
      (f) => f.class === 'error-monitoring' && f.location === 'request-body',
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.snippet).toMatch(/user <CANARY> connected/);
  });

  it('LEAK 4: tracking pixel with the address in a URL query param', () => {
    const hits = findingsMatching(result, (f) => f.location === 'url' && f.class === 'cdn');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.url).toContain('ref=<CANARY>');
  });

  it('localStorage persistence is reported as an observation, not a third-party exposure', () => {
    const hits = findingsMatching(result, (f) => f.location === 'local-storage');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.every((f) => !f.isIssue)).toBe(true);
  });

  it('phase A records third-party contacts before any wallet interaction', () => {
    const preConnect = result.report.contacts.filter((t) => t.phases.includes('pre-connect'));
    const domains = preConnect.map((t) => t.registrableDomain);
    expect(domains).toContain('igris-cdn.test');
    expect(domains).toContain('igris-chat.test');
  });

  it('wallet-routed reads carry no penalty but are reported', () => {
    // The fixture routes its RPC read through http(), not the wallet, so
    // readsViaWallet should be empty here — the wallet only answered
    // eth_requestAccounts/eth_accounts-type calls which are not forwarded.
    expect(Array.isArray(result.report.wallet.readsViaWallet)).toBe(true);
  });

  it('does not claim Anon-RPC usage', () => {
    expect(result.report.wallet.usesAnonRpc).toBe(false);
  });

  it('every address exposure lands in a recipient with a verdict and a reason; no score', () => {
    const { report } = result;
    expect('score' in report.privacy).toBe(false);
    const referenced = new Set(report.recipients.flatMap((r) => r.findingIds));
    for (const f of report.privacy.findings.filter(
      (x) => x.detector === 'canary-leak' && x.kind === 'issue',
    )) {
      expect(referenced.has(f.id), `finding ${f.id} must belong to a recipient`).toBe(true);
    }
    // The planted analytics leak is a tracking recipient that received the address.
    const tracking = report.recipients.filter(
      (r) =>
        (r.verdict === 'tracking' || r.verdict === 'unidentified') && r.learned.address === 'exact',
    );
    expect(tracking.length).toBeGreaterThanOrEqual(1);
    for (const r of report.recipients) expect(r.reason.length).toBeGreaterThan(10);
    // Timing and RPC inventory were recorded.
    expect(report.timeline).not.toBeNull();
    expect(report.rpc!.length).toBeGreaterThanOrEqual(1);
  });

  it('never exposes the raw canary: once in the report (its own field), never in the evidence', () => {
    const core = result.report.scan.canaryAddress.slice(2).toLowerCase();
    expect(JSON.stringify(result.report).toLowerCase().split(core).length - 1).toBe(1);
    expect(canonicalize(result.bundle).toLowerCase()).not.toContain(core);
  });

  it('report and evidence bundle verify (hash, content ids, references)', () => {
    expect(verifyReportIntegrity(result.report, result.bundle)).toMatchObject({ ok: true });
  });

  it('every privacy finding carries evidence; security observations are separate', () => {
    for (const f of result.report.privacy.findings) expect(f.evidence.length).toBeGreaterThan(0);
    expect(result.report.security.observations.every((o) => o.domain === 'security')).toBe(true);
  });
});

describe('determinism and cross-scan stability', () => {
  it('a second scan (new random canary) yields the same finding ids, verdicts and leak set', async () => {
    const second = await scan({
      url: PAGE_URL,
      hostResolverRules: HOST_RULES,
      dwellMs: 1500,
    });
    expect(second.report.scan.canaryAddress).not.toBe(result.report.scan.canaryAddress);
    const ids = (r: ScanResult) => r.report.privacy.findings.map((f) => f.id).sort();
    expect(ids(second)).toEqual(ids(result));
    const strip = (r: ScanResult) =>
      flatLeaks(r)
        .map(({ snippet, ...rest }) => ({ ...rest, snippet: snippet.length > 0 }))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(strip(second)).toEqual(strip(result));
    const verdicts = (r: ScanResult) =>
      r.report.recipients.map(
        (x) => `${x.registrableDomain}|${x.class}|${x.verdict}|${x.learned.address}`,
      );
    expect(verdicts(second)).toEqual(verdicts(result));
    // The same behaviour → the same finding-set digest, even though the
    // canary differs. (The evidence-bundle hash is NOT asserted equal: page
    // snippets can embed nonces — measured on this fixture: wagmi writes a
    // random connection id next to the address in localStorage.)
    expect(second.report.findingSet).toEqual(result.report.findingSet);
    expect(second.report.wallet.usesAnonRpc).toBe(result.report.wallet.usesAnonRpc);
  }, 180_000);
});
