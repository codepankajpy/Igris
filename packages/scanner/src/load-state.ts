/**
 * Why a page is not the dapp: unavailable, bot-blocked (interstitial), or
 * browser-incompatible. Conservative by design — only explicit markers count,
 * so a working app that merely embeds a Turnstile widget (Uniswap) is NOT
 * "bot-blocked". Pure decision function + a small page reader.
 */
import type { Page, Response } from 'playwright';
import type { FailureCategory } from '@igris/core';

export interface LoadObservation {
  /** Navigation error message (DNS, refused, timeout…) when goto threw. */
  error?: string;
  status?: number;
  /** Lower-cased response headers of the main document. */
  headers?: Record<string, string>;
  title?: string;
  /** First ~2000 chars of visible body text. */
  bodyText?: string;
}

export interface LoadVerdict {
  ok: boolean;
  category?: FailureCategory;
  detail?: string;
}

/** Titles of well-known bot-protection interstitials (Cloudflare, Akamai, Vercel, DataDome, PerimeterX). */
const INTERSTITIAL_TITLE =
  /^(just a moment|attention required|access denied|security checkpoint|vercel security checkpoint|checking your browser|please wait|pardon our interruption|verifying you are human|one more step)\b/i;
const CHALLENGE_BODY =
  /(verify(ing)? you are (a )?human|checking (if the site connection is secure|your browser)|enable javascript and cookies to continue|press (&|and) hold|are you a robot)/i;
const INCOMPATIBLE_BODY =
  /(unsupported browser|browser (is )?not supported|please (use|switch to) (a )?(supported|different|modern) browser|this (site|app) requires (chrome|a desktop browser))/i;

export function classifyLoad(o: LoadObservation): LoadVerdict {
  if (o.error) {
    const e = o.error;
    const why = /ERR_NAME_NOT_RESOLVED/.test(e)
      ? 'DNS name not resolved'
      : /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/.test(e)
        ? 'connection refused/reset'
        : /Timeout|ERR_TIMED_OUT/.test(e)
          ? 'navigation timeout'
          : /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY/.test(e)
            ? 'refused by egress policy'
            : 'navigation error';
    return { ok: false, category: 'site-unavailable', detail: `${why}: ${e.slice(0, 160)}` };
  }
  if (o.headers?.['x-igris-egress'] === 'blocked') {
    // The scanner's own egress proxy refused the target (non-public address).
    return {
      ok: false,
      category: 'site-unavailable',
      detail: 'refused by egress policy (non-public address)',
    };
  }
  const title = (o.title ?? '').trim();
  const body = (o.bodyText ?? '').trim();
  const mitigated = o.headers?.['cf-mitigated'] === 'challenge';
  const interstitial =
    mitigated || INTERSTITIAL_TITLE.test(title) || (body.length < 600 && CHALLENGE_BODY.test(body));
  if (interstitial) {
    return {
      ok: false,
      category: 'bot-blocked',
      detail: `bot-protection interstitial (${mitigated ? 'cf-mitigated: challenge' : `title "${title.slice(0, 60)}"`}, HTTP ${o.status ?? '?'})`,
    };
  }
  if (o.status !== undefined && o.status >= 400) {
    return {
      ok: false,
      category: 'site-unavailable',
      detail: `main document returned HTTP ${o.status}`,
    };
  }
  if (INCOMPATIBLE_BODY.test(body.slice(0, 2000))) {
    return {
      ok: false,
      category: 'browser-incompatible',
      detail: 'page states the browser is unsupported',
    };
  }
  return { ok: true };
}

/** Read title, headers and visible text for classifyLoad (best effort). */
export async function observeLoad(page: Page, response: Response | null): Promise<LoadObservation> {
  const o: LoadObservation = {};
  if (response) {
    o.status = response.status();
    try {
      o.headers = Object.fromEntries(
        Object.entries(await response.allHeaders()).map(([k, v]) => [k.toLowerCase(), v]),
      );
    } catch {
      /* ignore */
    }
  }
  try {
    o.title = await page.title();
    o.bodyText = String(
      await page.evaluate('(document.body && document.body.innerText || "").slice(0, 2000)'),
    );
  } catch {
    /* page gone */
  }
  return o;
}
