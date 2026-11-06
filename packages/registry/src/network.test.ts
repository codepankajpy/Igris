/**
 * Open scan requests (igris.request.v1), request-linked scans and decoded
 * wallet requests (igris.walletreq.v1) — docs/design/SCAN-NETWORK.md and
 * docs/design/WALLET-REQUESTS.md. One parity suite runs against both
 * backends (Arkiv through a fake node, and the local file); backend-specific
 * checks (batch contents, query strings, gas) follow.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExpirationTime } from '@arkiv-network/sdk';
import { bytesToHex, getAddress, keccak256, toHex } from 'viem';
import { contentHash, type ReportV3 } from '@igris/core';
import { CANARY_A } from '@igris/core/testing';
import { ArkivSiteRegistry, MAX_REQUEST_ROWS, REQUEST_EXPIRY_DAYS } from './arkiv.js';
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
import {
  RequestSchema,
  ScanSchema,
  WalletRequestSchema,
  EvidenceSchema,
  FlowSchema,
} from './schemas.js';
import { MAX_REQUESTS_PER_CREATOR, REQUEST_CLOCK_SKEW_S } from './rows.js';
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
const URL_ = 'https://app.example.org/';
const T0 = 1_793_923_200; // 2026-11-06T00:00:00Z

interface Harness {
  name: 'arkiv' | 'local';
  reg: SiteRegistry;
  clock: { t: number };
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
  const clock = { t: T0 };
  const reg = new ArkivSiteRegistry({ scanner: s, io: node.io, now: () => clock.t });
  return {
    name: 'arkiv',
    reg,
    clock,
    entities: () => node.entities,
    add: (e) => node.entities.push(e),
    set: (es) => (node.entities = es),
    freshKey: (seed) => keccak256(toHex(`fresh-${seed}`)),
    mallory: '0x000000000000000000000000000000000000dead',
    publisherId: s.address.toLowerCase(),
    reader: (trusted) =>
      new ArkivSiteRegistry({
        scanner: null,
        io: node.io,
        trustedOwners: trusted,
        now: () => clock.t,
      }),
    readonlyFlags: () => node.entities.map((e) => e.creationFlags ?? -1),
  };
}

function localHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'igris-net-'));
  const file = join(dir, 'registry.json');
  const clock = { t: T0 };
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
    reg: new LocalSiteRegistry({ file, publisher: 'igris-test', now: () => clock.t }),
    clock,
    entities: read,
    add: (e) => write([...read(), e]),
    set: write,
    freshKey: (seed) => `local:${keccak256(toHex(`fresh-${seed}`)).slice(2)}`,
    mallory: 'mallory',
    publisherId: 'igris-test',
    reader: (trusted) =>
      new LocalSiteRegistry({ file, publisher: null, trustedOwners: trusted, now: () => clock.t }),
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

describe.each([
  ['arkiv', arkivHarness],
  ['local', localHarness],
] as const)('%s registry: open scan requests', (_name, make) => {
  it('createRequest writes a readonly + permissionlessExtension request; request() reads it', async () => {
    const h = make();
    const r = await h.reg.createRequest(HOST, 'https://app.example.org');
    expect(r).toMatchObject({
      creator: h.reg.publisher,
      hostname: HOST,
      url: URL_, // canonical form
      requestedAt: T0,
      expiresAtBlock: null,
    });
    const stored = h.entities().find((e) => e.key === r.key)!;
    expect(schemaOf(stored)).toBe('igris.request.v1');
    expect(stored.creationFlags).toBe(3); // readonly | permissionlessExtension
    const { expiresAtBlock: _e, ...rest } = r;
    expect(await h.reg.request(r.key)).toMatchObject(rest);
    expect(await h.reg.request('nope')).toBeNull();
    expect(await h.reg.request(h.freshKey('missing'))).toBeNull();
  });

  it('createRequest refuses invalid hostnames and URLs, and a read-only registry', async () => {
    const h = make();
    const bad: Array<[string, string]> = [
      ['App.Example.org', URL_],
      ['localhost', 'https://localhost/'],
      [HOST, 'ftp://app.example.org/'],
      [HOST, 'javascript:alert(1)'],
      [HOST, 'https://other.example.org/'],
      [HOST, 'https://evil.example@app.example.org/'],
      [HOST, 'https://user:pw@app.example.org/'],
      [HOST, `https://app.example.org/${'a'.repeat(120)}`],
      [HOST, 'not a url'],
    ];
    for (const [host, url] of bad) {
      await expect(h.reg.createRequest(host, url), `${host} ${url}`).rejects.toThrow(
        PublishRefusedError,
      );
    }
    await expect(h.reader([h.publisherId]).createRequest(HOST, URL_)).rejects.toThrow(/read-only/);
    expect(h.entities()).toEqual([]);
  });

  it('openRequests: any creator, since-filtered, oldest first; hostile rows are skipped', async () => {
    const h = make();
    const a = await h.reg.createRequest(HOST, URL_);
    h.clock.t = T0 + 60;
    const b = await h.reg.createRequest('other.example.net', 'https://other.example.net/x?y=1');
    const genuine = h.entities().find((e) => e.key === b.key)!;
    const byMallory = clone(h, genuine, 'm', (c) => {
      c.creator = h.mallory; // a valid request by someone else: accepted
      c.owner = h.mallory;
      setAttr(c, 'requestedAt', h.name === 'arkiv' ? toHex(T0 + 30) : String(T0 + 30));
    });
    h.add(byMallory);
    // Third parties following the spec need not create readonly requests:
    // mutable ones (or rows whose flags the node does not report) are valid.
    const stamp = (c: WireEntity, t: number) =>
      setAttr(c, 'requestedAt', h.name === 'arkiv' ? toHex(t) : String(t));
    const mutable = clone(h, genuine, 'mutable', (c) => {
      c.creationFlags = 2; // permissionlessExtension only
      stamp(c, T0 + 40);
    });
    const noFlags = clone(h, genuine, 'noflags', (c) => {
      delete c.creationFlags;
      stamp(c, T0 + 50);
    });
    h.add(mutable);
    h.add(noFlags);
    const hostile: Array<[string, (c: WireEntity) => void]> = [
      ['host', (c) => setAttr(c, 'url', 'https://evil.example.com/')],
      ['scheme', (c) => setAttr(c, 'url', 'javascript:alert(1)')],
      ['long', (c) => setAttr(c, 'url', `https://other.example.net/${'a'.repeat(200)}`)],
      ['upper', (c) => setAttr(c, 'hostname', 'Other.example.net')],
      ['noncanon', (c) => setAttr(c, 'url', 'https://other.example.net')],
      ['ts', (c) => setAttr(c, 'requestedAt', 'soon')],
      ['type', (c) => (attr(c, 'url')!.type = 'bytes')],
      ['future', (c) => stamp(c, T0 + 60 + REQUEST_CLOCK_SKEW_S + 1)], // ahead of the clock
      ['nocreator', (c) => ((c as { creator?: unknown }).creator = 42)],
    ];
    for (const [seed, over] of hostile) h.add(clone(h, genuine, seed, over));

    const open = await h.reg.openRequests({ since: T0 });
    expect(open.map((r) => r.key)).toEqual([a.key, byMallory.key, mutable.key, noFlags.key, b.key]);
    expect(await h.reg.request(mutable.key)).toMatchObject({
      key: mutable.key,
      url: genuine.attributes.find((x) => x.name === 'url')!.value,
    });
    const m = open[1]!;
    expect(m.creator.toLowerCase()).toBe(h.mallory);
    expect(await h.reg.request(byMallory.key)).toMatchObject({ key: byMallory.key });
    for (const [seed] of hostile) expect(await h.reg.request(h.freshKey(seed))).toBeNull();

    expect((await h.reg.openRequests({ since: T0 + 31 })).map((r) => r.key)).toEqual([
      mutable.key,
      noFlags.key,
      b.key,
    ]);
    // at most `limit`: the newest ones, oldest first
    expect((await h.reg.openRequests({ since: 0, limit: 2 })).map((r) => r.key)).toEqual([
      noFlags.key,
      b.key,
    ]);
    expect(await h.reg.openRequests({ since: -1 })).toEqual([]);
    expect(await h.reg.openRequests({ since: 1.5 })).toEqual([]);
    // a read-only reader trusting nobody still sees requests (any creator)
    expect(await h.reader([]).openRequests({ since: T0 })).toHaveLength(5);
  });

  it('publish({ request }) records the request; fulfilments() returns trusted scans only', async () => {
    const h = make();
    const r = await h.reg.createRequest(HOST, URL_);
    const a = leaky();
    const v1 = await h.reg.publish(a.report, a.bundle, { request: r.key });
    expect(v1.scan.request).toBe(r.key.toLowerCase());
    const stored = h.entities().find((e) => e.key === v1.scan.key)!;
    expect(attr(stored, 'request')).toMatchObject({ type: 'str', value: r.key.toLowerCase() });
    expect((await h.reg.versions(HOST))[0]!.request).toBe(r.key.toLowerCase());

    const b = fixedSegment();
    const v2 = await h.reg.publish(b.report, b.bundle);
    expect(v2.scan.request).toBeNull();
    expect(
      attr(
        h.entities().find((e) => e.key === v2.scan.key)!,
        'request',
      )?.value,
    ).toBe('');

    // the forgery $creator exists for: mallory's scan "fulfilling" the request,
    // transferred to the trusted publisher
    const forged = clone(h, stored, 'forged-scan', (c) => {
      c.creator = h.mallory;
      c.owner = h.publisherId;
      setAttr(c, 'version', 9);
      setAttr(c, 'previous', v2.scan.key);
    });
    h.add(forged);
    expect((await h.reg.fulfilments(r.key)).map((s) => s.key)).toEqual([v1.scan.key]);
    expect(await h.reg.fulfilments(h.freshKey('other'))).toEqual([]);
    expect(await h.reg.fulfilments('0x12')).toEqual([]);
    // trust is per reader: one that trusts mallory sees only mallory's scan
    expect((await h.reader([h.mallory]).fulfilments(r.key)).map((s) => s.key)).toEqual([
      forged.key,
    ]);
  });

  it('publish refuses a malformed, unknown or other-site request and writes nothing', async () => {
    const h = make();
    const other = await h.reg.createRequest('other.example.net', 'https://other.example.net/');
    const before = h.entities().length;
    const a = leaky();
    await expect(h.reg.publish(a.report, a.bundle, { request: 'x' })).rejects.toThrow(
      /not an? .*entity key/,
    );
    await expect(
      h.reg.publish(a.report, a.bundle, { request: h.freshKey('ghost') }),
    ).rejects.toThrow(/not a live, valid igris\.request\.v1/);
    await expect(h.reg.publish(a.report, a.bundle, { request: other.key })).rejects.toThrow(
      /is for other\.example\.net, not app\.example\.org/,
    );
    expect(h.entities()).toHaveLength(before);
  });

  it('an older scan entity without a request attribute decodes as request null', async () => {
    const h = make();
    const a = leaky();
    const v1 = await h.reg.publish(a.report, a.bundle);
    h.set(
      h
        .entities()
        .map((e) =>
          e.key === v1.scan.key
            ? { ...e, attributes: e.attributes.filter((x) => x.name !== 'request') }
            : e,
        ),
    );
    const [s] = await h.reg.versions(HOST);
    expect(s).toMatchObject({ key: v1.scan.key, request: null });
    expect((await h.reg.load(s!)).verified).toBe(true);
    // a mistyped request attribute makes the row invalid (skipped)
    h.set(
      h.entities().map((e) =>
        e.key === v1.scan.key
          ? {
              ...e,
              attributes: [...e.attributes, { name: 'request', type: 'str', value: 'junk' }],
            }
          : e,
      ),
    );
    expect(await h.reg.versions(HOST)).toEqual([]);
  });
  it('one creator flooding requests (> 1000 rows, some future-dated) cannot hide other creators', async () => {
    const h = make();
    const a = await h.reg.createRequest(HOST, URL_); // the publisher, at T0
    const genuine = h.entities().find((e) => e.key === a.key)!;
    const carol = h.name === 'arkiv' ? '0x000000000000000000000000000000000000beef' : 'carol';
    const as = (seed: string, creator: string, t: number) =>
      clone(h, genuine, seed, (c) => {
        c.creator = creator;
        c.owner = creator;
        setAttr(c, 'requestedAt', h.name === 'arkiv' ? toHex(t) : String(t));
      });
    const byCarol = as('carol', carol, T0 + 10);
    // mallory: 1500 requests newer than everyone else's …
    const flood = Array.from({ length: 1500 }, (_, i) => as(`flood-${i}`, h.mallory, T0 + 100 + i));
    // … and 200 dated far ahead, which would sort above everything for days
    const future = Array.from({ length: 200 }, (_, i) =>
      as(`future-${i}`, h.mallory, T0 + 86_400 + i),
    );
    h.set([...h.entities(), byCarol, ...flood, ...future]);
    h.clock.t = T0 + 1600;

    const open = await h.reg.openRequests({ since: T0 });
    // everyone else is still there; mallory gets her newest MAX_REQUESTS_PER_CREATOR
    expect(open.map((r) => r.key)).toEqual([
      a.key,
      byCarol.key,
      ...flood.slice(-MAX_REQUESTS_PER_CREATOR).map((e) => e.key),
    ]);
    expect(open.every((r) => r.requestedAt <= h.clock.t + REQUEST_CLOCK_SKEW_S)).toBe(true);
    expect(await h.reg.request(future[0]!.key)).toBeNull();
    // once the clock reaches a future-dated request (minus the skew), it counts
    h.clock.t = T0 + 86_400 - REQUEST_CLOCK_SKEW_S;
    expect(await h.reg.request(future[0]!.key)).toMatchObject({ key: future[0]!.key });
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

describe('LocalSiteRegistry request expiry', () => {
  it('emulates the 7-day request lifetime: expired requests are neither read nor fulfillable', async () => {
    const h = localHarness();
    const r = await h.reg.createRequest(HOST, URL_);
    h.clock.t = T0 + 7 * 86_400 - 1;
    expect(await h.reg.request(r.key)).not.toBeNull();
    h.clock.t = T0 + 7 * 86_400;
    expect(await h.reg.request(r.key)).toBeNull();
    expect(await h.reg.openRequests({ since: 0 })).toEqual([]);
    const a = leaky();
    await expect(h.reg.publish(a.report, a.bundle, { request: r.key })).rejects.toThrow(
      /not a live, valid/,
    );
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
  it('request batch: igris.request.v1, readonly + permissionlessExtension, 7-day expiry', () => {
    const reg = new ArkivSiteRegistry({ scanner: null });
    const batch = reg.requestBatch(HOST, URL_, T0);
    const [c] = batch.creates as unknown as Create[];
    expect(c!.schema).toBe(RequestSchema);
    expect(c!.flags).toEqual({ readonly: true, permissionlessExtension: true });
    expect(c!.expiration).toEqual(ExpirationTime.fromDays(REQUEST_EXPIRY_DAYS));
    expect(c!.values).toEqual({
      hostname: HOST,
      url: URL_,
      requestedAt: { type: 'u64', value: BigInt(T0) },
    });
  });

  it('publish batch: scan + evidence + flows + walletreqs, all readonly with the scan expiry', async () => {
    const s = scanner();
    const node = new FakeNode(s.address);
    const reg = new ArkivSiteRegistry({ scanner: s, io: node.io, now: () => T0 });
    const r = await reg.createRequest(HOST, URL_);
    const a = leaky(undefined, sampleCapturedWalletRequests());
    const res = await reg.publish(a.report, a.bundle, { request: r.key });
    const creates = node.batches[1]!.creates as unknown as Create[];
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
    expect(creates[0]!.values.request).toBe(r.key.toLowerCase());
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
    node.queries = [];
    await reg.openRequests({ since: T0 });
    expect(node.queries[0]).toBe(
      `arkiv.schema = str('igris.request.v1') AND requestedAt >= u64(${T0}) AND requestedAt <= u64(${T0 + REQUEST_CLOCK_SKEW_S}) ORDER BY requestedAt:u64 DESC`,
    );
    node.queries = [];
    await reg.fulfilments(r.key);
    expect(node.queries[0]).toBe(
      `arkiv.schema = str('igris.scan.v2') AND request = str('${r.key.toLowerCase()}') AND $creator = addr(${getAddress(s.address)}) ORDER BY version:i32 DESC`,
    );
  });

  it(`openRequests walks at most ${MAX_REQUEST_ROWS} request rows`, async () => {
    const s = scanner();
    const node = new FakeNode(s.address);
    const clock = { t: T0 };
    const reg = new ArkivSiteRegistry({ scanner: s, io: node.io, now: () => clock.t });
    const honest = await reg.createRequest(HOST, URL_);
    const genuine = node.entities[0]!;
    const mallory = '0x000000000000000000000000000000000000dead';
    const flood = (n: number) =>
      Array.from({ length: n }, (_, i) => {
        const c = structuredClone(genuine);
        c.key = keccak256(toHex(`flood-${i}`));
        c.creator = c.owner = mallory;
        c.attributes.find((x) => x.name === 'requestedAt')!.value = toHex(T0 + 1 + i);
        return c;
      });
    clock.t = T0 + MAX_REQUEST_ROWS + 1;
    // one row short of the bound: the honest request is still reached
    node.entities = [genuine, ...flood(MAX_REQUEST_ROWS - 1)];
    expect((await reg.openRequests({ since: T0 })).map((r) => r.key)).toContain(honest.key);
    // at the bound the walk stops (cost stays bounded): MAX_REQUEST_ROWS / 100 pages
    node.entities = [genuine, ...flood(MAX_REQUEST_ROWS)];
    node.queries = [];
    const open = await reg.openRequests({ since: T0 });
    expect(open.map((r) => r.key)).not.toContain(honest.key);
    expect(open).toHaveLength(MAX_REQUESTS_PER_CREATOR);
    expect(node.queries).toHaveLength(MAX_REQUEST_ROWS / 100);
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
    const v = withVersion(
      { ...pub, flows, walletRequests },
      7,
      keccak256(toHex('prev')),
      keccak256(toHex('req')),
    );
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
