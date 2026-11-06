import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '@igris/core';
import { sampleResult, sampleResultV2 } from '@igris/core/testing';
import { LOCAL_FILE_FORMAT, LocalSiteRegistry } from './local.js';
import { decodePayload, encodePayload, type WireEntity } from './payload.js';
import { PublishRefusedError } from './site-registry.js';
import { ScanLoadError } from './verify.js';
import { diffVersions } from './diff.js';
import {
  IPV6_RECIPIENT,
  fixedSegment,
  leaky,
  otherSite,
  siteN,
  withIpv6Recipient,
} from './test-fixtures.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'igris-local-'));
  file = join(dir, 'registry.json');
});

const readEntities = (): WireEntity[] =>
  (JSON.parse(readFileSync(file, 'utf8')) as { entities: WireEntity[] }).entities;
const writeEntities = (entities: unknown[]) =>
  writeFileSync(file, JSON.stringify({ format: LOCAL_FILE_FORMAT, entities }));
const attr = (e: WireEntity, name: string) => e.attributes.find((a) => a.name === name)!;
const schemaOf = (e: WireEntity) => attr(e, 'arkiv.schema').value;

describe('LocalSiteRegistry end to end', () => {
  it('publishes v1, a retest becomes v2 linked to v1, and both load verified', async () => {
    const reg = new LocalSiteRegistry({ file, publisher: 'igris-test' });
    expect(reg.trustedOwners).toEqual(['igris-test']);
    expect(await reg.latest('app.example.org')).toBeNull();
    expect(await reg.recentSites()).toEqual([]);

    const a = leaky();
    const v1 = await reg.publish(a.report, a.bundle);
    expect(v1.txHash).toBeNull();
    expect(v1.scan).toMatchObject({
      hostname: 'app.example.org',
      version: 1,
      previous: null,
      owner: 'igris-test',
      scanId: contentHash(a.report),
      state: 'address-to-trackers',
      expiresAtBlock: null,
    });
    expect(v1.scan.key).toMatch(/^local:[0-9a-f]{64}$/);
    expect(v1.evidenceKey).toMatch(/^local:[0-9a-f]{64}$/);
    expect(v1.flowKeys).toHaveLength(4);
    // one scan + one evidence + four flows, nothing else; no temp files left behind
    expect(readEntities().map(schemaOf)).toEqual([
      'igris.scan.v2',
      'igris.evidence.v1',
      'igris.flow.v1',
      'igris.flow.v1',
      'igris.flow.v1',
      'igris.flow.v1',
    ]);
    expect(readdirSync(dir)).toEqual(['registry.json']);

    const b = fixedSegment();
    const v2 = await reg.publish(b.report, b.bundle);
    expect(v2.scan).toMatchObject({ version: 2, previous: v1.scan.key, recipients: 3 });

    const versions = await reg.versions('app.example.org');
    expect(versions.map((s) => s.version)).toEqual([2, 1]);
    expect(versions).toEqual([v2.scan, v1.scan]);
    expect(await reg.latest('app.example.org')).toEqual(v2.scan);
    expect(await reg.version('app.example.org', 1)).toEqual(v1.scan);
    expect(await reg.version('app.example.org', 3)).toBeNull();
    expect(await reg.versions('app.example.org', { limit: 1 })).toEqual([v2.scan]);

    const loaded1 = await reg.load(v1.scan);
    expect(loaded1).toMatchObject({ verified: true, problems: [] });
    expect(loaded1.report).toEqual(JSON.parse(JSON.stringify(a.report)));
    expect(loaded1.bundle).toEqual(a.bundle);
    const loaded2 = await reg.load(v2.scan);
    expect(loaded2.verified).toBe(true);

    const changes = diffVersions(loaded1.report, loaded2.report);
    expect(changes.sameBehaviour).toBe(false);
    expect(changes.removed).toEqual([{ registrableDomain: 'segment.io', class: 'analytics' }]);
  });

  it('recentSites: latest version per hostname, newest first', async () => {
    const reg = new LocalSiteRegistry({ file, publisher: 'igris-test' });
    const a = leaky('2026-11-06T00:00:00.000Z');
    const o = otherSite('2026-11-06T12:00:00.000Z');
    const b = fixedSegment('2026-11-07T00:00:00.000Z');
    await reg.publish(a.report, a.bundle);
    await reg.publish(o.report, o.bundle);
    await reg.publish(b.report, b.bundle);
    const recent = await reg.recentSites();
    expect(recent.map((s) => [s.hostname, s.version])).toEqual([
      ['app.example.org', 2],
      ['other.example.net', 1],
    ]);
    expect((await reg.recentSites({ limit: 1 })).map((s) => s.hostname)).toEqual([
      'app.example.org',
    ]);
  });

  it('flowsTo: only the latest version of each site', async () => {
    const reg = new LocalSiteRegistry({ file, publisher: 'igris-test' });
    const a = leaky();
    await reg.publish(a.report, a.bundle);
    const o = otherSite();
    await reg.publish(o.report, o.bundle);
    expect((await reg.flowsTo('segment.io')).map((f) => [f.hostname, f.version])).toEqual([
      ['other.example.net', 1],
      ['app.example.org', 1],
    ]);
    const b = fixedSegment();
    await reg.publish(b.report, b.bundle); // app.example.org v2 no longer sends to segment
    expect((await reg.flowsTo('segment.io')).map((f) => f.hostname)).toEqual(['other.example.net']);
    expect((await reg.flowsTo('infura.io')).map((f) => [f.hostname, f.version, f.verdict])).toEqual(
      [['app.example.org', 2, 'avoidable']],
    );
    expect(await reg.flowsTo('not a domain')).toEqual([]);
  });

  it('keys are deterministic', async () => {
    const a = leaky();
    const r1 = await new LocalSiteRegistry({ file, publisher: 'igris-test' }).publish(
      a.report,
      a.bundle,
    );
    const other = join(dir, 'b.json');
    const r2 = await new LocalSiteRegistry({ file: other, publisher: 'igris-test' }).publish(
      a.report,
      a.bundle,
    );
    expect(r2.scan.key).toBe(r1.scan.key);
    expect(r2.flowKeys).toEqual(r1.flowKeys);
    expect(readFileSync(other, 'utf8')).toBe(readFileSync(file, 'utf8'));
  });

  it('concurrent publishes of one hostname get distinct versions', async () => {
    const reg = new LocalSiteRegistry({ file, publisher: 'igris-test' });
    const a = leaky();
    const b = fixedSegment();
    const [x, y] = await Promise.all([
      reg.publish(a.report, a.bundle),
      reg.publish(b.report, b.bundle),
    ]);
    expect([x.scan.version, y.scan.version]).toEqual([1, 2]);
    expect(y.scan.previous).toBe(x.scan.key);
  });
});

describe('LocalSiteRegistry verification on read', () => {
  async function published() {
    const reg = new LocalSiteRegistry({ file, publisher: 'igris-test' });
    const a = leaky();
    const res = await reg.publish(a.report, a.bundle);
    return { reg, res, a };
  }

  it('a tampered stored report loads with verified false and the problems', async () => {
    const { reg, res } = await published();
    const entities = readEntities();
    const scan = entities.find((e) => e.key === res.scan.key)!;
    const report = decodePayload(attr(scan, 'report').value as string) as {
      recipients: Array<{ verdict: string }>;
    };
    report.recipients[0]!.verdict = 'expected'; // segment.io was "tracking"
    attr(scan, 'report').value = `0x${Buffer.from(encodePayload(report)).toString('hex')}`;
    writeEntities(entities);
    const loaded = await reg.load(res.scan);
    expect(loaded.verified).toBe(false);
    expect(loaded.problems.join('\n')).toMatch(/report hash .* != scanId/);
    expect(loaded.problems.join('\n')).toMatch(/recipients do not match/);
  });

  it('tampered stored evidence loads with verified false', async () => {
    const { reg, res } = await published();
    const entities = readEntities();
    const ev = entities.find((e) => e.key === res.evidenceKey)!;
    const other = sampleResult({ target: 'https://x.example.com/' }).bundle;
    attr(ev, 'bundle').value = `0x${Buffer.from(encodePayload(other)).toString('hex')}`;
    writeEntities(entities);
    const loaded = await reg.load(res.scan);
    expect(loaded.verified).toBe(false);
    expect(loaded.problems.join('\n')).toMatch(/evidence hash .* != entity evidenceSha256/);
  });

  it('an edited indexed attribute is reported', async () => {
    const { reg, res } = await published();
    const entities = readEntities();
    attr(
      entities.find((e) => e.key === res.scan.key)!,
      'state',
    ).value = 'no-address-observed';
    writeEntities(entities);
    const scan = (await reg.latest('app.example.org'))!;
    const loaded = await reg.load(scan);
    expect(loaded.verified).toBe(false);
    expect(loaded.problems).toContain(
      'entity state no-address-observed != report address-to-trackers',
    );
  });

  it('an unreadable payload or missing evidence is a ScanLoadError', async () => {
    const { reg, res } = await published();
    const entities = readEntities();
    attr(
      entities.find((e) => e.key === res.scan.key)!,
      'report',
    ).value = '0x00';
    writeEntities(entities);
    await expect(reg.load(res.scan)).rejects.toThrow(ScanLoadError);
    writeEntities(readEntities().filter((e) => e.key !== res.evidenceKey));
    await expect(reg.load(res.scan)).rejects.toThrow(/no evidence entity/);
  });
});

describe('LocalSiteRegistry refusals and hostile data', () => {
  it('refuses non-3.0.0, coverage none, integrity failure, oversize, read-only', async () => {
    const reg = new LocalSiteRegistry({ file, publisher: 'igris-test' });
    const v2 = sampleResultV2();
    await expect(reg.publish(v2.report as never, v2.bundle)).rejects.toThrow(PublishRefusedError);

    const none = sampleResult({ status: 'page-load-failed' });
    expect(none.report.privacy.coverage).toBe('none');
    await expect(reg.publish(none.report, none.bundle)).rejects.toThrow(/coverage "none"/);

    const a = leaky();
    const tampered = structuredClone(a.report);
    tampered.recipients[1]!.verdict = 'expected';
    await expect(reg.publish(tampered, a.bundle)).rejects.toThrow(/integrity/);

    const huge = structuredClone(a.report);
    huge.scan.notes = [randomBytes(200_000).toString('base64')];
    await expect(reg.publish(huge, a.bundle)).rejects.toThrow(/after gzip/);

    expect(existsSync(file)).toBe(false); // nothing was written

    const ro = new LocalSiteRegistry({ file, publisher: null });
    expect(ro.trustedOwners).toEqual([]);
    await expect(ro.publish(a.report, a.bundle)).rejects.toThrow(/read-only/);
  });

  it('skips hostile rows and untrusted owners, never throws on read', async () => {
    const reg = new LocalSiteRegistry({ file, publisher: 'igris-test' });
    const a = leaky();
    const res = await reg.publish(a.report, a.bundle);
    const entities = readEntities();
    const scan = entities.find((e) => e.key === res.scan.key)!;
    const clone = (over: (e: WireEntity) => void, key: string): WireEntity => {
      const e = structuredClone(scan);
      e.key = key;
      over(e);
      return e;
    };
    const k = (c: string) => `local:${c.repeat(64)}`;
    writeEntities([
      ...entities,
      null,
      42,
      { key: k('1') },
      clone((e) => (attr(e, 'version').value = 'nine'), k('2')),
      clone((e) => (attr(e, 'hostname').value = 'APP.example.org'), k('3')),
      clone((e) => (attr(e, 'scanId').value = 'xyz'), k('4')),
      clone((e) => (attr(e, 'state').value = 'not-observed'), k('5')),
      clone((e) => (attr(e, 'recipients').value = -1), k('6')),
      clone((e) => (attr(e, 'arkiv.schema').value = 'igris.scan.v1'), k('7')),
      clone((e) => (attr(e, 'version').value = 2), k('8')), // v2 with previous "" is invalid
      clone((e) => (e.owner = 'mallory'), k('9')), // valid row, untrusted owner
    ]);
    expect((await reg.versions('app.example.org')).map((s) => s.key)).toEqual([res.scan.key]);
    expect((await reg.recentSites()).map((s) => s.key)).toEqual([res.scan.key]);

    // A registry trusting mallory sees only mallory's row; publishing as igris-test
    // still numbers after every trusted-or-own version.
    const both = new LocalSiteRegistry({
      file,
      publisher: 'igris-test',
      trustedOwners: ['mallory'],
    });
    expect((await both.versions('app.example.org')).map((s) => s.owner)).toEqual(['mallory']);
    const b = fixedSegment();
    expect((await both.publish(b.report, b.bundle)).scan.version).toBe(2);
  });

  it('a corrupt file reads as empty and is never overwritten', async () => {
    writeFileSync(file, '{ not json');
    const reg = new LocalSiteRegistry({ file, publisher: 'igris-test' });
    expect(await reg.versions('app.example.org')).toEqual([]);
    expect(reg.lastReadProblem).toMatch(/cannot read local registry/);
    expect((await reg.status()).ready).toBe(false);
    const a = leaky();
    await expect(reg.publish(a.report, a.bundle)).rejects.toThrow(/cannot read local registry/);
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
  });
});

describe('LocalSiteRegistry regressions (one-flow review)', () => {
  it('an IPv6-literal recipient does not block publishing; only its flow is omitted', async () => {
    const reg = new LocalSiteRegistry({ file, publisher: 'igris-test' });
    const a = withIpv6Recipient();
    const res = await reg.publish(a.report, a.bundle);
    expect(res.scan.recipients).toBe(5);
    expect(res.flowKeys).toHaveLength(4);
    const loaded = await reg.load(res.scan);
    expect(loaded.verified).toBe(true);
    expect(loaded.report.recipients.map((r) => r.registrableDomain)).toContain(IPV6_RECIPIENT);
    expect(await reg.flowsTo(IPV6_RECIPIENT)).toEqual([]);
    expect((await reg.flowsTo('segment.io')).map((f) => f.hostname)).toEqual(['app.example.org']);
  });

  it('flowsTo filters to latest versions BEFORE applying the limit', async () => {
    const reg = new LocalSiteRegistry({ file, publisher: 'igris-test' });
    const old = siteN('old.example.com', '2026-11-01T00:00:00.000Z');
    const v1 = siteN('new.example.com', '2026-11-03T00:00:00.000Z');
    const v2 = siteN('new.example.com', '2026-11-04T00:00:00.000Z', false); // stopped
    for (const r of [old, v1, v2]) await reg.publish(r.report, r.bundle);
    expect(
      (await reg.flowsTo('segment.io', { limit: 1 })).map((f) => [f.hostname, f.version]),
    ).toEqual([['old.example.com', 1]]);
  });

  it('findByScanId and byKey read trusted owners only', async () => {
    const reg = new LocalSiteRegistry({ file, publisher: 'igris-test' });
    const a = leaky();
    const v1 = await reg.publish(a.report, a.bundle);
    const b = fixedSegment();
    const v2 = await reg.publish(b.report, b.bundle);
    expect(await reg.findByScanId('app.example.org', contentHash(a.report))).toEqual(v1.scan);
    expect(await reg.findByScanId('app.example.org', contentHash(b.report))).toEqual(v2.scan);
    expect(await reg.findByScanId('other.example.net', contentHash(a.report))).toBeNull();
    expect(await reg.findByScanId('app.example.org', 'f'.repeat(64))).toBeNull();
    expect(await reg.findByScanId('app.example.org', 'not-a-sha')).toBeNull();
    expect(await reg.byKey(v2.scan.previous!)).toEqual(v1.scan);
    expect(await reg.byKey(v2.scan.key)).toEqual(v2.scan);
    expect(await reg.byKey(v1.evidenceKey)).toBeNull(); // not a scan entity
    expect(await reg.byKey(`local:${'0'.repeat(64)}`)).toBeNull();
    expect(await reg.byKey('../etc/passwd')).toBeNull();
    const untrusting = new LocalSiteRegistry({ file, publisher: null, trustedOwners: ['mallory'] });
    expect(await untrusting.byKey(v1.scan.key)).toBeNull();
    expect(await untrusting.findByScanId('app.example.org', v1.scan.scanId)).toBeNull();
  });

  it('publish is idempotent per (hostname, scanId)', async () => {
    const reg = new LocalSiteRegistry({ file, publisher: 'igris-test' });
    const a = leaky();
    const first = await reg.publish(a.report, a.bundle);
    const before = readFileSync(file, 'utf8');
    const again = await reg.publish(a.report, a.bundle);
    expect(again).toEqual(first);
    expect(readFileSync(file, 'utf8')).toBe(before); // nothing written
    const b = fixedSegment();
    const v2 = await reg.publish(b.report, b.bundle);
    // re-publishing an older, already-published report returns that version, not a refusal
    expect(await reg.publish(a.report, a.bundle)).toEqual(first);
    expect((await reg.versions('app.example.org')).map((s) => s.version)).toEqual([2, 1]);
    expect(v2.scan.version).toBe(2);
  });

  it('refuses a report older than the latest version (history never runs backwards)', async () => {
    const reg = new LocalSiteRegistry({ file, publisher: 'igris-test' });
    const newer = fixedSegment('2026-11-07T00:00:00.000Z');
    await reg.publish(newer.report, newer.bundle);
    const older = leaky('2026-11-06T00:00:00.000Z');
    await expect(reg.publish(older.report, older.bundle)).rejects.toThrow(PublishRefusedError);
    await expect(reg.publish(older.report, older.bundle)).rejects.toThrow(/does not run backwards/);
    expect((await reg.versions('app.example.org')).map((s) => s.version)).toEqual([1]);
    // same second is allowed (not strictly older)
    const same = leaky('2026-11-07T00:00:00.000Z');
    expect((await reg.publish(same.report, same.bundle)).scan.version).toBe(2);
  });
});
