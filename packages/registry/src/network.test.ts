/**
 * Decoded wallet requests (igris.walletreq.v1, docs/design/WALLET-REQUESTS.md),
 * draft 3.0.0 versions, and igris.scan.v2 rows of an earlier release that
 * carry a `request` attribute. One parity suite runs against both backends
 * (Arkiv through a fake node, and the local file); backend-specific checks
 * (batch contents, query strings, gas) follow.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExpirationTime } from '@arkiv-network/sdk';
import { bytesToHex, getAddress, keccak256, toHex } from 'viem';
import { contentHash, type ReportV3 } from '@igris/core';
import { CANARY_A } from '@igris/core/testing';
import { ArkivSiteRegistry } from './arkiv.js';
import { estimateBatchGas, MAX_TRANSACTION_GAS } from './gas.js';
import { LOCAL_FILE_FORMAT, LocalSiteRegistry } from './local.js';
import {
  MAX_WALLET_REQUEST_ENTITIES,
  buildPublication,
  encodePayload,
  walletRequestTier,
  walletRequestValues,
  withVersion,
  type WireEntity,
} from './payload.js';
import { ScanSchema, WalletRequestSchema, EvidenceSchema, FlowSchema } from './schemas.js';
import { ARKIV_FORMAT, LOCAL_FORMAT, parseScanRow } from './rows.js';
import { PublishRefusedError, type SiteRegistry } from './site-registry.js';
import {
  FakeNode,
  PERMIT2,
  SPENDER,
  asDraftV3,
  capturedApprove,
  fixedSegment,
  leaky,
  otherSite,
  sampleCapturedWalletRequests,
  scanner,
  walletSummary,
  withWalletRequests,
  type Create,
} from './test-fixtures.js';
import { DRAFT_V3_NOTE, ScanLoadError } from './verify.js';

/*
 * Every scan with wallet requests here is built by core's engine from
 * captured wallet requests (test-fixtures: captured*), so its
 * walletRequests summaries and igris.evidence.v4 items are real and pass
 * verifyReportIntegrity unmodified — nothing in core is mocked.
 */

const HOST = 'app.example.org';
const T0 = 1_793_923_200; // 2026-11-06T00:00:00Z

interface Harness {
  name: 'arkiv' | 'local';
  reg: SiteRegistry;
  /** Raw stored entities (Arkiv wire shape). */
  entities(): WireEntity[];
  /** Store an entity as a hostile writer would. */
  add(e: WireEntity): void;
  /** Replace the stored entities. */
  set(es: WireEntity[]): void;
  /** A well-formed entity key nobody has used. */
  freshKey(seed: string): string;
  /** A creator the registry does not trust (as stored). */
  mallory: string;
  /** The trusted publisher (as stored). */
  publisherId: string;
  /** A registry with no publisher and the given trusted owners. */
  reader(trusted: string[]): SiteRegistry;
  /** How the backend writes the readonly flag of a published entity. */
  readonlyFlags(): number[];
}

function arkivHarness(): Harness {
  const s = scanner();
  const node = new FakeNode(s.address);
  const reg = new ArkivSiteRegistry({ scanner: s, io: node.io });
  return {
    name: 'arkiv',
    reg,
    entities: () => node.entities,
    add: (e) => node.entities.push(e),
    set: (es) => (node.entities = es),
    freshKey: (seed) => keccak256(toHex(`fresh-${seed}`)),
    mallory: '0x000000000000000000000000000000000000dead',
    publisherId: s.address.toLowerCase(),
    reader: (trusted) =>
      new ArkivSiteRegistry({ scanner: null, io: node.io, trustedOwners: trusted }),
    readonlyFlags: () => node.entities.map((e) => e.creationFlags ?? -1),
  };
}

function localHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'igris-net-'));
  const file = join(dir, 'registry.json');
  const read = (): WireEntity[] => {
    try {
      return (JSON.parse(readFileSync(file, 'utf8')) as { entities: WireEntity[] }).entities;
    } catch {
      return [];
    }
  };
  const write = (es: WireEntity[]) =>
    writeFileSync(file, JSON.stringify({ format: LOCAL_FILE_FORMAT, entities: es }));
  return {
    name: 'local',
    reg: new LocalSiteRegistry({ file, publisher: 'igris-test' }),
    entities: read,
    add: (e) => write([...read(), e]),
    set: write,
    freshKey: (seed) => `local:${keccak256(toHex(`fresh-${seed}`)).slice(2)}`,
    mallory: 'mallory',
    publisherId: 'igris-test',
    reader: (trusted) => new LocalSiteRegistry({ file, publisher: null, trustedOwners: trusted }),
    readonlyFlags: () => read().map((e) => e.creationFlags ?? -1),
  };
}

const attr = (e: WireEntity, name: string) => e.attributes.find((a) => a.name === name);
const schemaOf = (e: WireEntity) => attr(e, 'arkiv.schema')?.value;
function clone(h: Harness, e: WireEntity, seed: string, over: (c: WireEntity) => void): WireEntity {
  const c = structuredClone(e);
  c.key = h.freshKey(seed);
  over(c);
  return c;
}
const setAttr = (e: WireEntity, name: string, value: unknown) => {
  attr(e, name)!.value = value;
};

/** `e` with a `request` str attribute, as an earlier multi-node release wrote it. */
const withRequestAttr = (e: WireEntity, value: unknown): WireEntity => ({
  ...structuredClone(e),
  attributes: [...e.attributes, { name: 'request', type: 'str', value }],
});

describe.each([
  ['arkiv', arkivHarness],
  ['local', localHarness],
] as const)('%s registry: igris.scan.v2 rows carrying a request attribute', (_name, make) => {
  it('a publish writes no request attribute', async () => {
    const h = make();
    const a = leaky();
    const v1 = await h.reg.publish(a.report, a.bundle);
    expect(
      attr(
        h.entities().find((e) => e.key === v1.scan.key)!,
        'request',
      ),
    ).toBeUndefined();
    expect(v1.scan).not.toHaveProperty('request');
    expect(Object.keys(ScanSchema.columns)).not.toContain('request');
  });

  it('live rows with request "" or an entity key still load verified; the attribute is ignored', async () => {
    const h = make();
    const a = leaky();
    const v1 = await h.reg.publish(a.report, a.bundle);
    const b = fixedSegment();
    const v2 = await h.reg.publish(b.report, b.bundle);
    h.set(
      h
        .entities()
        .map((e) =>
          e.key === v1.scan.key
            ? withRequestAttr(e, '')
            : e.key === v2.scan.key
              ? withRequestAttr(e, keccak256(toHex('an old request')))
              : e,
        ),
    );
    const versions = await h.reg.versions(HOST);
    expect(versions.map((s) => [s.key, s.version])).toEqual([
      [v2.scan.key, 2],
      [v1.scan.key, 1],
    ]);
    for (const s of versions) {
      expect(s).not.toHaveProperty('request');
      expect((await h.reg.load(s)).verified).toBe(true);
    }
    expect(await h.reg.byKey(v2.scan.key)).toMatchObject({ version: 2, previous: v1.scan.key });
    expect(await h.reg.findByScanId(HOST, v1.scan.scanId)).toMatchObject({ key: v1.scan.key });
    expect((await h.reg.recentSites()).map((s) => s.key)).toEqual([v2.scan.key]);
    // a retest still becomes the next version, linked to the old row
    const c = leaky('2026-11-07T00:00:00.000Z');
    const v3 = await h.reg.publish(c.report, c.bundle);
    expect(v3.scan).toMatchObject({ version: 3, previous: v2.scan.key });
  });

  it('the decoder accepts and ignores any request value (the node may return unselected attributes)', async () => {
    const h = make();
    const a = leaky();
    const v1 = await h.reg.publish(a.report, a.bundle);
    const stored = h.entities().find((e) => e.key === v1.scan.key)!;
    const format = h.name === 'arkiv' ? ARKIV_FORMAT : LOCAL_FORMAT;
    const plain = parseScanRow(stored, format);
    expect(plain).not.toBeNull();
    for (const value of ['', keccak256(toHex('req')), 'junk', 42]) {
      expect(parseScanRow(withRequestAttr(stored, value), format), String(value)).toEqual(plain);
    }
  });
});

describe.each([
  ['arkiv', arkivHarness],
  ['local', localHarness],
] as const)('%s registry: draft 3.0.0 versions (before wallet-request auditing)', (_name, make) => {
  /**
   * Publish the leaky sample, then make its scan + evidence entities carry
   * the DRAFT payloads, exactly like the versions on Arkiv published before
   * walletRequests existed (uniswap v1–v3, swap.cow.fi v1–v2, relay.link v1).
   */
  async function publishDraft(
    h: Harness,
    edit: { report?: (r: Record<string, unknown>) => void; bundleVersionAttr?: string } = {},
  ) {
    const r = leaky();
    const res = await h.reg.publish(r.report, r.bundle);
    const d = asDraftV3(r);
    const scanId = contentHash(d.report);
    const evidenceSha256 = contentHash(d.bundle);
    const stored = structuredClone(d.report);
    edit.report?.(stored); // a tampered payload under the original attributes
    h.set(
      h.entities().map((e) => {
        const c = structuredClone(e);
        if (e.key === res.scan.key) {
          setAttr(c, 'report', bytesToHex(encodePayload(stored)));
          setAttr(c, 'scanId', scanId);
          setAttr(c, 'evidenceSha256', evidenceSha256);
        }
        if (e.key === res.evidenceKey) {
          setAttr(c, 'bundle', bytesToHex(encodePayload(d.bundle)));
          setAttr(c, 'sha256', evidenceSha256);
          setAttr(c, 'scanId', scanId);
          setAttr(c, 'bundleVersion', edit.bundleVersionAttr ?? 'igris.evidence.v3');
        }
        return c;
      }),
    );
    const [scan] = await h.reg.versions(HOST);
    return { d, scanId, scan: scan! };
  }

  it('loads verified: hashes of the published bytes, upgraded for display, with a note', async () => {
    const h = make();
    const { d, scanId, scan } = await publishDraft(h);
    expect(scan).toMatchObject({ scanId, reportVersion: '3.0.0' });
    const loaded = await h.reg.load(scan);
    expect(loaded.problems).toEqual([DRAFT_V3_NOTE]);
    expect(loaded.verified).toBe(true);
    expect(loaded.report.walletRequests).toBeNull(); // not recorded
    expect(loaded.bundle.bundleVersion).toBe('igris.evidence.v4');
    expect(loaded.bundle.items).toEqual((d.bundle as { items: unknown }).items);
    expect(loaded.report.findingSet).toEqual(d.report.findingSet);
    expect(loaded.report.recipients).toEqual(leaky().report.recipients);
    // what the entity attests to is the ORIGINAL draft, not the upgraded copy
    expect(contentHash(loaded.report)).not.toBe(scanId);
  });

  it('a draft whose bytes do not match its entity is refused, never upgraded', async () => {
    const tampered = make();
    const t = await publishDraft(tampered, {
      report: (r) => {
        (r.scan as { notes: string[] }).notes.push('edited after publishing');
      },
    });
    await expect(tampered.reg.load(t.scan)).rejects.toThrow(ScanLoadError);
    await expect(tampered.reg.load(t.scan)).rejects.toThrow(/does not match its entity/);

    const relabelled = make();
    const l = await publishDraft(relabelled, { bundleVersionAttr: 'igris.evidence.v4' });
    await expect(relabelled.reg.load(l.scan)).rejects.toThrow(
      /evidence entity says igris\.evidence\.v4, bundle is igris\.evidence\.v3/,
    );
  });
});

describe.each([
  ['arkiv', arkivHarness],
  ['local', localHarness],
] as const)('%s registry: wallet requests', (_name, make) => {
  it('publishes one readonly igris.walletreq.v1 per request except connect', async () => {
    const h = make();
    const a = leaky(undefined, sampleCapturedWalletRequests());
    const res = await h.reg.publish(a.report, a.bundle);
    const wr = h.entities().filter((e) => schemaOf(e) === 'igris.walletreq.v1');
    expect(wr).toHaveLength(2);
    expect(res.walletRequestKeys).toEqual(wr.map((e) => e.key));
    expect(h.readonlyFlags().every((f) => f === 1)).toBe(true); // every published entity readonly
    const values = (e: WireEntity) =>
      Object.fromEntries(e.attributes.map((x) => [x.name, [x.type, x.value]]));
    const scannedAt = h.name === 'arkiv' ? toHex(1793923200) : '1793923200';
    expect(values(wr[0]!)).toEqual({
      'arkiv.schema': ['str', 'igris.walletreq.v1'],
      hostname: ['str', HOST],
      kind: ['str', 'permit2'],
      method: ['str', 'eth_signTypedData_v4'],
      outcome: ['str', 'signed'],
      unlimited: ['i32', 1],
      chainIdMismatch: ['i32', 1],
      domainMismatch: ['i32', 0],
      preConnect: ['i32', 0],
      verifyingContract: ['str', PERMIT2],
      spender: ['str', SPENDER],
      version: ['i32', 1],
      scanId: ['str', res.scan.scanId],
      scannedAt: ['u64', scannedAt],
    });
    expect(values(wr[1]!)).toMatchObject({
      kind: ['str', 'siwe'],
      domainMismatch: ['i32', 1],
      unlimited: ['i32', 0],
      verifyingContract: ['str', ''],
      spender: ['str', ''],
    });
    expect((await h.reg.load(res.scan)).verified).toBe(true);

    // idempotent: the same report again writes nothing and returns the same keys
    const n = h.entities().length;
    const again = await h.reg.publish(a.report, a.bundle);
    expect(again.walletRequestKeys).toEqual(res.walletRequestKeys);
    expect(h.entities()).toHaveLength(n);
  });

  it('walletRequests(): trusted creators, latest version per site, kind/unlimited/hostname filters', async () => {
    const h = make();
    const a = leaky(undefined, sampleCapturedWalletRequests());
    await h.reg.publish(a.report, a.bundle);
    const o = otherSite(undefined, [
      capturedApprove(SPENDER.replace('0x1', '0x2'), {
        phase: 'pre-connect',
        outcome: 'rejected',
        origin: 'https://other.example.net',
      }),
    ]);
    await h.reg.publish(o.report, o.bundle);

    const all = await h.reg.walletRequests({});
    expect(all.map((w) => [w.hostname, w.kind])).toEqual([
      ['other.example.net', 'approve'],
      [HOST, 'permit2'],
      [HOST, 'siwe'],
    ]);
    expect(all[0]).toMatchObject({
      owner: h.name === 'arkiv' ? h.reg.publisher : 'igris-test',
      method: 'eth_sendTransaction',
      outcome: 'rejected',
      unlimited: true,
      preConnect: true,
      chainIdMismatch: false,
      spender: getAddress('0x2111111111111111111111111111111111111111'),
      verifyingContract: '',
      version: 1,
    });
    const unlimited = await h.reg.walletRequests({ unlimited: true });
    expect(unlimited.map((w) => w.kind)).toEqual(['approve', 'permit2']);
    expect((await h.reg.walletRequests({ unlimited: false })).map((w) => w.kind)).toEqual(['siwe']);
    expect((await h.reg.walletRequests({ kind: 'permit2' })).map((w) => w.hostname)).toEqual([
      HOST,
    ]);
    expect((await h.reg.walletRequests({ hostname: HOST })).map((w) => w.kind)).toEqual([
      'permit2',
      'siwe',
    ]);
    expect(await h.reg.walletRequests({ limit: 1 })).toHaveLength(1);
    expect(await h.reg.walletRequests({ kind: 'connect' })).toEqual([]);
    expect(await h.reg.walletRequests({ hostname: 'Not A Host' })).toEqual([]);

    // a retest without wallet requests: the site drops out (latest version only)
    const b = fixedSegment(undefined, []);
    await h.reg.publish(b.report, b.bundle);
    expect((await h.reg.walletRequests({})).map((w) => w.hostname)).toEqual(['other.example.net']);
  });

  it('forged ($owner transfer) and hostile walletreq rows are rejected', async () => {
    const h = make();
    const a = leaky(undefined, sampleCapturedWalletRequests());
    const res = await h.reg.publish(a.report, a.bundle);
    const genuine = h.entities().find((e) => e.key === res.walletRequestKeys![0])!;
    const hostile: Array<[string, (c: WireEntity) => void]> = [
      [
        'transfer',
        (c) => {
          c.creator = h.mallory; // created by mallory, transferred to the publisher
          c.owner = h.publisherId;
        },
      ],
      ['connect', (c) => setAttr(c, 'kind', 'connect')],
      ['bool', (c) => setAttr(c, 'unlimited', 2)],
      ['booltype', (c) => (attr(c, 'unlimited')!.type = 'bool')],
      ['addr', (c) => setAttr(c, 'spender', `0x${'ab'.repeat(20)}`)], // not checksummed
      ['checksum', (c) => setAttr(c, 'verifyingContract', PERMIT2.toLowerCase())],
      ['method', (c) => setAttr(c, 'method', 'eth_call')],
      ['outcome', (c) => setAttr(c, 'outcome', 'maybe')],
      ['scanid', (c) => setAttr(c, 'scanId', 'x')],
    ];
    for (const [seed, over] of hostile) h.add(clone(h, genuine, seed, over));
    const keys = (await h.reg.walletRequests({})).map((w) => w.key);
    expect(keys).toEqual(res.walletRequestKeys);
    // a reader that trusts mallory still gets nothing: mallory published no scan version
    expect(await h.reader([h.mallory]).walletRequests({})).toEqual([]);
  });

  it('null or empty walletRequests publish no walletreq entity; a canary spender is never indexed', async () => {
    const h = make();
    // null: no wallet requests captured; []: captured, but none
    for (const r of [leaky(), leaky(undefined, [])]) {
      const res = await h.reg.publish(r.report, r.bundle);
      expect(res.walletRequestKeys).toEqual([]);
      expect((await h.reg.load(res.scan)).verified).toBe(true);
    }
    expect(h.entities().filter((e) => schemaOf(e) === 'igris.walletreq.v1')).toEqual([]);

    // an approve whose spender is the canary itself: the engine redacts it, so
    // the indexed spender is "" and no entity carries the canary
    const canary = fixedSegment(undefined, [capturedApprove(CANARY_A)]);
    const res = await h.reg.publish(canary.report, canary.bundle);
    const wr = h.entities().filter((e) => res.walletRequestKeys!.includes(e.key));
    expect(wr).toHaveLength(1);
    expect(attr(wr[0]!, 'spender')?.value).toBe('');
    const all = JSON.stringify(h.entities()).toLowerCase();
    expect(all).not.toContain(CANARY_A.toLowerCase().slice(2));
  });
});

describe('walletRequestValues', () => {
  const base = { hostname: HOST, scanId: 'a'.repeat(64), scannedAt: T0 };
  const report = (walletRequests: unknown) =>
    ({
      ...leaky().report,
      walletRequests,
    }) as unknown as ReportV3;

  it('treats a missing / null list as no requests (reports built before wallet requests)', () => {
    const r = { ...leaky().report } as Record<string, unknown>;
    delete r.walletRequests;
    expect(walletRequestValues(r as unknown as ReportV3, base)).toEqual({
      values: [],
      unindexed: 0,
    });
    expect(walletRequestValues(report(null), base)).toEqual({ values: [], unindexed: 0 });
  });

  it('refuses malformed entries instead of indexing them', () => {
    const bad: unknown[] = [
      'x',
      [1],
      [walletSummary({ kind: 'teleport' as never })],
      [walletSummary({ method: 'eth_call' as never })],
      [walletSummary({ outcome: 'maybe' as never })],
      [walletSummary({ unlimited: 1 as never })],
      [walletSummary({ spender: '0x123' })],
    ];
    for (const b of bad)
      expect(() => walletRequestValues(report(b), base)).toThrow(PublishRefusedError);
  });

  it('refuses a request naming the canary (never indexed)', () => {
    const canary = leaky().report.scan.canaryAddress;
    for (const over of [{ spender: canary }, { verifyingContract: canary.toLowerCase() }])
      expect(() => walletRequestValues(report([walletSummary(over)]), base)).toThrow(/canary/);
  });

  it(`never drops an eth_sign after ${MAX_WALLET_REQUEST_ENTITIES} noisy requests: highest risk first`, () => {
    const noisy = Array.from({ length: MAX_WALLET_REQUEST_ENTITIES }, () =>
      walletSummary({ kind: 'typed-data', method: 'eth_signTypedData_v4', preConnect: true }),
    );
    const late = [
      walletSummary({ kind: 'blind-hash' }),
      walletSummary({ kind: 'siwe', domainMismatch: true }),
      walletSummary({ kind: 'eth-sign', method: 'eth_sign', outcome: 'rejected' }),
    ];
    const { values, unindexed } = walletRequestValues(report([...noisy, ...late]), base);
    expect(values).toHaveLength(MAX_WALLET_REQUEST_ENTITIES);
    expect(unindexed).toBe(3);
    // the three late, riskier requests are all indexed, in report order (last)
    expect(values.slice(-3).map((v) => v.kind)).toEqual(['blind-hash', 'siwe', 'eth-sign']);
  });

  it('walletRequestTier follows the severity table of WALLET-REQUESTS.md', () => {
    const v = (o: Partial<Parameters<typeof walletRequestTier>[0]>) =>
      walletRequestTier({
        kind: 'typed-data',
        unlimited: 0,
        domainMismatch: 0,
        chainIdMismatch: 0,
        preConnect: 0,
        ...o,
      });
    const ordered = [
      v({ kind: 'eth-sign' }),
      v({ kind: 'permit2', unlimited: 1 }),
      v({ kind: 'set-approval-for-all' }),
      v({ kind: 'siwe', domainMismatch: 1 }),
      v({ kind: 'blind-hash' }),
      v({ chainIdMismatch: 1 }),
      v({ preConnect: 1 }),
      v({}),
    ];
    expect(ordered).toEqual([0, 1, 1, 2, 3, 4, 5, 6]);
  });

  it(`caps the index at ${MAX_WALLET_REQUEST_ENTITIES} entities, flagged requests first`, () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      walletSummary({ unlimited: i >= 90, kind: i >= 90 ? 'permit' : 'personal-message' }),
    );
    const { values, unindexed } = walletRequestValues(report(many), base);
    expect(values).toHaveLength(MAX_WALLET_REQUEST_ENTITIES);
    expect(unindexed).toBe(100 - MAX_WALLET_REQUEST_ENTITIES);
    expect(values.filter((v) => v.unlimited === 1)).toHaveLength(10); // every flagged one kept
  });
});

describe('ArkivSiteRegistry batches', () => {
  it('publish batch: scan + evidence + flows + walletreqs, all readonly with the scan expiry', async () => {
    const s = scanner();
    const node = new FakeNode(s.address);
    const reg = new ArkivSiteRegistry({ scanner: s, io: node.io });
    const a = leaky(undefined, sampleCapturedWalletRequests());
    const res = await reg.publish(a.report, a.bundle);
    const creates = node.batches[0]!.creates as unknown as Create[];
    expect(creates.map((c) => c.schema)).toEqual([
      ScanSchema,
      EvidenceSchema,
      FlowSchema,
      FlowSchema,
      FlowSchema,
      FlowSchema,
      WalletRequestSchema,
      WalletRequestSchema,
    ]);
    const expiration = ExpirationTime.fromDays(180);
    for (const c of creates) {
      expect(c.expiration).toEqual(expiration);
      expect(c.flags).toEqual({ readonly: true });
    }
    expect(creates[0]!.values).not.toHaveProperty('request');
    expect(creates[6]!.values).toMatchObject({
      kind: 'permit2',
      unlimited: 1,
      scannedAt: { type: 'u64', value: 1793923200n },
    });
    expect(res.flowKeys).toHaveLength(4);
    expect(res.walletRequestKeys).toHaveLength(2);

    node.queries = [];
    await reg.walletRequests({ unlimited: true, kind: 'permit2' });
    expect(node.queries[0]).toBe(
      `arkiv.schema = str('igris.walletreq.v1') AND kind = str('permit2') AND unlimited = i32(1) AND $creator = addr(${getAddress(s.address)}) ORDER BY scannedAt:u64 DESC`,
    );
  });

  it('a report with 20 wallet requests + 40 flows stays well under the 2^24 gas cap', () => {
    const reg = new ArkivSiteRegistry({ scanner: null });
    const r = withWalletRequests(leaky(), []);
    const pub = buildPublication(r.report, r.bundle);
    const flow = pub.flows[0]!;
    const flows = Array.from({ length: 40 }, (_, i) => ({
      ...flow,
      recipient: `recipient-${String(i).padStart(2, '0')}.example-tracker.com`,
    }));
    const walletRequests = Array.from({ length: 20 }, () => ({
      hostname: HOST,
      kind: 'permit2',
      method: 'eth_signTypedData_v4',
      outcome: 'signed',
      unlimited: 1 as const,
      chainIdMismatch: 1 as const,
      domainMismatch: 0 as const,
      preConnect: 1 as const,
      verifyingContract: PERMIT2,
      spender: SPENDER,
      scanId: pub.scan.scanId,
      scannedAt: pub.scan.scannedAt,
    }));
    const v = withVersion({ ...pub, flows, walletRequests }, 7, keccak256(toHex('prev')));
    const gas = estimateBatchGas(reg.batchFor(v));
    expect(gas.creates).toBe(62);
    // the index entities (60 of them) are small; the two payloads dominate
    expect(gas.estimate).toBeLessThan(MAX_TRANSACTION_GAS / 2);
    expect(gas.lowerBound).toBeLessThan(gas.estimate);

    // worst case: both payloads at the 128 KiB limit (incompressible), same index
    const max = withVersion(
      {
        ...pub,
        flows,
        walletRequests,
        scan: { ...pub.scan, report: new Uint8Array(128 * 1024).fill(0xab) },
        evidence: { ...pub.evidence, bundle: new Uint8Array(128 * 1024).fill(0xcd) },
      },
      7,
      null,
    );
    const worst = estimateBatchGas(reg.batchFor(max));
    expect(worst.estimate).toBeLessThan(MAX_TRANSACTION_GAS);
  });

  it('the lower bound flags a batch that can never land (publish refuses those)', () => {
    const reg = new ArkivSiteRegistry({ scanner: null });
    const r = withWalletRequests(leaky(), []);
    const pub = buildPublication(r.report, r.bundle);
    const flows = Array.from({ length: 4000 }, (_, i) => ({
      ...pub.flows[0]!,
      recipient: `r${i}.example-tracker.com`,
    }));
    const gas = estimateBatchGas(reg.batchFor(withVersion({ ...pub, flows }, 1, null)));
    expect(gas.lowerBound).toBeGreaterThan(MAX_TRANSACTION_GAS);
  });
});
