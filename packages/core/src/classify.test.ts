import { describe, expect, it } from 'vitest';
import { classifyHost, registrableDomain } from './classify.js';
import { loadThirdPartyDb } from './third-parties.js';

const db = loadThirdPartyDb().entries;
const opts = { targetRegistrableDomain: 'example.com', db };

describe('registrableDomain', () => {
  it('resolves eTLD+1 for ICANN domains', () => {
    expect(registrableDomain('mainnet.infura.io')).toBe('infura.io');
    expect(registrableDomain('a.b.app.example.co.uk')).toBe('example.co.uk');
  });
  it('falls back for .test fixture hosts', () => {
    expect(registrableDomain('rpc.igris-rpc.test')).toBe('igris-rpc.test');
  });
  it('handles localhost and IPs', () => {
    expect(registrableDomain('localhost')).toBe('localhost');
    expect(registrableDomain('127.0.0.1')).toBe('127.0.0.1');
  });
});

describe('classifyHost', () => {
  it('first-party by registrable domain', () => {
    expect(classifyHost('app.example.com', opts).class).toBe('first-party');
  });
  it('first-party by --first-party list', () => {
    const c = classifyHost('api.other.io', { ...opts, firstParty: ['other.io'] });
    expect(c.class).toBe('first-party');
  });
  it('known RPC provider by registrable domain, any subdomain', () => {
    expect(classifyHost('mainnet.infura.io', opts).class).toBe('rpc-provider');
    expect(classifyHost('eth-mainnet.g.alchemy.com', opts).class).toBe('rpc-provider');
  });
  it('known analytics', () => {
    expect(classifyHost('www.google-analytics.com', opts).class).toBe('analytics');
  });
  it('suffix rule: sentry ingest subdomains', () => {
    const c = classifyHost('o4504609null.ingest.sentry.io', opts);
    expect(c.class).toBe('error-monitoring');
    expect(c.matchedEntry).toBe('Sentry');
  });
  it('fixture sink hosts', () => {
    expect(classifyHost('rpc.igris-rpc.test', opts).class).toBe('rpc-provider');
    expect(classifyHost('ingest.igris-analytics.test', opts).class).toBe('analytics');
    expect(classifyHost('o1.igris-errors.test', opts).class).toBe('error-monitoring');
  });
  it('everything else is unknown-third-party', () => {
    expect(classifyHost('totally-unknown-tracker.xyz', opts).class).toBe('unknown-third-party');
  });
  it('a suffix rule must match on label boundaries', () => {
    // evil-ingest.sentry.io.attacker.com must NOT match the sentry suffix.
    expect(classifyHost('ingest.sentry.io.attacker.com', opts).class).toBe('unknown-third-party');
  });
});
