/**
 * Render a discovery JSON (scripts/corpus-discover.ts) into the discovery
 * report: one primary classification per candidate, per-kit detail for
 * confirmed kits, and unconfirmed SDK-presence signals kept separate.
 *
 * A kit is CONFIRMED only if its own connect modal was observed live
 * (fingerprint confidence "high"). Static or network signals alone are
 * reported as "SDK present (unconfirmed)", never as confirmed.
 *
 * Usage: pnpm exec tsx scripts/corpus-report.ts <discovery.json> <out.md>
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface Fp {
  id: string;
  confidence: string;
  signals: string[];
}
interface Rec {
  url: string;
  observedAt: string;
  load: { ok: boolean; category?: string; detail?: string; finalUrl?: string; title?: string };
  staticFingerprint?: Fp;
  open?: {
    outcome: string;
    clicked: string | null;
    topCandidates: string[];
    fingerprint: Fp;
    urlChanges: string[];
    detail: string;
  };
  error?: string;
  inventory?: { beforeClick?: Inventory; afterClick?: Inventory };
  walletOptionAncestry?:
    | Array<{ tag: string; id?: string; attrs: string[]; classes: string[]; shadowHost: boolean }>
    | null
    | { error: string };
}

/**
 * Attribute an observed connect modal to a UI library from its recorded
 * ancestry signature. Explicit token → library map; anything unmatched is
 * "unattributed". Attribution, not identification of one of the five kits.
 */
const LIBRARY_TOKENS: Array<[RegExp, string]> = [
  [/rabby-kit|data-rabbykit/, 'RabbyKit (a different wallet kit, out of P1 scope)'],
  [/radix-|data-radix/, 'app modal built on Radix UI'],
  [/MuiDialog|MuiModal/, 'app modal built on MUI'],
  [/headlessui-/, 'app modal built on Headless UI'],
  [/cdk-overlay/, 'app modal built on Angular CDK'],
  [/data-v-app|data-v-[0-9a-f]{8}/, 'app modal built with Vue'],
  [/data-testid=wallet-modal|account-drawer/, 'app-specific modal (Uniswap)'],
  [/sb-widget/, 'app-specific modal (Superbridge widget)'],
  [/nav-dropdown/, 'app-specific dropdown (Across)'],
  [/\bsc-[A-Za-z]/, 'app modal built with styled-components'],
];
export function attributeModal(r: Rec): string {
  const a = r.walletOptionAncestry;
  if (!a || !Array.isArray(a)) return '—';
  const sig = a.map((n) => [n.tag, n.id ?? '', ...n.attrs, ...n.classes].join(' ')).join(' > ');
  const hit = LIBRARY_TOKENS.find(([re]) => re.test(sig));
  return hit ? hit[1] : 'unattributed (signature recorded)';
}
interface Inventory {
  controls?: string[];
  dialogs?: string[];
  walletLabels?: string[];
  customTags?: string[];
  iframes?: string[];
}

/** Reason derived mechanically from the recorded inventory (never asserted beyond it). */
export function explain(r: Rec): string {
  const b = r.inventory?.beforeClick ?? {};
  const a = r.inventory?.afterClick ?? {};
  const plausible = (b.controls ?? []).filter(
    (c) => /\b(connect|log ?in|sign ?in)\b/i.test(c) && c.length <= 40,
  );
  const reasons: string[] = [];
  if (r.open?.outcome === 'no-connect-control' && plausible.length)
    reasons.push(
      `scorer rejected plausible control(s): ${plausible.map((c) => `"${c}"`).join(', ')}`,
    );
  if (r.open?.outcome === 'no-connect-control' && !plausible.length)
    reasons.push('no visible control named connect / log in / sign in');
  if ((a.dialogs ?? []).length && !(a.walletLabels ?? []).length)
    reasons.push(
      `a dialog without a wallet list is open: ${(a.dialogs ?? []).map((d) => `"${d}"`).join(', ')}`,
    );
  if ((a.walletLabels ?? []).length && r.open?.outcome === 'modal-not-opened')
    reasons.push(
      `wallet list visible but no known-kit marker (custom or unrecognised modal): ${(a.walletLabels ?? []).join(', ')}`,
    );
  if (r.open?.outcome === 'click-failed')
    reasons.push(`click not actionable: ${(r.open.detail ?? '').split('\n')[0]}`);
  if (
    r.open?.outcome === 'modal-not-opened' &&
    !(a.dialogs ?? []).length &&
    !(a.walletLabels ?? []).length
  )
    reasons.push('no dialog or wallet list appeared within the bound after the click');
  return reasons.join('; ') || '—';
}

export type PrimaryClass =
  | 'unavailable (DNS/network)'
  | 'unavailable (HTTP error)'
  | 'bot-blocked'
  | 'browser-incompatible'
  | 'connect UI unavailable'
  | 'navigation away on connect'
  | 'kit identified (confirmed live)'
  | 'kit unidentified'
  | 'tool error';

export function classify(r: Rec): PrimaryClass {
  if (r.error) return 'tool error';
  if (!r.load.ok) {
    if (r.load.category === 'bot-blocked') return 'bot-blocked';
    if (r.load.category === 'browser-incompatible') return 'browser-incompatible';
    return /HTTP \d{3}/.test(r.load.detail ?? '')
      ? 'unavailable (HTTP error)'
      : 'unavailable (DNS/network)';
  }
  const o = r.open;
  if (o?.outcome === 'unexpected-navigation') return 'navigation away on connect';
  // A kit modal observed live confirms the kit, whether it opened on click or
  // was already rendered inline at load (demo.privy.io).
  if (o?.fingerprint.confidence === 'high' || r.staticFingerprint?.confidence === 'high')
    return 'kit identified (confirmed live)';
  if (!o || o.outcome === 'no-connect-control' || o.outcome === 'click-failed')
    return 'connect UI unavailable';
  return 'kit unidentified';
}

function main(): void {
  const [outFile, ...inFiles] = process.argv.slice(2);
  if (!outFile || inFiles.length === 0) {
    console.error('usage: corpus-report.ts <out.md> <discovery.json>... (later files win per URL)');
    process.exit(3);
  }
  if (outFile.endsWith('.json')) throw new Error('first argument is the OUTPUT .md file');
  const merged = new Map<string, Rec>();
  for (const f of inFiles)
    for (const r of (JSON.parse(readFileSync(f, 'utf8')) as { results: Rec[] }).results)
      merged.set(r.url, r);
  const results = [...merged.values()];
  const inFile = inFiles.join(', ');
  const rows = results.map((r) => ({ r, cls: classify(r) }));
  const counts = new Map<string, number>();
  for (const { cls } of rows) counts.set(cls, (counts.get(cls) ?? 0) + 1);

  const L: string[] = [
    `# Discovery report`,
    '',
    `Source: \`${inFile}\` (scripts/corpus-discover.ts). ${results.length} candidates, one page load and one strictly-scored click each, canary wallet injected, nothing signed. Observed ${results[0]?.observedAt ?? '?'} – ${results.at(-1)?.observedAt ?? '?'}.`,
    '',
    'A kit is **confirmed** only when its own connect modal was observed live (fingerprint confidence `high`). SDK presence without an observed modal is listed separately as **unconfirmed** and is never counted as identification.',
    '',
    '## Primary classification',
    '',
    '| class | count |',
    '| --- | --- |',
    ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '| candidate | class | detail |',
    '| --- | --- | --- |',
  ];
  for (const { r, cls } of rows) {
    const d = !r.load.ok
      ? (r.load.detail ?? '')
      : r.open
        ? `${r.open.outcome}${r.open.clicked ? `; clicked "${r.open.clicked}"` : ''}${r.open.fingerprint.id !== 'none' ? `; ${r.open.fingerprint.id}/${r.open.fingerprint.confidence}` : ''}`
        : (r.error ?? '');
    L.push(`| ${r.url} | ${cls} | ${d.replaceAll('|', '\\|').slice(0, 160)} |`);
  }

  L.push('', '## Confirmed kits (verified live)', '');
  L.push(
    '| kit | URL | connect control (strategy) | static signals | modal signals | confidence | observed |',
  );
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const { r } of rows.filter((x) => x.cls === 'kit identified (confirmed live)')) {
    const o =
      r.open && r.open.fingerprint.confidence === 'high'
        ? r.open
        : {
            ...r.open!,
            fingerprint: r.staticFingerprint!,
            clicked: `(none: kit modal already rendered at load; open step ${r.open?.outcome ?? 'n/a'})`,
          };
    const stat = (r.staticFingerprint?.signals ?? []).join('<br>') || '—';
    const modal = o.fingerprint.signals.filter((s) => s.includes(':modal:')).join('<br>');
    L.push(
      `| ${o.fingerprint.id} | ${r.url} | "${o.clicked}" (strict scoring: ${o.topCandidates[0] ?? ''}) | ${stat} | ${modal} | high | ${r.observedAt} |`,
    );
  }

  L.push('', '## Unconfirmed: kit SDK signals without an observed kit modal', '');
  L.push(
    'These are assumptions, not identifications. Typical causes: the connect control is not a strict-scoring match, the site uses its own modal on top of an SDK, or a multi-step flow.',
    '',
  );
  L.push('| URL | static fingerprint | after click | why unconfirmed |');
  L.push('| --- | --- | --- | --- |');
  for (const { r, cls } of rows) {
    if (cls === 'kit identified (confirmed live)' || !r.load.ok) continue;
    const s = r.staticFingerprint;
    const after = r.open?.fingerprint;
    if ((s && s.id !== 'none') || (after && after.id !== 'none')) {
      L.push(
        `| ${r.url} | ${s ? `${s.id}/${s.confidence}` : '—'} | ${r.open?.outcome ?? '—'}${after ? ` → ${after.id}/${after.confidence}` : ''} | ${(r.open?.detail ?? '').replaceAll('|', '\\|').slice(0, 120)} |`,
      );
    }
  }
  L.push('', '## Why not identified (from the recorded inventory)', '');
  L.push(
    'Reasons are derived mechanically from what discovery recorded before and after its single click; they are diagnoses to verify, not conclusions.',
    '',
  );
  L.push(
    '| URL | class | derived reason | modal attribution (ancestry signature) | visible after click (dialogs / wallet labels / custom tags / iframes) |',
  );
  L.push('| --- | --- | --- | --- | --- |');
  for (const { r, cls } of rows) {
    if (
      cls !== 'kit unidentified' &&
      cls !== 'connect UI unavailable' &&
      cls !== 'navigation away on connect'
    )
      continue;
    const a = r.inventory?.afterClick ?? {};
    const vis = [a.dialogs, a.walletLabels, a.customTags, a.iframes]
      .map((x) => (x ?? []).join(', ') || '—')
      .join(' / ');
    L.push(
      `| ${r.url} | ${cls} | ${explain(r).replaceAll('|', '\\|')} | ${attributeModal(r)} | ${vis.replaceAll('|', '\\|').slice(0, 200)} |`,
    );
  }
  writeFileSync(outFile, L.join('\n') + '\n');
  console.log(`wrote ${outFile}: ${[...counts.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

if (process.argv[1]?.endsWith('corpus-report.ts')) main();
