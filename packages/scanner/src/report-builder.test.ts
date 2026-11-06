/**
 * Unit tests for P0-1/2/3/10: what a report may claim given what was (and
 * was not) captured.
 */
import { describe, expect, it } from 'vitest';
import type { ScanStatus } from '@igris/core';
import type { Capture, CapturedRequest } from './capture.js';
import { buildReport, securityHeadersFromCapture } from './report-builder.js';
import { WalletReadHandler } from './stub-rpc.js';

const CANARY = '0x8ba1f109551bd432803012645ac136ddd64dba72';

function req(over: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    phase: 'pre-connect',
    url: 'https://app.example.org/',
    method: 'GET',
    headers: {},
    body: null,
    resourceType: 'document',
    failed: false,
    setCookies: [],
    ...over,
  };
}

function capture(over: Partial<Capture> = {}): Capture {
  return { requests: [], wsFrames: [], wsConnections: 0, storage: [], cookies: [], ...over };
}

function build(c: Capture, status: ScanStatus = 'completed') {
  return buildReport({
    target: 'https://app.example.org/',
    canaryAddress: CANARY,
    chainId: 1,
    spoofMetaMask: true,
    scannerVersion: 'test',
    scannedAt: '2026-11-06T00:00:00.000Z',
    status,
    capture: c,
    readHandler: new WalletReadHandler(),
    thirdPartyDb: [],
    errors: [],
  });
}

describe('security headers come from the main document response (P0-3)', () => {
  it('positive: CSP + HSTS + XFO on the main document are reported present', () => {
    const r = build(
      capture({
        requests: [req()],
        mainDocument: {
          url: 'https://app.example.org/',
          status: 200,
          headers: {
            'content-security-policy': "default-src 'self'",
            'strict-transport-security': 'max-age=31536000',
            'x-frame-options': 'DENY',
          },
        },
      }),
    );
    expect(r.securityHeaders).toEqual({
      documentUrl: 'https://app.example.org/',
      documentStatus: 200,
      cspPresent: true,
      cspReportOnly: false,
      hstsPresent: true,
      xFrameOptions: 'DENY',
    });
  });

  it('negative: a main document without them is reported missing', () => {
    const r = build(
      capture({
        requests: [req()],
        mainDocument: { url: 'https://app.example.org/', status: 200, headers: {} },
      }),
    );
    expect(r.securityHeaders?.cspPresent).toBe(false);
    expect(r.securityHeaders?.hstsPresent).toBe(false);
  });

  it('report-only CSP is not counted as an enforced CSP', () => {
    const h = securityHeadersFromCapture(
      capture({
        mainDocument: {
          url: 'https://a.org/',
          status: 200,
          headers: { 'content-security-policy-report-only': "default-src 'self'" },
        },
      }),
    );
    expect(h?.cspPresent).toBe(false);
    expect(h?.cspReportOnly).toBe(true);
  });

  it('regression: request headers never count as security headers', () => {
    const r = build(
      capture({
        requests: [
          req({
            headers: {
              'content-security-policy': 'x',
              'strict-transport-security': 'x',
            },
          }),
        ],
        mainDocument: { url: 'https://app.example.org/', status: 200, headers: {} },
      }),
    );
    expect(r.securityHeaders?.cspPresent).toBe(false);
    expect(r.securityHeaders?.hstsPresent).toBe(false);
  });

  it('unknown, never "missing": no observed main document → no securityHeaders', () => {
    const r = build(capture({ requests: [req()] }));
    expect(r.securityHeaders).toBeUndefined();
  });
});

describe('score and coverage are truthful (P0-1, P0-2)', () => {
  it('page-load-failed → score null, empty ledger, coverage none', () => {
    const r = build(capture(), 'page-load-failed');
    expect(r.score).toBeNull();
    expect(r.ledger).toEqual([]);
    expect(r.coverage).toBe('none');
  });

  it('page-load-failed stays unscored even when some third-party traffic was captured', () => {
    const r = build(
      capture({ requests: [req({ url: 'https://tracker.example.net/p', resourceType: 'image' })] }),
      'page-load-failed',
    );
    expect(r.score).toBeNull();
  });

  it('wallet-connect-failed → scored, but coverage pre-connect-only', () => {
    const r = build(capture({ requests: [req()] }), 'wallet-connect-failed');
    expect(r.score).toBe(100);
    expect(r.coverage).toBe('pre-connect-only');
  });

  it('completed → coverage full', () => {
    expect(build(capture({ requests: [req()] })).coverage).toBe('full');
  });
});

describe('counts are truthful (P0-10)', () => {
  it('WebSocket connections and frames are counted separately', () => {
    const frame = {
      phase: 'post-connect' as const,
      url: 'wss://relay.example.net/',
      direction: 'sent' as const,
      payload: 'hello',
    };
    const r = build(capture({ wsConnections: 1, wsFrames: [frame, frame, frame] }));
    expect(r.summary?.wsConnections).toBe(1);
    expect(r.summary?.wsFrames).toBe(3);
  });
});
