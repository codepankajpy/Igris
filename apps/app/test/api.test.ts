import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  API_ORIGIN,
  apiUrl,
  startScan,
  type FlowEntity,
  type PublishedScan,
  type SiteResponse,
  type VersionResponse,
  type WalletRequestEntity,
} from '../src/api.js';

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('starting a scan: POST /api/sites/:hostname/scans → 202 { id }', () => {
  it('returns the new job id', async () => {
    respond(202, { id: 'job-1' });
    expect(await startScan('app.example.org')).toEqual({ id: 'job-1' });
  });
  it('409 (a scan is running) → that scan', async () => {
    respond(409, { error: 'a scan of this site is running', id: 'job-3' });
    expect(await startScan('app.example.org')).toEqual({ id: 'job-3' });
  });
  it('other errors are thrown', async () => {
    respond(503, { error: 'queue full' });
    await expect(startScan('app.example.org')).rejects.toThrow('queue full');
  });
});

describe('API origin (VITE_IGRIS_API_URL, fixed at build time)', () => {
  it('unset: every call stays on this same origin', async () => {
    expect(API_ORIGIN).toBe('');
    expect(apiUrl('/api/scans/x/events')).toBe('/api/scans/x/events');
    respond(202, { id: 'job-1' });
    await startScan('app.example.org');
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/sites/app.example.org/scans');
  });
});

describe('response types are what the API sends (apps/api/src/public.ts)', () => {
  it('no signer address: no owner on scans, flows, wallet requests', () => {
    expectTypeOf<PublishedScan>().not.toHaveProperty('owner');
    expectTypeOf<FlowEntity>().not.toHaveProperty('owner');
    expectTypeOf<WalletRequestEntity>().not.toHaveProperty('owner');
  });
  it('one scanner: no request on scans, no rounds on a site, no node on a version', () => {
    expectTypeOf<PublishedScan>().not.toHaveProperty('request');
    expectTypeOf<SiteResponse>().not.toHaveProperty('rounds');
    expectTypeOf<VersionResponse>().not.toHaveProperty('node');
  });
});
