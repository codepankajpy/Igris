/**
 * Registry rows are untrusted (Arkiv is permissionless). These tests pin the
 * P0-4 guarantees: invalid rows are dropped and counted, never thrown; markup
 * cannot hide in typed fields; legacy (buggy) header data is discarded; and
 * unpublishable reports never become records.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringToHex } from 'viem';
import { RECIPIENT_CLASSES, type Report } from '@igris/core';
import { recordFromReport, UnpublishableReportError } from './from-report.js';
import { rawRowToCandidate } from './arkiv.js';
import { LocalRegistry } from './local.js';
import {
  KNOWN_LEAK_LOCATIONS,
  KNOWN_RECIPIENT_CLASSES,
  KNOWN_STATUSES,
  parseRegistryRecord,
  validateRecords,
} from './validate.js';
import type { RegistryRecord } from './record.js';

const KEY = '0x' + 'ab'.repeat(32);
const OWNER = '0x' + 'cd'.repeat(20);
const XSS = '<img src=x onerror=alert(1)>';

function report(overrides: Partial<Report> = {}): Report {
  return {
    reportVersion: '1.1.0',
    scannerVersion: '0.1.0',
    target: 'https://app.example.org/',
    hostname: 'app.example.org',
    scannedAt: '2026-11-06T06:00:00.000Z',
    chainId: 1,
    status: 'completed',
    coverage: 'full',
    canaryAddress: '0x8ba1f109551bd432803012645ac136ddd64dba72',
    spoofMetaMask: true,
    findings: [
      {
        id: 'f1',
        category: 'exact',
        encoding: 'base64(lowercase)',
        location: 'request-body',
        url: 'https://rpc.example.net/',
        method: 'POST',
        host: 'rpc.example.net',
        registrableDomain: 'example.net',
        class: 'rpc-provider',
        phase: 'post-connect',
        snippet: 'x<CANARY>y',
        countsTowardScore: true,
      },
    ],
    thirdParties: [
      {
        host: 'rpc.example.net',
        registrableDomain: 'example.net',
        class: 'rpc-provider',
        phases: ['post-connect'],
        requestCount: 2,
        methods: ['POST'],
      },
    ],
    readsViaWallet: [{ method: 'eth_chainId', count: 1 }],
    usesAnonRpc: false,
    score: 85,
    ledger: [
      {
        id: 'p1',
        label: 'address reached example.net (rpc-provider)',
        points: 15,
        rule: 'leak.rpc-provider',
        findingIds: ['f1'],
      },
    ],
    errors: [],
    summary: {
      totalRequests: 3,
      preConnectRequests: 1,
      postConnectRequests: 2,
      wsConnections: 1,
      wsFrames: 4,
      cookiesCount: 0,
      localStorageCount: 0,
      sessionStorageCount: 0,
    },
    securityHeaders: {
      documentUrl: 'https://app.example.org/',
      documentStatus: 200,
      cspPresent: true,
      cspReportOnly: false,
      hstsPresent: true,
    },
    ...overrides,
  };
}

function validRecord(): RegistryRecord {
  const r = report();
  return { ...recordFromReport(r, JSON.stringify(r)), id: KEY, scanner: OWNER };
}

/** Shape an SDK row the way @arkiv-network/sdk returns it. */
function sdkRow(rec: RegistryRecord, summaryHex?: string): Record<string, unknown> {
  const v = (value: unknown) => ({ value });
  return {
    $key: rec.id,
    $owner: rec.scanner,
    $expiresAt: 1234n,
    hostname: v(rec.hostname),
    score: v(rec.score),
    scannedAt: v(BigInt(rec.scannedAt)),
    leakCount: v(rec.leakCount),
    thirdPartyCount: v(rec.thirdPartyCount),
    usesAnonRpc: v(rec.usesAnonRpc),
    leakClasses: v(rec.leakClasses),
    scannerVersion: v(rec.scannerVersion),
    reportVersion: v(rec.reportVersion),
    chainId: v(rec.chainId),
    reportSha256: v(rec.reportSha256),
    summary: v(summaryHex ?? stringToHex(JSON.stringify(rec.summary))),
  };
}

describe('closed sets mirror @igris/core', () => {
  it('recipient classes, locations and statuses are identical', () => {
    expect([...KNOWN_RECIPIENT_CLASSES]).toEqual([...RECIPIENT_CLASSES]);
    expect([...KNOWN_STATUSES].sort()).toEqual(
      ['completed', 'page-load-failed', 'wallet-connect-failed'].sort(),
    );
    expect(KNOWN_LEAK_LOCATIONS).toContain('websocket-frame');
  });
});

describe('parseRegistryRecord — positive', () => {
  it('accepts a record built by recordFromReport (arkiv-shaped id/owner)', () => {
    const rec = validRecord();
    expect(parseRegistryRecord(rec, { source: 'arkiv' })).toEqual(rec);
  });

  it('accepts an SDK row via rawRowToCandidate, including bigint u64 values', () => {
    const rec = validRecord();
    const parsed = parseRegistryRecord(rawRowToCandidate(sdkRow(rec)), { source: 'arkiv' });
    expect(parsed.hostname).toBe('app.example.org');
    expect(parsed.scannedAt).toBe(rec.scannedAt);
    expect(parsed.expiresAt).toBe('block 1234');
    expect(parsed.summary.securityHeaders).toEqual({
      source: 'main-document',
      documentStatus: 200,
      cspPresent: true,
      cspReportOnly: false,
      hstsPresent: true,
    });
  });

  it('keeps free-text labels as text (renderers must still escape)', () => {
    const rec = validRecord();
    rec.summary.ledger[0]!.label = `label with ${XSS}`;
    const parsed = parseRegistryRecord(rec, { source: 'arkiv' });
    expect(parsed.summary.ledger[0]!.label).toContain('<img');
  });
});

describe('parseRegistryRecord — negative (hostile entities)', () => {
  const mutations: Array<[string, (r: RegistryRecord & Record<string, unknown>) => void]> = [
    [
      'markup in a numeric ledger field',
      (r) => ((r.summary.ledger[0] as { points: unknown }).points = XSS),
    ],
    [
      'markup in requestCount',
      (r) => ((r.summary.thirdParties[0] as { requestCount: unknown }).requestCount = XSS),
    ],
    [
      'markup in telemetry',
      (r) => ((r.summary.telemetry as { totalRequests: unknown }).totalRequests = XSS),
    ],
    ['markup in hostname', (r) => (r.hostname = `evil.org"><script>`)],
    ['markup in a finding host', (r) => (r.summary.findings[0]!.host = XSS)],
    ['unknown recipient class', (r) => (r.summary.findings[0]!.class = 'trusted-by-igris')],
    ['unknown leak class in attribute', (r) => (r.leakClasses = 'analytics,<b>x</b>')],
    ['score out of range', (r) => (r.score = 101)],
    ['non-integer score', (r) => (r.score = 50.5)],
    ['bad entity key', (r) => (r.id = 'scan-123')],
    ['bad owner', (r) => (r.scanner = 'local')],
    ['bad sha256', (r) => (r.reportSha256 = 'nothex')],
    [
      'oversized findings array',
      (r) => {
        r.summary.findings = Array.from({ length: 2001 }, () => r.summary.findings[0]!);
      },
    ],
    ['summary missing', (r) => delete (r as Record<string, unknown>).summary],
    ['summary not an object', (r) => ((r as Record<string, unknown>).summary = 'x')],
    ['bad canary address', (r) => (r.summary.canaryAddress = '0x123')],
    ['NaN points', (r) => (r.summary.ledger[0]!.points = Number.NaN)],
  ];
  for (const [name, mutate] of mutations) {
    it(`rejects: ${name}`, () => {
      const rec = structuredClone(validRecord()) as RegistryRecord & Record<string, unknown>;
      mutate(rec);
      expect(() => parseRegistryRecord(rec, { source: 'arkiv' })).toThrow(
        /invalid registry record/,
      );
    });
  }

  it('rawRowToCandidate never throws on garbage rows', () => {
    for (const row of [
      null,
      undefined,
      42,
      'x',
      {},
      { summary: { value: '0xzz' } },
      { score: {} },
    ]) {
      expect(() => rawRowToCandidate(row)).not.toThrow();
    }
  });

  it('a u64 beyond MAX_SAFE_INTEGER is rejected, not silently rounded', () => {
    const row = sdkRow(validRecord());
    row.scannedAt = { value: 2n ** 63n };
    expect(validateRecords([rawRowToCandidate(row)], { source: 'arkiv' }).dropped).toBe(1);
  });

  it('summary bytes that are not JSON drop the row', () => {
    const row = sdkRow(validRecord(), stringToHex('not json {'));
    expect(validateRecords([rawRowToCandidate(row)], { source: 'arkiv' }).dropped).toBe(1);
  });
});

describe('validateRecords', () => {
  it('keeps valid rows, drops and counts invalid ones, never throws', () => {
    const good = validRecord();
    const bad = { ...validRecord(), score: XSS };
    const out = validateRecords([good, bad, null, 7], { source: 'arkiv' });
    expect(out.records).toHaveLength(1);
    expect(out.dropped).toBe(3);
    expect(out.reasons[0]).toBe('score');
  });

  it('discards legacy security headers (computed from request headers before 1.1.0)', () => {
    const rec = validRecord();
    (rec.summary as { securityHeaders?: unknown }).securityHeaders = {
      cspPresent: false,
      hstsPresent: false,
    };
    const out = validateRecords([rec], { source: 'arkiv' });
    expect(out.records[0]!.summary.securityHeaders).toBeUndefined();
  });
});

describe('recordFromReport refuses unmeasured scans (P0-1)', () => {
  it('throws for page-load-failed with a null score', () => {
    const r = report({ status: 'page-load-failed', coverage: 'none', score: null, ledger: [] });
    expect(() => recordFromReport(r, JSON.stringify(r))).toThrow(UnpublishableReportError);
  });

  it('throws for a legacy 1.0.0 page-load-failed report that still carries score 100', () => {
    const r = report({ reportVersion: '1.0.0', status: 'page-load-failed', score: 100 });
    delete (r as Partial<Report>).coverage;
    expect(() => recordFromReport(r, JSON.stringify(r))).toThrow(UnpublishableReportError);
  });

  it('publishes a partial (wallet-connect-failed) scan with its coverage stated', () => {
    const r = report({ status: 'wallet-connect-failed', coverage: 'pre-connect-only' });
    expect(recordFromReport(r, JSON.stringify(r)).summary.coverage).toBe('pre-connect-only');
  });

  it('derives coverage for legacy 1.0.0 reports', () => {
    const r = report({ reportVersion: '1.0.0' });
    delete (r as Partial<Report>).coverage;
    expect(recordFromReport(r, JSON.stringify(r)).summary.coverage).toBe('full');
  });
});

describe('LocalRegistry treats its file as untrusted', () => {
  it('drops malformed rows instead of crashing the query', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'igris-validate-'));
    const path = join(dir, 'reg.json');
    const good = { ...validRecord(), id: 'local-app.example.org-1', scanner: 'local' };
    writeFileSync(
      path,
      JSON.stringify({ version: 1, records: [good, { ...good, hostname: XSS }, 'junk'] }),
    );
    const reg = new LocalRegistry(path);
    const rows = await reg.query({});
    expect(rows).toHaveLength(1);
    expect(reg.lastValidation.dropped).toBe(2);
  });
});
