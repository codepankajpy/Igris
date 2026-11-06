/**
 * Test-only fixtures (imported by *.test.ts; not exported from index).
 */
import type { ScanResult } from '@igris/core';
import { req, sampleCapture, sampleResult } from '@igris/core/testing';

/** The leaky sample (segment, sentry, infura) scanned at `scannedAt`. */
export function leaky(scannedAt = '2026-11-06T00:00:00.000Z'): ScanResult {
  return sampleResult({ scannedAt });
}

/** Same site, different behaviour: the segment tracker is gone. */
export function fixedSegment(scannedAt = '2026-11-07T00:00:00.000Z'): ScanResult {
  const capture = sampleCapture();
  return sampleResult({
    scannedAt,
    capture: { ...capture, requests: capture.requests.filter((r) => !r.url.includes('segment')) },
  });
}

/** Another site with one RPC call. */
export function otherSite(scannedAt = '2026-11-06T12:00:00.000Z'): ScanResult {
  const capture = sampleCapture();
  return sampleResult({
    target: 'https://other.example.net/',
    scannedAt,
    capture: {
      ...capture,
      requests: [
        req({ url: 'https://other.example.net/' }),
        ...capture.requests.filter((r) => r.url.includes('segment')),
      ],
      mainDocument: { url: 'https://other.example.net/', status: 200, headers: {} },
    },
  });
}

/** The leaky sample plus a recipient that is an IPv6 literal (no hostname). */
export const IPV6_RECIPIENT = '[2606:4700::1111]';
export function withIpv6Recipient(scannedAt = '2026-11-06T00:00:00.000Z'): ScanResult {
  const capture = sampleCapture();
  return sampleResult({
    scannedAt,
    capture: {
      ...capture,
      requests: [
        ...capture.requests,
        req({
          phase: 'post-connect',
          url: 'https://[2606:4700::1111]/dns-query',
          method: 'POST',
          resourceType: 'fetch',
          body: JSON.stringify({ q: 1 }),
        }),
      ],
    },
  });
}

/** Site `host` scanned at `scannedAt`; it calls segment.io unless `segment` is false. */
export function siteN(host: string, scannedAt: string, segment = true): ScanResult {
  const capture = sampleCapture();
  return sampleResult({
    target: `https://${host}/`,
    scannedAt,
    capture: {
      ...capture,
      requests: [
        req({ url: `https://${host}/` }),
        ...capture.requests.filter(
          (r) => r.url.includes('googleapis') || (segment && r.url.includes('segment')),
        ),
      ],
      mainDocument: { url: `https://${host}/`, status: 200, headers: {} },
    },
  });
}
