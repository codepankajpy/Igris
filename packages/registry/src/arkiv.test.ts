import { describe, expect, it } from 'vitest';
import { ExpirationTime, type ExecuteBatchParameters } from '@arkiv-network/sdk';
import { bytesToHex, getAddress, keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ArkivSiteRegistry, type ArkivIo } from './arkiv.js';
import type { LoadedScanner } from './identity.js';
import { EvidenceSchema, FlowSchema, ScanSchema } from './schemas.js';
import type { WireEntity } from './payload.js';
import { diffVersions } from './diff.js';
import { contentHash } from '@igris/core';
import { PublishRefusedError } from './site-registry.js';
import {
  IPV6_RECIPIENT,
  fixedSegment,
  leaky,
  otherSite,
  siteN,
  withIpv6Recipient,
} from './test-fixtures.js';

function scanner(): LoadedScanner {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  return {
    privateKey,
    address,
    profile: {
      schema: 'igris.scanner.v1',
      address,
      name: 'test',
      nodeId: '00000000-0000-4000-8000-000000000000',
      createdAt: '2026-11-06T00:00:00.000Z',
      origin: 'generated',
    },
  };
}

type Create = {
  schema: { name: string; columns: Record<string, { type: string }> };
  values: Record<string, unknown>;
  expiration: unknown;
};

/**
 * A minimal in-memory Arkiv node: stores batch creates in the JSON-RPC wire
 * shape the real node returns (u64 as 0x hex, owner lower-case) and answers
 * the subset of the query language the registry emits.
 */
class FakeNode {
  entities: WireEntity[] = [];
  queries: string[] = [];
  batches: ExecuteBatchParameters[] = [];
  /** Simulate a node (or a proxy) that ignores the owner filter. */
  ignoreOwnerFilter = false;
  private n = 0;
  constructor(public owner: string) {}

  io: ArkivIo = {
    query: async (q, options) => {
      this.queries.push(q);
      const [where = '', order] = q.split(' ORDER BY ');
      const creators = new Set<string>();
      const terms: Array<{ name: string; value: string | number }> = [];
      for (const m of where.matchAll(
        /(\$?[A-Za-z][\w.]*) = (?:str\('((?:[^']|'')*)'\)|i32\((-?\d+)\)|addr\((0x[0-9a-fA-F]{40})\)|key\((0x[0-9a-fA-F]{64})\))/g,
      )) {
        const [, name, s, n, a, k] = m;
        if (name === '$creator') creators.add(a!.toLowerCase());
        else
          terms.push({
            name: name!,
            value:
              s !== undefined
                ? s.replaceAll("''", "'")
                : n !== undefined
                  ? Number(n)
                  : k!.toLowerCase(),
          });
      }
      const val = (e: WireEntity, name: string) => e.attributes.find((x) => x.name === name)?.value;
      const match = (e: WireEntity, t: { name: string; value: string | number }) =>
        t.name === '$key'
          ? e.key.toLowerCase() === t.value
          : typeof t.value === 'number'
            ? Number(val(e, t.name)) === t.value
            : val(e, t.name) === t.value;
      // The registry only ever ORs equalities on ONE attribute (an owner or a
      // hostname group) and ANDs different attributes: group terms by name.
      const groups = new Map<string, Array<{ name: string; value: string | number }>>();
      for (const t of terms) groups.set(t.name, [...(groups.get(t.name) ?? []), t]);
      let rows = this.entities.filter(
        (e) =>
          (this.ignoreOwnerFilter || creators.has(e.creator.toLowerCase())) &&
          [...groups.values()].every((g) => g.some((t) => match(e, t))),
      );
      if (order) {
        const [name] = order.split(':');
        const num = (e: WireEntity) => {
          try {
            return Number(BigInt(val(e, name!) as string | number));
          } catch {
            return -1; // the real node would not hold a mistyped value; keep the fake total
          }
        };
        rows = [...rows].sort((x, y) => num(y) - num(x));
      }
      const offset = options.offset ? Number(options.offset) : 0;
      rows = rows.slice(offset, offset + Number(options.limit));
      const sel = options.select.attributes;
      return {
        data: rows.map((e) => ({
          key: e.key,
          owner: e.owner,
          creator: e.creator,
          expiresAt: e.expiresAt,
          attributes:
            sel === true
              ? e.attributes
              : e.attributes.filter((x) => typeof sel === 'object' && sel[x.name]),
        })),
        blockNumber: '0x1',
      };
    },
    executeBatch: async (params) => {
      this.batches.push(params);
      const created: string[] = [];
      for (const c of (params.creates ?? []) as unknown as Create[]) {
        const key = keccak256(toHex(`entity-${++this.n}`));
        const attributes = [{ name: 'arkiv.schema', type: 'str', value: c.schema.name }];
        for (const [name, col] of Object.entries(c.schema.columns)) {
          const v = c.values[name];
          const raw =
            typeof v === 'object' && v !== null && 'type' in v && 'value' in v
              ? (v as { value: unknown }).value
              : v;
          attributes.push({
            name,
            type: col.type,
            value: (col.type === 'u64'
              ? toHex(BigInt(raw as bigint))
              : col.type === 'bytes'
                ? bytesToHex(raw as Uint8Array)
                : raw) as string,
          });
        }
        this.entities.push({
          key,
          owner: this.owner.toLowerCase(),
          creator: this.owner.toLowerCase(),
          expiresAt: '0x77d0a0',
          attributes,
        });
        created.push(key);
      }
      return { txHash: keccak256(toHex(`tx-${this.batches.length}`)), createdEntities: created };
    },
  };
}

function setup(opts: { trustedOwners?: string[] } = {}) {
  const s = scanner();
  const node = new FakeNode(s.address);
  const reg = new ArkivSiteRegistry({ scanner: s, io: node.io, ...opts });
  return { s, node, reg };
}

describe('ArkivSiteRegistry publish', () => {
  it('one executeBatch: 1 scan + 1 evidence + N flows with the right attributes', async () => {
    const { s, node, reg } = setup();
    expect(reg.publisher).toBe(s.address);
    expect(reg.trustedOwners).toEqual([s.address]);
    const a = leaky();
    const res = await reg.publish(a.report, a.bundle);

    expect(node.batches).toHaveLength(1);
    const creates = node.batches[0]!.creates as unknown as Create[];
    expect(creates.map((c) => c.schema)).toEqual([
      ScanSchema,
      EvidenceSchema,
      FlowSchema,
      FlowSchema,
      FlowSchema,
      FlowSchema,
    ]);
    const expiration = ExpirationTime.fromDays(180);
    for (const c of creates) expect(c.expiration).toEqual(expiration);
    expect(creates[0]!.values).toMatchObject({
      hostname: 'app.example.org',
      version: 1,
      previous: '',
      scannedAt: { type: 'u64', value: 1793923200n },
      coverage: 'full',
      state: 'address-to-trackers',
      recipients: 4,
      reportVersion: '3.0.0',
    });
    expect(creates[0]!.values.report).toBeInstanceOf(Uint8Array);
    expect(creates[1]!.values).toMatchObject({
      sha256: a.report.evidence.sha256,
      bundleVersion: 'igris.evidence.v3',
    });
    expect(creates.slice(2).map((c) => c.values.recipient)).toEqual([
      'segment.io',
      'sentry.io',
      'infura.io',
      'googleapis.com',
    ]);
    expect(creates[2]!.values).toMatchObject({
      hostname: 'app.example.org',
      version: 1,
      verdict: 'tracking',
      preConnect: false,
    });

    expect(res.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.scan).toMatchObject({
      key: node.entities[0]!.key,
      owner: s.address,
      version: 1,
      previous: null,
    });
    expect(res.evidenceKey).toBe(node.entities[1]!.key);
    expect(res.flowKeys).toEqual(node.entities.slice(2).map((e) => e.key));

    // the version lookup before the batch read only trusted owners
    expect(node.queries[0]).toBe(
      `arkiv.schema = str('igris.scan.v2') AND hostname = str('app.example.org') AND $creator = addr(${getAddress(s.address)}) ORDER BY version:i32 DESC`,
    );
  });

  it('a retest is version 2 linked to version 1; reads and load verify', async () => {
    const { node, reg } = setup();
    const a = leaky();
    const v1 = await reg.publish(a.report, a.bundle);
    const b = fixedSegment();
    const v2 = await reg.publish(b.report, b.bundle);
    expect(v2.scan).toMatchObject({ version: 2, previous: v1.scan.key });
    expect((node.batches[1]!.creates as unknown as Create[])[0]!.values).toMatchObject({
      version: 2,
      previous: v1.scan.key,
    });

    const versions = await reg.versions('app.example.org');
    expect(versions.map((v) => [v.version, v.key, v.previous])).toEqual([
      [2, v2.scan.key, v1.scan.key],
      [1, v1.scan.key, null],
    ]);
    expect(versions[0]!.expiresAtBlock).toBe(0x77d0a0);
    expect((await reg.latest('app.example.org'))?.key).toBe(v2.scan.key);
    expect((await reg.version('app.example.org', 1))?.key).toBe(v1.scan.key);
    expect(await reg.version('app.example.org', 9)).toBeNull();

    const l1 = await reg.load(versions[1]!);
    const l2 = await reg.load(versions[0]!);
    expect([l1.verified, l2.verified, l1.problems, l2.problems]).toEqual([true, true, [], []]);
    expect(diffVersions(l1.report, l2.report).removed).toEqual([
      { registrableDomain: 'segment.io', class: 'analytics' },
    ]);

    const o = otherSite('2026-11-06T12:00:00.000Z');
    await reg.publish(o.report, o.bundle);
    expect((await reg.recentSites()).map((s) => [s.hostname, s.version])).toEqual([
      ['app.example.org', 2],
      ['other.example.net', 1],
    ]);
    expect((await reg.flowsTo('segment.io')).map((f) => [f.hostname, f.version])).toEqual([
      ['other.example.net', 1],
    ]);
    expect((await reg.flowsTo('infura.io')).map((f) => [f.hostname, f.version])).toEqual([
      ['app.example.org', 2],
    ]);
  });

  it('read-only (no scanner) refuses to publish and sends nothing', async () => {
    const node = new FakeNode('0x0000000000000000000000000000000000000001');
    const reg = new ArkivSiteRegistry({ scanner: null, io: node.io });
    expect(reg.publisher).toBeNull();
    expect(reg.trustedOwners).toEqual([]);
    const a = leaky();
    await expect(reg.publish(a.report, a.bundle)).rejects.toThrow(/read-only/);
    expect(node.batches).toHaveLength(0);
    expect(await reg.versions('app.example.org')).toEqual([]); // trusts nobody: no query at all
    expect(node.queries).toHaveLength(0);
  });

  it('refuses a batch whose created keys do not match', async () => {
    const s = scanner();
    const reg = new ArkivSiteRegistry({
      scanner: s,
      io: {
        query: async () => ({ data: [] }),
        executeBatch: async () => ({ txHash: '0xab', createdEntities: ['0x01'] }),
      },
    });
    const a = leaky();
    await expect(reg.publish(a.report, a.bundle)).rejects.toThrow(/created 1 entities, expected 6/);
  });

  it('validates expiryDays', () => {
    expect(() => new ArkivSiteRegistry({ scanner: null, expiryDays: 183 })).toThrow(/expiryDays/);
    expect(() => new ArkivSiteRegistry({ scanner: null, expiryDays: 0 })).toThrow(/expiryDays/);
  });
});

describe('ArkivSiteRegistry reads trust only trustedOwners', () => {
  it('filters owners server-side and re-checks client-side; hostile rows are skipped', async () => {
    const { s, node, reg } = setup();
    const a = leaky();
    const v1 = await reg.publish(a.report, a.bundle);
    const genuine = node.entities[0]!;
    const mallory = '0x000000000000000000000000000000000000dead';
    const forge = (over: (e: WireEntity) => void, n: number): WireEntity => {
      const e = structuredClone(genuine);
      e.key = keccak256(toHex(`forged-${n}`));
      over(e);
      return e;
    };
    const attr = (e: WireEntity, name: string) => e.attributes.find((x) => x.name === name)!;
    node.entities.push(
      forge((e) => {
        e.owner = mallory; // a perfectly valid row by an untrusted creator, claiming v5
        e.creator = mallory;
        attr(e, 'version').value = 5;
        attr(e, 'previous').value = genuine.key;
      }, 1),
      // The forgery the creator rule exists for: created by mallory, then
      // transferred to the trusted publisher (Arkiv needs no consent).
      forge((e) => {
        e.creator = mallory;
        e.owner = s.address.toLowerCase();
        attr(e, 'version').value = 6;
      }, 6),
      forge((e) => (attr(e, 'version').value = 'x'), 2),
      forge((e) => (attr(e, 'scannedAt').value = '0x' + 'f'.repeat(40)), 3),
      forge((e) => (e.attributes = e.attributes.filter((x) => x.name !== 'coverage')), 4),
      forge((e) => (attr(e, 'hostname').value = 'app.example.org\u0000'), 5),
    );
    node.ignoreOwnerFilter = true; // even if the node returned everything …
    const versions = await reg.versions('app.example.org');
    expect(versions.map((v) => v.key)).toEqual([v1.scan.key]); // … only the genuine row survives
    expect(versions[0]!.owner).toBe(s.address);

    // the forged v5 does not bump the version of the next publish
    node.ignoreOwnerFilter = false;
    const b = fixedSegment();
    expect((await reg.publish(b.report, b.bundle)).scan.version).toBe(2);
  });

  it('several trusted owners are one OR group; load refuses untrusted scans', async () => {
    const other = '0x00000000000000000000000000000000000000aa';
    const { s, node, reg } = setup({ trustedOwners: [other] });
    expect(reg.trustedOwners).toEqual([getAddress(other)]);
    const a = leaky();
    const res = await reg.publish(a.report, a.bundle);
    // version lookup on publish covers trusted owners AND the publisher
    expect(node.queries[0]).toContain(
      `($creator = addr(${getAddress(other)}) OR $creator = addr(${getAddress(s.address)}))`,
    );
    // reads trust only `other`, so our own publish is invisible to this reader
    expect(await reg.versions('app.example.org')).toEqual([]);
    expect(node.queries.at(-1)).toContain(`$creator = addr(${getAddress(other)})`);
    expect(node.queries.at(-1)).not.toContain(getAddress(s.address));
    await expect(reg.load(res.scan)).rejects.toThrow(/not owned by a trusted owner/);
  });
});

describe('ArkivSiteRegistry regressions (one-flow review)', () => {
  const scanQueries = (node: FakeNode) =>
    node.queries.filter((q) => q.startsWith("arkiv.schema = str('igris.scan.v2')"));

  it('an IPv6-literal recipient does not block publishing; only its flow is omitted', async () => {
    const { node, reg } = setup();
    const a = withIpv6Recipient();
    const res = await reg.publish(a.report, a.bundle);
    const creates = node.batches[0]!.creates as unknown as Create[];
    expect(creates).toHaveLength(2 + 4); // scan + evidence + 4 flows (not 5)
    expect(creates.slice(2).map((c) => c.values.recipient)).not.toContain(IPV6_RECIPIENT);
    expect(creates[0]!.values.recipients).toBe(5);
    expect(res.flowKeys).toHaveLength(4);
    const loaded = await reg.load(res.scan);
    expect(loaded.verified).toBe(true);
    expect(loaded.report.recipients.map((r) => r.registrableDomain)).toContain(IPV6_RECIPIENT);
  });

  it('flowsTo filters to latest versions BEFORE applying the limit', async () => {
    const { reg } = setup();
    const old = siteN('old.example.com', '2026-11-01T00:00:00.000Z');
    const v1 = siteN('new.example.com', '2026-11-03T00:00:00.000Z');
    const v2 = siteN('new.example.com', '2026-11-04T00:00:00.000Z', false); // stopped
    for (const r of [old, v1, v2]) await reg.publish(r.report, r.bundle);
    // before the fix: the stale new.example.com flow took the only slot and was then dropped → []
    expect(
      (await reg.flowsTo('segment.io', { limit: 1 })).map((f) => [f.hostname, f.version]),
    ).toEqual([['old.example.com', 1]]);
  });

  it('flowsTo resolves latest versions in a few batched queries, not one per site', async () => {
    const { node, reg } = setup();
    const hosts = Array.from(
      { length: 30 },
      (_, i) => `s${String(i).padStart(2, '0')}.example.com`,
    );
    for (const [i, h] of hosts.entries()) {
      const r = siteN(h, new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString());
      await reg.publish(r.report, r.bundle);
    }
    const stale = siteN('s29.example.com', '2026-11-02T00:00:00.000Z', false);
    await reg.publish(stale.report, stale.bundle); // newest site no longer sends to segment

    node.queries = [];
    const all = await reg.flowsTo('segment.io', { limit: 100 });
    expect(all.map((f) => f.hostname)).toEqual(hosts.slice(0, 29).reverse());
    expect(node.queries).toHaveLength(1 + 2); // 1 flow query + ceil(30 / 25) scan queries
    expect(scanQueries(node)[0]).toContain(
      "(hostname = str('s29.example.com') OR hostname = str('s28.example.com')",
    );

    node.queries = [];
    const top = await reg.flowsTo('segment.io', { limit: 5 });
    expect(top.map((f) => f.hostname)).toEqual(
      ['s28', 's27', 's26', 's25', 's24'].map((h) => `${h}.example.com`),
    );
    expect(node.queries).toHaveLength(2); // stops once the first `limit` are settled
  });

  it('findByScanId and byKey read trusted owners only', async () => {
    const { node, reg } = setup();
    const a = leaky();
    const v1 = await reg.publish(a.report, a.bundle);
    const b = fixedSegment();
    const v2 = await reg.publish(b.report, b.bundle);
    expect((await reg.findByScanId('app.example.org', contentHash(a.report)))?.key).toBe(
      v1.scan.key,
    );
    expect((await reg.findByScanId('app.example.org', contentHash(b.report)))?.key).toBe(
      v2.scan.key,
    );
    expect(await reg.findByScanId('other.example.net', contentHash(a.report))).toBeNull();
    node.queries = [];
    expect(await reg.findByScanId('app.example.org', 'not-a-sha')).toBeNull();
    expect(await reg.byKey('0x1234')).toBeNull();
    expect(node.queries).toHaveLength(0); // malformed input never reaches the node
    expect((await reg.byKey(v2.scan.previous!))?.key).toBe(v1.scan.key);
    expect(await reg.byKey(v1.evidenceKey)).toBeNull(); // not a scan entity
    expect(await reg.byKey(keccak256(toHex('missing')))).toBeNull();

    const other = new ArkivSiteRegistry({
      scanner: null,
      io: node.io,
      trustedOwners: ['0x000000000000000000000000000000000000dead'],
    });
    expect(await other.byKey(v1.scan.key)).toBeNull();
    expect(await other.findByScanId('app.example.org', v1.scan.scanId)).toBeNull();
    node.ignoreOwnerFilter = true; // even a node ignoring the owner filter cannot fool it
    expect(await other.byKey(v1.scan.key)).toBeNull();
  });

  it('publish is idempotent per (hostname, scanId)', async () => {
    const { node, reg } = setup();
    const a = leaky();
    const first = await reg.publish(a.report, a.bundle);
    const again = await reg.publish(a.report, a.bundle);
    expect(node.batches).toHaveLength(1); // nothing sent the second time
    expect(again).toEqual({
      ...first,
      scan: { ...first.scan, expiresAtBlock: 0x77d0a0 }, // read back: the expiry is now known
      txHash: null,
    });
    const b = fixedSegment();
    await reg.publish(b.report, b.bundle);
    const old = await reg.publish(a.report, a.bundle); // older but already published: returned
    expect(old.scan.key).toBe(first.scan.key);
    expect(node.batches).toHaveLength(2);
  });

  it('refuses a report older than the latest version (history never runs backwards)', async () => {
    const { node, reg } = setup();
    const newer = fixedSegment('2026-11-07T00:00:00.000Z');
    await reg.publish(newer.report, newer.bundle);
    const older = leaky('2026-11-06T00:00:00.000Z');
    await expect(reg.publish(older.report, older.bundle)).rejects.toThrow(PublishRefusedError);
    await expect(reg.publish(older.report, older.bundle)).rejects.toThrow(/does not run backwards/);
    expect(node.batches).toHaveLength(1);
  });
});
