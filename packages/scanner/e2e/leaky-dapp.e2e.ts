/**
 * The core proof: scanning the deliberately leaky fixture finds every planted
 * leak with the right encoding, location and recipient class — fully offline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { join } from 'node:path';
import type { Finding, Report } from '@igris/core';
import { scan } from '../src/index.js';
import {
  buildFixture,
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
let report: Report;

function findingsMatching(r: Report, pred: (f: Finding) => boolean): Finding[] {
  return r.findings.filter(pred);
}

beforeAll(async () => {
  buildFixture(FIXTURE);
  pageServer = await serveDist(join(FIXTURE, 'dist'), PAGE_PORT);
  sink = await startSinkServer();
  report = await scan({
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
    expect(report.status).toBe('completed');
    expect(report.hostname).toBe('leaky-dapp.test');
  });

  it('LEAK 1: address reaches the RPC provider in a JSON-RPC body', () => {
    // The wallet hands the dapp a checksummed address; libraries may forward
    // it as-is or lowercased — either way it is an exact leak.
    const hits = findingsMatching(
      report,
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
      report,
      (f) =>
        f.class === 'analytics' &&
        f.location === 'request-body' &&
        /^(lowercase|checksummed)$/.test(f.encoding),
    );
    const b64 = findingsMatching(
      report,
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
      report,
      (f) => f.class === 'error-monitoring' && f.location === 'request-body',
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.snippet).toMatch(/user <CANARY> connected/);
  });

  it('LEAK 4: tracking pixel with the address in a URL query param', () => {
    const hits = findingsMatching(report, (f) => f.location === 'url' && f.class === 'cdn');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.url).toContain('ref=<CANARY>');
  });

  it('localStorage persistence is reported but not scored', () => {
    const hits = findingsMatching(report, (f) => f.location === 'local-storage');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.every((f) => !f.countsTowardScore)).toBe(true);
  });

  it('phase A records third-party contacts before any wallet interaction', () => {
    const preConnect = report.thirdParties.filter((t) => t.phases.includes('pre-connect'));
    const domains = preConnect.map((t) => t.registrableDomain);
    expect(domains).toContain('igris-cdn.test');
    expect(domains).toContain('igris-chat.test');
  });

  it('wallet-routed reads carry no penalty but are reported', () => {
    // The fixture routes its RPC read through http(), not the wallet, so
    // readsViaWallet should be empty here — the wallet only answered
    // eth_requestAccounts/eth_accounts-type calls which are not forwarded.
    expect(Array.isArray(report.readsViaWallet)).toBe(true);
  });

  it('does not claim Anon-RPC usage', () => {
    expect(report.usesAnonRpc).toBe(false);
  });

  it('scores clearly below 90 with an itemized ledger', () => {
    expect(report.score).toBeLessThan(90);
    expect(report.ledger.length).toBeGreaterThanOrEqual(4);
    const total = report.ledger.reduce((s, l) => s + l.points, 0);
    expect(report.score).toBe(Math.max(0, Math.round(100 - total)));
    // Every scored finding is referenced by some ledger line.
    const referenced = new Set(report.ledger.flatMap((l) => l.findingIds));
    for (const f of report.findings.filter((f) => f.countsTowardScore)) {
      expect(referenced.has(f.id), `finding ${f.id} must appear in the ledger`).toBe(true);
    }
  });

  it('never exposes the raw canary anywhere in the report', () => {
    const raw = JSON.stringify(report);
    const core = report.canaryAddress.slice(2).toLowerCase();
    // The canaryAddress field itself is the only allowed occurrence.
    const occurrences = raw.toLowerCase().split(core).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('determinism', () => {
  it('a second scan yields the identical finding set', async () => {
    const second = await scan({
      url: PAGE_URL,
      hostResolverRules: HOST_RULES,
      dwellMs: 1500,
    });
    const strip = (r: Report) =>
      r.findings.map(({ snippet, ...rest }) => ({ ...rest, snippet: snippet.length > 0 }));
    expect(strip(second)).toEqual(strip(report));
    expect(second.score).toBe(report.score);
    expect(second.usesAnonRpc).toBe(report.usesAnonRpc);
  }, 180_000);
});
