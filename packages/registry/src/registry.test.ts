import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Report } from '@igris/core';
import { recordFromReport, sha256Hex } from './from-report.js';
import { LocalRegistry } from './local.js';
import { ArkivRegistry } from './arkiv.js';
import { matchesQuery, type RegistryRecord } from './record.js';

function sampleReport(overrides: Partial<Report> = {}): Report {
  return {
    reportVersion: '1.0.0',
    scannerVersion: '0.1.0',
    target: 'http://leaky-dapp.test:38546/',
    hostname: 'leaky-dapp.test',
    scannedAt: '2026-11-06T06:00:00.000Z',
    chainId: 1,
    status: 'completed',
    canaryAddress: '0x8ba1f109551bd432803012645ac136ddd64dba72',
    spoofMetaMask: true,
    findings: [
      {
        id: 'f1',
        category: 'exact',
        encoding: 'lowercase',
        location: 'request-body',
        url: 'http://rpc.igris-rpc.test:38545/',
        method: 'POST',
        host: 'rpc.igris-rpc.test',
        registrableDomain: 'igris-rpc.test',
        class: 'rpc-provider',
        phase: 'post-connect',
        snippet: 'x<CANARY>y',
        countsTowardScore: true,
      },
      {
        id: 'f2',
        category: 'exact',
        encoding: 'lowercase',
        location: 'local-storage',
        url: 'local-storage://leaky-dapp.test/k',
        method: '-',
        host: 'leaky-dapp.test',
        registrableDomain: 'leaky-dapp.test',
        class: 'first-party',
        phase: 'post-connect',
        snippet: 'k=<CANARY>',
        countsTowardScore: false,
      },
    ],
    thirdParties: [
      {
        host: 'rpc.igris-rpc.test',
        registrableDomain: 'igris-rpc.test',
        class: 'rpc-provider',
        phases: ['post-connect'],
        requestCount: 2,
      },
    ],
    readsViaWallet: [],
    usesAnonRpc: false,
    score: 82,
    ledger: [
      {
        id: 'p1',
        label: 'address reached igris-rpc.test (rpc-provider)',
        points: 15,
        rule: 'leak.rpc-provider',
        findingIds: ['f1'],
      },
    ],
    errors: [],
    ...overrides,
  };
}

describe('recordFromReport', () => {
  const report = sampleReport();
  const json = JSON.stringify(report, null, 2);
  const record = recordFromReport(report, json);

  it('maps the queryable attributes', () => {
    expect(record.hostname).toBe('leaky-dapp.test');
    expect(record.score).toBe(82);
    expect(record.scannedAt).toBe(Math.floor(Date.parse(report.scannedAt) / 1000));
    expect(record.leakCount).toBe(1); // only counted findings
    expect(record.leakClasses).toBe('rpc-provider');
    expect(record.thirdPartyCount).toBe(1);
  });

  it('hashes the exact report bytes', () => {
    expect(record.reportSha256).toBe(createHash('sha256').update(json).digest('hex'));
    expect(sha256Hex(json)).toBe(record.reportSha256);
  });

  it('summary carries no URLs and no snippets', () => {
    const raw = JSON.stringify(record.summary);
    expect(raw).not.toContain('http://');
    expect(raw).not.toContain('https://');
    expect(raw).not.toContain('snippet');
    expect(raw).not.toContain('<CANARY>');
  });
});

describe('LocalRegistry', () => {
  it('publish/query round-trip with every filter', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'igris-reg-')), 'registry.json');
    const reg = new LocalRegistry(path);

    const r1 = sampleReport();
    const r2 = sampleReport({
      hostname: 'clean-dapp.test',
      score: 97,
      usesAnonRpc: true,
      findings: [],
      ledger: [],
      scannedAt: '2026-11-07T06:00:00.000Z',
    });
    await reg.publish(recordFromReport(r1, JSON.stringify(r1)));
    await reg.publish(recordFromReport(r2, JSON.stringify(r2)));

    expect(await reg.query({})).toHaveLength(2);
    expect(await reg.query({ hostname: 'leaky-dapp.test' })).toHaveLength(1);
    expect((await reg.query({ minScore: 90 }))[0]!.hostname).toBe('clean-dapp.test');
    expect(await reg.query({ maxScore: 90 })).toHaveLength(1);
    expect((await reg.query({ leakClass: 'rpc-provider' }))[0]!.hostname).toBe('leaky-dapp.test');
    expect(await reg.query({ since: '2026-11-07T00:00:00Z' })).toHaveLength(1);
    expect((await reg.query({ usesAnonRpc: true }))[0]!.hostname).toBe('clean-dapp.test');
    expect(await reg.query({ scanner: 'local' })).toHaveLength(2);
    expect(await reg.query({ scanner: '0xsomeoneelse' })).toHaveLength(0);
    expect(await reg.query({ limit: 1 })).toHaveLength(1);
    // newest first
    expect((await reg.query({}))[0]!.hostname).toBe('clean-dapp.test');
    // snapshot returns everything
    expect(await reg.snapshot()).toHaveLength(2);
  });
});

describe('matchesQuery', () => {
  const rec: RegistryRecord = {
    id: 'x',
    scanner: '0xAbC0000000000000000000000000000000000001',
    hostname: 'a.test',
    score: 50,
    scannedAt: 1_790_000_000,
    scannerVersion: '0.1.0',
    reportVersion: '1.0.0',
    chainId: 1,
    thirdPartyCount: 2,
    leakCount: 1,
    leakClasses: 'analytics,rpc-provider',
    usesAnonRpc: false,
    reportSha256: 'ab',
    summary: {
      v: 1,
      status: 'completed',
      spoofMetaMask: true,
      canaryAddress: '0x',
      findings: [],
      thirdParties: [],
      ledger: [],
      readsViaWallet: [],
    },
  };
  it('leakClass matches whole class names only', () => {
    expect(matchesQuery(rec, { leakClass: 'analytics' })).toBe(true);
    expect(matchesQuery(rec, { leakClass: 'rpc' })).toBe(false);
  });
  it('scanner comparison is case-insensitive', () => {
    expect(matchesQuery(rec, { scanner: rec.scanner.toLowerCase() })).toBe(true);
  });
});

describe('ArkivRegistry (offline behaviour)', () => {
  it('publish without a key explains what to do', async () => {
    const reg = new ArkivRegistry({});
    const report = sampleReport();
    await expect(reg.publish(recordFromReport(report, '{}'))).rejects.toThrow(
      /ARKIV_PRIVATE_KEY|--registry local/,
    );
  });
});
