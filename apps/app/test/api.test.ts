import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  requestFor,
  startScan,
  type FlowEntity,
  type PublishedScan,
  type RoundResponse,
  type ScanRequest,
  type WalletRequestEntity,
} from '../src/api.js';

const REQ: ScanRequest = {
  key: `0x${'7'.repeat(64)}`,
  hostname: 'app.example.org',
  url: 'https://app.example.org/',
  requestedAt: 1_790_000_000,
  expiresAtBlock: null,
};

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('starting a scan: POST /api/sites/:hostname/scans → { id, request }', () => {
  it('returns the job and its request, and remembers the request for the live page', async () => {
    respond(202, { id: 'job-1', request: REQ });
    expect(await startScan('app.example.org')).toEqual({ id: 'job-1', request: REQ });
    expect(requestFor('job-1')).toEqual(REQ);
  });
  it('a node that made no request entity answers request: null — nothing is remembered', async () => {
    respond(202, { id: 'job-2', request: null });
    expect(await startScan('app.example.org')).toEqual({ id: 'job-2', request: null });
    expect(requestFor('job-2')).toBeNull();
  });
  it('409 (a scan is running) → that scan, whose request is not known', async () => {
    respond(409, { error: 'a scan of this site is running', id: 'job-3' });
    expect(await startScan('app.example.org')).toEqual({ id: 'job-3', request: null });
  });
  it('other errors are thrown', async () => {
    respond(503, { error: 'queue full' });
    await expect(startScan('app.example.org')).rejects.toThrow('queue full');
  });
  it('storage that throws (private mode, blocked) never breaks the page: memory only', async () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    vi.stubGlobal('sessionStorage', broken);
    respond(202, { id: 'job-4', request: REQ });
    expect((await startScan('app.example.org')).request).toEqual(REQ);
    expect(requestFor('job-4')).toEqual(REQ);
    expect(requestFor('unknown')).toBeNull();
  });
  it('a reload of the live scan page (fresh module) reads the request back from sessionStorage', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    respond(202, { id: 'job-5', request: REQ });
    await startScan('app.example.org');
    vi.resetModules();
    const fresh = await import('../src/api.js');
    expect(fresh.requestFor('job-5')).toEqual(REQ);
    store.set('igris.request.job-6', '{"not":"a request"}');
    expect(fresh.requestFor('job-6')).toBeNull();
  });
});

describe('response types are what the API sends (apps/api/src/public.ts)', () => {
  it('no signer address: no owner on scans, flows, wallet requests; no creator on requests', () => {
    expectTypeOf<PublishedScan>().not.toHaveProperty('owner');
    expectTypeOf<FlowEntity>().not.toHaveProperty('owner');
    expectTypeOf<WalletRequestEntity>().not.toHaveProperty('owner');
    expectTypeOf<ScanRequest>().not.toHaveProperty('creator');
    expect(Object.keys(REQ)).not.toContain('creator');
  });
  it('a round of an expired request comes back with request: null', () => {
    expectTypeOf<RoundResponse['request']>().toEqualTypeOf<ScanRequest | null>();
  });
});
