import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '@igris/core';
import { req, sampleCapture, sampleResult } from '@igris/core/testing';
import { recordFromReport, UnpublishableReportError } from './from-report.js';
import { LocalRegistry } from './local.js';
import { ArkivRegistry } from './arkiv.js';
import { matchesQuery, type RegistryRecord } from './record.js';

const leaky = () => sampleResult();
const clean = () =>
  sampleResult({
    target: 'https://clean.example.org/',
    scannedAt: '2026-11-07T06:00:00.000Z',
    wallet: { readsViaWallet: [{ method: 'eth_call', count: 1 }], usesAnonRpc: true },
    capture: {
      ...sampleCapture(),
      requests: [req({ url: 'https://clean.example.org/' })],
      storage: [],
      mainDocument: { url: 'https://clean.example.org/', status: 200, headers: {} },
    },
  });

describe('recordFromReport (Report v2 + bundle)', () => {
  const { report, bundle } = leaky();
  const record = recordFromReport(report, bundle);

  it('maps the queryable attributes from the v2 report', () => {
    expect(record.hostname).toBe('app.example.org');
    expect(record.score).toBe(report.privacy.score);
    expect(record.reportVersion).toBe('2.1.0');
    expect(record.leakClasses).toBe('analytics,error-monitoring,rpc-provider');
    expect(record.leakCount).toBe(3); // counted canary findings only (storage excluded)
    expect(record.thirdPartyCount).toBe(report.contacts.length);
  });

  it('carries content hashes of the report and the evidence bundle', () => {
    expect(record.reportSha256).toBe(contentHash(report));
    expect(record.summary.evidenceSha256).toBe(report.evidence.sha256);
    expect(record.summary.v).toBe(2);
  });

  it('summary carries no URLs, no snippets, no canary-bearing text', () => {
    const raw = JSON.stringify(record.summary);
    expect(raw).not.toContain('http://');
    expect(raw).not.toContain('https://');
    expect(raw).not.toContain('snippet');
    expect(raw).not.toContain('<CANARY>');
  });

  it('security headers come from the document-headers evidence', () => {
    expect(record.summary.securityHeaders).toEqual({
      source: 'main-document',
      documentStatus: 200,
      cspPresent: false,
      cspReportOnly: false,
      hstsPresent: false,
    });
  });

  it('refuses a report whose evidence does not match (tampered bundle)', () => {
    const tampered = structuredClone(bundle);
    const k = Object.keys(tampered.items)[0]!;
    (tampered.items[k] as { host?: string }).host = 'elsewhere.example';
    expect(() => recordFromReport(report, tampered)).toThrow(/evidence does not match/);
  });

  it('refuses an unmeasured scan', () => {
    const failed = sampleResult({ status: 'page-load-failed' });
    expect(() => recordFromReport(failed.report, failed.bundle)).toThrow(UnpublishableReportError);
  });

  it('publishes a partial scan with its coverage stated', () => {
    const partial = sampleResult({ status: 'wallet-connect-failed' });
    expect(recordFromReport(partial.report, partial.bundle).summary.coverage).toBe(
      'pre-connect-only',
    );
  });
});

describe('LocalRegistry', () => {
  it('publish/query round-trip with every filter', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'igris-reg-')), 'registry.json');
    const reg = new LocalRegistry(path);
    const a = leaky();
    const b = clean();
    await reg.publish(recordFromReport(a.report, a.bundle));
    await reg.publish(recordFromReport(b.report, b.bundle));

    expect(await reg.query({})).toHaveLength(2);
    expect(await reg.query({ hostname: 'app.example.org' })).toHaveLength(1);
    expect((await reg.query({ minScore: 90 }))[0]!.hostname).toBe('clean.example.org');
    expect(await reg.query({ maxScore: 90 })).toHaveLength(1);
    expect((await reg.query({ leakClass: 'rpc-provider' }))[0]!.hostname).toBe('app.example.org');
    expect(await reg.query({ since: '2026-11-07T00:00:00Z' })).toHaveLength(1);
    expect((await reg.query({ usesAnonRpc: true }))[0]!.hostname).toBe('clean.example.org');
    expect(await reg.query({ scanner: 'local' })).toHaveLength(2);
    expect(await reg.query({ scanner: '0xsomeoneelse' })).toHaveLength(0);
    expect(await reg.query({ limit: 1 })).toHaveLength(1);
    expect((await reg.query({}))[0]!.hostname).toBe('clean.example.org'); // newest first
    expect(await reg.snapshot()).toHaveLength(2);
    expect(reg.lastValidation.dropped).toBe(0);
  });
});

describe('matchesQuery', () => {
  const base = leaky();
  const rec: RegistryRecord = {
    ...recordFromReport(base.report, base.bundle),
    id: 'x',
    scanner: '0xAbC0000000000000000000000000000000000001',
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
    const { report, bundle } = leaky();
    await expect(reg.publish(recordFromReport(report, bundle))).rejects.toThrow(
      /scanner key|igris scanner init|--registry local/,
    );
  });
});
