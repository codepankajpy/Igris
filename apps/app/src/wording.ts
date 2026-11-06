/**
 * Display wording derived from what the backend returned — pure functions,
 * no decisions of their own, unit-tested in test/wording.test.ts.
 */
import type { Recipient } from '@igris/core/contracts';
import type { PublishedScan, RegistryInfo } from './api.js';
import { phases } from './report/lookup.js';

// ------------------------------------------------------------- provenance

/**
 * Where the report on screen comes from. `source` is the backend's: 'arkiv'
 * means it was read back from Arkiv; 'local' means this server served it from
 * its own store — which, when the registry is Arkiv, is the cache of what it
 * published (or of a scan it has not published yet).
 */
export function provenance(
  d: { source: 'arkiv' | 'local'; scan: PublishedScan | null },
  mode: RegistryInfo['mode'] | undefined,
): string {
  const cache = 'served from this server’s cache';
  if (d.scan === null)
    return mode === 'local'
      ? `Not saved to the local registry yet · ${cache}`
      : `Not published on Arkiv yet · ${cache}`;
  if (d.source === 'arkiv') return 'Published on Arkiv';
  if (mode === 'arkiv') return `Published on Arkiv · ${cache}`;
  if (mode === 'local') return 'Stored in the local registry';
  return 'Served from this server’s store';
}

/** True when what is shown is (also) on Arkiv, so the network name applies. */
export function onArkiv(
  d: { source: 'arkiv' | 'local'; scan: PublishedScan | null },
  mode: RegistryInfo['mode'] | undefined,
): boolean {
  return d.scan !== null && (d.source === 'arkiv' || mode === 'arkiv');
}

/**
 * The verification status line. Problems are never hidden behind a check
 * mark: any problem the backend reported is counted, verified or not.
 */
export function proofStatus(d: { verified: boolean; problems: readonly string[] }): {
  ok: boolean;
  text: string;
} {
  const n = d.problems.length;
  const count = `${n} problem${n === 1 ? '' : 's'}`;
  if (d.verified && n === 0) return { ok: true, text: 'verified ✓' };
  if (d.verified) return { ok: false, text: `verified · ${count}` };
  return { ok: false, text: n === 0 ? 'verification failed' : `verification failed · ${count}` };
}

// ------------------------------------------------------------- history

/**
 * How a version compares with the one before it, by version number — never by
 * list position: the list the API returns may skip versions (expired, or
 * from an owner that is not trusted).
 */
export function railChange(v: PublishedScan, versions: readonly PublishedScan[]): string {
  if (v.version === 1 || v.previous === null) return 'first version';
  const prev = versions.find((x) => x.version === v.version - 1);
  if (!prev) return 'previous version not listed';
  return prev.findingSetSha256 === v.findingSetSha256
    ? `same finding set as v${prev.version}`
    : `finding set differs from v${prev.version}`;
}

// ------------------------------------------------------------- live scan

/**
 * Elapsed time of a scan without mixing clocks. Server timestamps (`t0`,
 * `anchor.at`, `finishedAt`) are only subtracted from server timestamps; the
 * browser clock (`now`, `anchor.seenAt`) only from the browser clock.
 *  - finished: finishedAt − t0 (the job's own times), else the last event's
 *    time − t0 until the job has been re-fetched;
 *  - running: (last server time seen − t0) + (browser time since it was seen).
 * Null when the scan has not started.
 */
export function elapsedMs(o: {
  t0: string | undefined;
  anchor: { at: string; seenAt: number } | undefined;
  finishedAt: string | undefined;
  finished: boolean;
  now: number;
}): number | null {
  if (!o.t0) return null;
  const t0 = Date.parse(o.t0);
  if (o.finished) {
    const end = o.finishedAt ?? o.anchor?.at;
    return end ? Math.max(0, Date.parse(end) - t0) : null;
  }
  if (!o.anchor) return 0;
  return Math.max(0, Date.parse(o.anchor.at) - t0 + Math.max(0, o.now - o.anchor.seenAt));
}

// ------------------------------------------------------------- recipients

/**
 * learned.ip lists the phases with HTTP(S) contact; [] means the recipient was
 * contacted over WebSocket only. A WebSocket connection reveals the IP too.
 */
export function ipText(r: Pick<Recipient, 'learned'>): string {
  if (r.learned.ip.length === 0)
    return 'Contacted over WebSocket only (no HTTP request); the connection still revealed the visitor’s IP';
  return `Learned the visitor’s IP ${phases(r.learned.ip)}`;
}
