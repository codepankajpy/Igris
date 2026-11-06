/**
 * Wallet-request audit end to end (docs/design/WALLET-REQUESTS.md): the
 * static fixtures/wallet-requests page is scanned in a real browser; after
 * the connect engine clicks "Connect wallet", the page asks for a SIWE for
 * another site, an unlimited Permit2 signature on the wrong chain and an
 * unlimited approve() transaction. Fully offline (*.test → 127.0.0.1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import {
  buildCanaryForms,
  canonicalize,
  findCanary,
  MAX_UINT160,
  MAX_UINT256,
  PERMIT2_ADDRESS,
  validateEvidenceBundle,
  validateReport,
  verifyReportIntegrity,
  type ScanResult,
  type WalletRequestEvidence,
} from '@igris/core';
import { scan } from '../src/index.js';
import { HOST_RULES, PAGE_PORT, REPO_ROOT, serveDist } from './helpers.js';

const PORT = PAGE_PORT + 60; // own port: avoid cross-file EADDRINUSE
const ORIGIN = `http://wallet-requests.test:${PORT}`;
// Synthetic, keyless, never-deployed addresses (the fixture never names a real token or spender).
const TOKEN = '0x000000000000000000000000000000000000bEEF';
const SPENDER = '0x000000000000000000000000000000000000dEaD';

let server: Server;
let result: ScanResult;

beforeAll(async () => {
  server = await serveDist(join(REPO_ROOT, 'fixtures/wallet-requests'), PORT);
  result = await scan({ url: `${ORIGIN}/`, hostResolverRules: HOST_RULES, dwellMs: 1500 });
});

afterAll(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
});

describe('wallet requests fixture', () => {
  it('names no real token or spender (safe to host publicly)', () => {
    const html = readFileSync(join(REPO_ROOT, 'fixtures/wallet-requests/index.html'), 'utf8');
    const addresses = [...new Set(html.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? [])];
    expect(addresses.sort()).toEqual([PERMIT2_ADDRESS, TOKEN, SPENDER].sort());
    // Synthetic: 18 leading zero bytes — no deployed contract, no known key.
    for (const a of [TOKEN, SPENDER]) expect(a.slice(2, 38)).toBe('0'.repeat(36));
  });

  it('connects through the "Connect wallet" button and stays offline', () => {
    expect(result.report.scan.status).toBe('completed');
    expect(result.report.scan.connection?.outcome).toBe('connected');
    expect(result.report.contacts).toEqual([]); // no third party was contacted
  });

  it('records and decodes every request, in order, from the main frame', () => {
    const w = result.report.walletRequests!;
    expect(w.map((s) => [s.method, s.kind, s.outcome])).toEqual([
      ['eth_requestAccounts', 'connect', 'answered'],
      ['personal_sign', 'siwe', 'signed'],
      ['eth_signTypedData_v4', 'permit2', 'signed'],
      ['eth_sendTransaction', 'approve', 'rejected'],
    ]);
    for (const s of w) {
      expect(s).toMatchObject({ frame: 'main', phase: 'post-connect', preConnect: false });
      expect(typeof s.t).toBe('number');
    }
    expect(w.map((s) => s.t)).toEqual([...w.map((s) => s.t)].sort((a, b) => a! - b!));
    for (const s of w) {
      const item = result.bundle.items[s.evidenceId] as WalletRequestEvidence;
      expect(item.type).toBe('wallet-request');
      expect(item.origin).toBe(ORIGIN);
    }

    expect(w[1]).toMatchObject({ siweDomain: 'evil.example', domainMismatch: true, chainId: 1 });
    expect(w[2]).toMatchObject({
      verifyingContract: PERMIT2_ADDRESS,
      token: TOKEN,
      spender: SPENDER,
      amount: MAX_UINT160.toString(),
      unlimited: true,
      longDeadline: false,
      chainId: 137,
      chainIdMismatch: true,
    });
    expect(w[3]).toMatchObject({
      token: TOKEN,
      spender: SPENDER,
      amount: MAX_UINT256.toString(),
      unlimited: true,
    });
  });

  it('raises the expected security findings (and nothing else about wallet requests)', () => {
    const found = result.report.security.observations.filter(
      (f) => f.detector === 'wallet-requests',
    );
    expect(found.map((f) => [f.kind, f.severity, f.title]).sort()).toEqual(
      [
        ['risk', 'high', 'Sign-in message is for a different site (evil.example)'],
        ['risk', 'high', 'Asked for an unlimited token permit to 0x0000…dEaD'],
        ['risk', 'high', 'Asked to approve unlimited spending of 0x0000…bEEF by 0x0000…dEaD'],
      ].sort(),
    );
    const permit = found.find((f) => /token permit/.test(f.title))!;
    expect(permit.impact).toMatch(/different chain/);
    const w = result.report.walletRequests!;
    expect(w[0]!.findingIds).toEqual([]);
    for (const s of w.slice(1)) expect(s.findingIds).toHaveLength(1);
    // Security findings never reach recipients.
    expect(result.report.recipients).toEqual([]);
  });

  it('the canary never reaches the evidence or the summaries', () => {
    const forms = buildCanaryForms(result.report.scan.canaryAddress);
    expect(findCanary(canonicalize(result.bundle), forms)).toEqual([]);
    expect(findCanary(canonicalize(result.report.walletRequests), forms)).toEqual([]);
  });

  it('the report and bundle validate and verify', () => {
    expect(result.bundle.bundleVersion).toBe('igris.evidence.v4');
    expect(() => validateReport(result.report)).not.toThrow();
    expect(() => validateEvidenceBundle(result.bundle)).not.toThrow();
    expect(verifyReportIntegrity(result.report, result.bundle)).toMatchObject({
      ok: true,
      problems: [],
    });
  });
});
