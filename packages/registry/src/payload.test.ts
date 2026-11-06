import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { buildCanaryForms, bundleHash, canonicalize, contentHash } from '@igris/core';
import { sampleResultV2 } from '@igris/core/testing';
import {
  buildPublication,
  decodePayload,
  encodePayload,
  MAX_PAYLOAD_BYTES,
  PayloadError,
  toWireAttributes,
  withVersion,
} from './payload.js';
import { PublishRefusedError } from './site-registry.js';
import { EvidenceSchema, FlowSchema, ScanSchema } from './schemas.js';
import { LOCAL_FORMAT, parseFlowRow, parseScanRow } from './rows.js';
import { IPV6_RECIPIENT, leaky, withIpv6Recipient } from './test-fixtures.js';
import * as registryIndex from './index.js';

describe('payload codec', () => {
  it('gzip of canonical JSON round-trips (bytes and hex)', () => {
    const value = { b: [1, 2, { z: 'é' }], a: null };
    const gz = encodePayload(value);
    expect(gz[0]).toBe(0x1f); // gzip magic
    expect(decodePayload(gz)).toEqual(value);
    const hex = `0x${Buffer.from(gz).toString('hex')}`;
    expect(decodePayload(hex)).toEqual(value);
    // canonical: key order does not change the bytes
    expect(Buffer.from(encodePayload({ a: null, b: [1, 2, { z: 'é' }] }))).toEqual(Buffer.from(gz));
  });

  it('refuses payloads over the limit after compression, never truncates', () => {
    const big = { noise: randomBytes(200_000).toString('base64') };
    expect(() => encodePayload(big, 'report')).toThrow(PublishRefusedError);
    expect(() => encodePayload(big, 'report')).toThrow(/report is \d+ bytes after gzip/);
  });

  it('rejects hostile payloads on read', () => {
    expect(() => decodePayload('0xzz')).toThrow(PayloadError);
    expect(() => decodePayload('0x0102')).toThrow(/not valid gzip/);
    expect(() => decodePayload(new Uint8Array(MAX_PAYLOAD_BYTES + 1))).toThrow(
      /over the payload limit/,
    );
    expect(() => decodePayload(new Uint8Array(gzipSync('not json')))).toThrow(/not JSON/);
    // decompression bomb: 64 MiB of zeros compresses to ~64 KiB
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 }));
    expect(bomb.byteLength).toBeLessThan(MAX_PAYLOAD_BYTES);
    expect(() => decodePayload(bomb)).toThrow(PayloadError);
  });
});

describe('buildPublication', () => {
  const { report, bundle } = leaky();
  const pub = buildPublication(report, bundle);

  it('computes the scan attributes from the report', () => {
    expect(pub.hostname).toBe('app.example.org');
    expect(pub.scan).toMatchObject({
      hostname: 'app.example.org',
      scannedAt: Date.parse('2026-11-06T00:00:00.000Z') / 1000,
      scanId: contentHash(report),
      evidenceSha256: bundleHash(bundle),
      findingSetSha256: report.findingSet.sha256,
      state: 'address-to-trackers',
      coverage: 'full',
      recipients: 4,
      addressRecipients: 3, // segment (exact), sentry (hashed), infura (exact)
      trackingRecipients: 2, // segment, sentry
      usesAnonRpc: false,
      scannerVersion: 'test',
      reportVersion: '3.0.0',
    });
    expect(decodePayload(pub.scan.report)).toEqual(JSON.parse(canonicalize(report)));
    expect(pub.evidence).toMatchObject({
      sha256: bundleHash(bundle),
      scanId: contentHash(report),
      bundleVersion: 'igris.evidence.v3',
    });
    expect(decodePayload(pub.evidence.bundle)).toEqual(JSON.parse(canonicalize(bundle)));
  });

  it('one flow per recipient', () => {
    expect(
      pub.flows.map((f) => [f.recipient, f.class, f.verdict, f.address, f.preConnect]),
    ).toEqual([
      ['segment.io', 'analytics', 'tracking', 'exact', false],
      ['sentry.io', 'error-monitoring', 'tracking', 'hashed', false],
      ['infura.io', 'rpc-provider', 'avoidable', 'exact', false],
      ['googleapis.com', 'cdn', 'expected', 'none', true],
    ]);
    for (const f of pub.flows)
      expect(f).toMatchObject({ hostname: 'app.example.org', scanId: pub.scan.scanId });
  });

  it('the evidence payload carries no form of the canary', () => {
    const text = JSON.stringify(decodePayload(pub.evidence.bundle));
    const forms = buildCanaryForms(report.scan.canaryAddress);
    expect(text.toLowerCase()).not.toContain(forms.coreLower);
    for (const v of forms.variants) {
      if (v.caseInsensitive) expect(text.toLowerCase()).not.toContain(v.value.toLowerCase());
      else expect(text).not.toContain(v.value);
    }
  });

  it('writes every schema column plus the schema tag (wire form)', () => {
    const v = withVersion(pub, 2, `local:${'a'.repeat(64)}`);
    const scanAttrs = toWireAttributes(ScanSchema, v.scan);
    expect(scanAttrs.map((a) => a.name)).toEqual([
      'arkiv.schema',
      ...Object.keys(ScanSchema.columns),
    ]);
    expect(scanAttrs.find((a) => a.name === 'scannedAt')).toEqual({
      name: 'scannedAt',
      type: 'u64',
      value: String(v.scan.scannedAt),
    });
    expect(scanAttrs.find((a) => a.name === 'report')?.value).toMatch(/^0x1f8b/);
    expect(toWireAttributes(EvidenceSchema, v.evidence).map((a) => a.name)).toEqual([
      'arkiv.schema',
      'sha256',
      'scanId',
      'bundleVersion',
      'bundle',
    ]);
    const scan = parseScanRow(
      {
        key: `local:${'b'.repeat(64)}`,
        owner: 'me',
        creator: 'me',
        expiresAt: null,
        attributes: scanAttrs,
      },
      LOCAL_FORMAT,
    );
    expect(scan).toMatchObject({ version: 2, previous: `local:${'a'.repeat(64)}`, recipients: 4 });
    const flow = parseFlowRow(
      {
        key: `local:${'c'.repeat(64)}`,
        owner: 'me',
        creator: 'me',
        expiresAt: null,
        attributes: toWireAttributes(FlowSchema, v.flows[0]!),
      },
      LOCAL_FORMAT,
    );
    expect(flow).toMatchObject({ recipient: 'segment.io', version: 2, verdict: 'tracking' });
  });

  it('refuses what must not be published', () => {
    const v2 = sampleResultV2();
    expect(() => buildPublication(v2.report as never, v2.bundle)).toThrow(/only Report 3.0.0/);
    const tampered = structuredClone(report);
    tampered.recipients[0]!.verdict = 'expected';
    expect(() => buildPublication(tampered, bundle)).toThrow(/integrity/);
    const huge = structuredClone(report);
    huge.scan.notes = [randomBytes(200_000).toString('base64')];
    expect(() => buildPublication(huge, bundle)).toThrow(/after gzip/);
  });
});

describe('recipients whose domain is not a hostname (IP literals)', () => {
  it('publishes scan + evidence and omits only that flow', () => {
    const { report, bundle } = withIpv6Recipient();
    expect(report.recipients.map((r) => r.registrableDomain)).toContain(IPV6_RECIPIENT);
    const pub = buildPublication(report, bundle); // used to throw PublishRefusedError
    expect(pub.unindexedRecipients).toEqual([IPV6_RECIPIENT]);
    expect(pub.scan.recipients).toBe(report.recipients.length); // still counted
    expect(pub.flows.map((f) => f.recipient)).not.toContain(IPV6_RECIPIENT);
    expect(pub.flows).toHaveLength(report.recipients.length - 1);
    // the full report (with the IPv6 recipient) is the published payload
    const stored = decodePayload(pub.scan.report) as {
      recipients: Array<{ registrableDomain: string }>;
    };
    expect(stored.recipients.map((r) => r.registrableDomain)).toContain(IPV6_RECIPIENT);
    expect(leaky().report.recipients).toHaveLength(4);
    expect(buildPublication(leaky().report, leaky().bundle).unindexedRecipients).toEqual([]);
  });
});

describe('package exports', () => {
  it('exports isHostname for callers that validate before scanning', () => {
    expect(typeof registryIndex.isHostname).toBe('function');
    expect(registryIndex.isHostname('app.example.org')).toBe(true);
    expect(registryIndex.isHostname(IPV6_RECIPIENT)).toBe(false);
    expect(registryIndex.isHostname('localhost')).toBe(false);
    expect(registryIndex.isHostname('APP.example.org')).toBe(false);
  });
});
