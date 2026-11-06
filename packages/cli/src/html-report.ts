/**
 * Self-contained single-file HTML report: inline CSS, system font stack,
 * ZERO external requests (we eat our own cooking — a report about privacy
 * must not phone home).
 */
import { coverageForStatus, type Finding, type Report, type ScanCoverage } from '@igris/core';

/** Coverage of a report; 1.0.0 reports predate the field, derive it. */
export function reportCoverage(report: Report): ScanCoverage {
  return report.coverage ?? coverageForStatus(report.status);
}

/** "82/100", "82/100 (pre-connect only)" or "not scored". */
export function scoreLabel(report: Report): string {
  if (report.score === null || reportCoverage(report) === 'none') return 'not scored';
  return reportCoverage(report) === 'pre-connect-only'
    ? `${report.score}/100 (pre-connect only)`
    : `${report.score}/100`;
}

/** Plain-language statement of what the score does NOT cover, or null. */
export function coverageNote(report: Report): string | null {
  const c = reportCoverage(report);
  if (c === 'none')
    return 'NOT SCORED: the page never loaded, so nothing was measured. This is not a privacy result.';
  if (c === 'pre-connect-only')
    return 'PARTIAL: the wallet never connected, so post-connect address leaks were NOT tested. The score covers only what happens before connect.';
  return null;
}

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function scoreColor(score: number | null): string {
  if (score === null) return '#57606a';
  if (score >= 90) return '#1a7f37';
  if (score >= 60) return '#9a6700';
  return '#cf222e';
}

function badge(cls: string): string {
  const colors: Record<string, string> = {
    'rpc-provider': '#0969da',
    analytics: '#cf222e',
    'error-monitoring': '#bc4c00',
    'support-chat': '#8250df',
    'walletconnect-relay': '#1f6feb',
    'ipfs-gateway': '#1a7f37',
    cdn: '#57606a',
    'unknown-third-party': '#a40e26',
    'first-party': '#1a7f37',
    'anon-rpc': '#1a7f37',
  };
  return `<span class="badge" style="background:${colors[cls] ?? '#57606a'}">${esc(cls)}</span>`;
}

function findingRow(f: Finding): string {
  return `<tr>
    <td><code>${esc(f.id)}</code></td>
    <td>${badge(f.class)}</td>
    <td>${esc(f.host)}</td>
    <td>${esc(f.location)}</td>
    <td><code>${esc(f.encoding)}</code>${f.category === 'hashed' ? ' <em>(hashed, still linkable)</em>' : ''}${f.category === 'partial' ? ' <em>(partial, low confidence)</em>' : ''}</td>
    <td>${esc(f.phase)}</td>
    <td>${f.countsTowardScore ? 'yes' : 'no'}</td>
    <td><code class="snippet">${esc(f.snippet)}</code></td>
  </tr>`;
}

export function renderHtmlReport(report: Report): string {
  const exact = report.findings.filter((f) => f.category === 'exact');
  const hashed = report.findings.filter((f) => f.category === 'hashed');
  const partial = report.findings.filter((f) => f.category === 'partial');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Igris scan — ${esc(report.hostname)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 72rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { margin-bottom: 0; } h1 code { font-size: 0.8em; }
  .meta { color: #666; margin-top: 0.25rem; }
  .score { font-size: 3.5rem; font-weight: 700; }
  .cards { display: flex; gap: 1.5rem; flex-wrap: wrap; margin: 1.5rem 0; }
  .card { border: 1px solid #8884; border-radius: 8px; padding: 1rem 1.5rem; min-width: 10rem; }
  .card .n { font-size: 2rem; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.9rem; }
  th, td { border: 1px solid #8884; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  th { background: #8881; }
  .badge { color: #fff; border-radius: 999px; padding: 0.1rem 0.6rem; font-size: 0.78rem; white-space: nowrap; }
  code.snippet { font-size: 0.78rem; word-break: break-all; }
  .ledger td.pts { text-align: right; font-variant-numeric: tabular-nums; }
  details { margin: 0.5rem 0; }
  .coverage { border-left: 4px solid #9a6700; padding: 0.5rem 1rem; background: #9a670014; }
  footer { margin: 3rem 0 1rem; color: #666; font-size: 0.85rem; border-top: 1px solid #8884; padding-top: 1rem; }
</style>
</head>
<body>
<h1>Igris scan: <code>${esc(report.hostname)}</code></h1>
<p class="meta">${esc(report.target)} · scanned ${esc(report.scannedAt)} · scanner v${esc(report.scannerVersion)} · report v${esc(report.reportVersion)} · chain ${report.chainId} · status: <strong>${esc(report.status)}</strong></p>

${coverageNote(report) ? `<p class="coverage"><strong>${esc(coverageNote(report) ?? '')}</strong></p>` : ''}
<div class="cards">
  <div class="card"><div class="n score" style="color:${scoreColor(report.score)}">${report.score === null ? '—' : report.score}</div>privacy score / 100${reportCoverage(report) === 'pre-connect-only' ? ' (pre-connect only)' : ''}</div>
  <div class="card"><div class="n">${exact.length}</div>exact address leaks</div>
  <div class="card"><div class="n">${hashed.length}</div>hashed (still linkable)</div>
  <div class="card"><div class="n">${partial.length}</div>partial (unscored)</div>
  <div class="card"><div class="n">${report.thirdParties.length}</div>third parties contacted</div>
  <div class="card"><div class="n">${report.usesAnonRpc ? 'yes' : 'no'}</div>uses Anon-RPC</div>
</div>

<h2>Score ledger</h2>
<p>Start at 100; every deduction below is traceable to finding IDs. This is a <em>heuristic</em>, not an audit — see docs/SCORING.md.</p>
<table class="ledger">
<tr><th>#</th><th>penalty</th><th>rule</th><th>findings</th><th>points</th></tr>
${report.ledger
  .map(
    (l) =>
      `<tr><td>${esc(l.id)}</td><td>${esc(l.label)}</td><td><code>${esc(l.rule)}</code></td><td>${l.findingIds.map(esc).join(', ') || '—'}</td><td class="pts">−${l.points}</td></tr>`,
  )
  .join('\n')}
<tr><th colspan="4">score</th><th class="pts">${report.score === null ? 'not scored' : report.score}</th></tr>
</table>

<h2>Findings (${report.findings.length})</h2>
<p>The canary address is always shown as <code>&lt;CANARY&gt;</code>. “counted” = participates in the score.</p>
<table>
<tr><th>id</th><th>class</th><th>destination</th><th>where</th><th>encoding</th><th>phase</th><th>counted</th><th>snippet</th></tr>
${report.findings.map(findingRow).join('\n')}
</table>

<h2>Third parties contacted (IP exposure)</h2>
<p>Every one of these learns the visitor's IP address — before any wallet interaction when the phase includes <em>pre-connect</em>.</p>
<table>
<tr><th>host</th><th>class</th><th>phases</th><th>requests</th></tr>
${report.thirdParties
  .map(
    (t) =>
      `<tr><td>${esc(t.host)}</td><td>${badge(t.class)}</td><td>${t.phases.map(esc).join(', ')}</td><td>${t.requestCount}</td></tr>`,
  )
  .join('\n')}
</table>

<h2>Reads routed through the wallet (no penalty)</h2>
<p>The best case: the dapp let the wallet choose the RPC endpoint. The scan answered these from a local stub${report.readsViaWallet.length === 0 ? ' (none seen)' : ''}.</p>
${
  report.readsViaWallet.length
    ? `<table><tr><th>method</th><th>count</th></tr>${report.readsViaWallet
        .map((r) => `<tr><td><code>${esc(r.method)}</code></td><td>${r.count}</td></tr>`)
        .join('')}</table>`
    : ''
}

<details>
<summary>Scan notes (${report.errors.length})</summary>
<ul>${report.errors.map((e) => `<li><code>${esc(e)}</code></li>`).join('')}</ul>
</details>

<footer>
  Generated by <strong>Igris</strong> — Lighthouse for dapp privacy. Canary address of this scan:
  <code>${esc(report.canaryAddress)}</code> (throwaway, generated for this scan only).
  This file is self-contained and makes no network requests.
</footer>
</body>
</html>`;
}
