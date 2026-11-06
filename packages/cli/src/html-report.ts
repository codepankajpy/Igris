/**
 * Self-contained single-file HTML report for Report v2: inline CSS, system
 * fonts, ZERO external requests. Privacy findings and security observations
 * are separate sections; only the former feed the score.
 */
import type {
  CanaryMatchEvidence,
  EvidenceBundleV1,
  EvidenceItem,
  FindingV2,
  ReportV2,
} from '@igris/core';

function esc(s: unknown): string {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** "82/100", "82/100 (pre-connect only)" or "not scored". */
export function scoreLabel(report: ReportV2): string {
  const { score, coverage } = report.privacy;
  if (score === null || coverage === 'none') return 'not scored';
  return coverage === 'pre-connect-only' ? `${score}/100 (pre-connect only)` : `${score}/100`;
}

/** Plain-language statement of what the score does NOT cover, or null. */
export function coverageNote(report: ReportV2): string | null {
  const c = report.privacy.coverage;
  if (c === 'none')
    return 'NOT SCORED: the page never loaded, so nothing was measured. This is not a privacy result.';
  if (c === 'pre-connect-only')
    return 'PARTIAL: the wallet never connected, so post-connect address leaks were NOT tested. The score covers only what happens before connect.';
  return null;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#82071e',
  high: '#cf222e',
  medium: '#9a6700',
  low: '#57606a',
  info: '#8c959f',
};

function scoreColor(score: number | null): string {
  if (score === null) return '#57606a';
  return score >= 90 ? '#1a7f37' : score >= 60 ? '#9a6700' : '#cf222e';
}

function evidenceSummary(item: EvidenceItem | undefined): string {
  if (!item) return '<em>missing evidence</em>';
  switch (item.type) {
    case 'canary-match': {
      const e = item as CanaryMatchEvidence;
      return `<div><code>${esc(e.method)} ${esc(e.host)}</code> · ${esc(e.location)} · <code>${esc(e.encoding)}</code> · ${esc(e.phase)}</div><code class="snippet">${esc(e.snippet)}</code>`;
    }
    case 'third-party-contact':
      return `<div><code>${esc(item.host)}</code> (${esc(item.recipientClass)}) · ${item.phases.map(esc).join(', ')}</div>`;
    case 'document-headers':
      return `<div><code>${esc(item.documentUrl)}</code> → HTTP ${item.status}</div><ul class="hdrs">${Object.entries(
        item.headers,
      )
        .map(
          ([k, v]) =>
            `<li><code>${esc(k)}</code>: ${v === null ? '<em>absent</em>' : `<code>${esc(v)}</code>`}</li>`,
        )
        .join('')}</ul>`;
  }
}

function findingRows(findings: FindingV2[], bundle: EvidenceBundleV1): string {
  return findings
    .map(
      (f) => `<tr>
    <td><span class="sev" style="background:${SEVERITY_COLOR[f.severity]}">${esc(f.severity)}</span></td>
    <td>${esc(f.kind)}<br><span class="muted">${esc(f.confidence)}</span></td>
    <td><strong>${esc(f.title)}</strong>
      <details><summary>impact &amp; remediation</summary><p>${esc(f.impact)}</p><p><strong>Fix:</strong> ${esc(f.remediation)}</p></details>
      <span class="muted"><code>${esc(f.id)}</code> · ${esc(f.detector)}@${esc(f.detectorVersion)}${f.countsTowardPrivacyScore ? ' · scored' : ''}</span></td>
    <td>${f.evidence.map((r) => evidenceSummary(bundle.items[r.id])).join('<hr>')}</td>
  </tr>`,
    )
    .join('\n');
}

export function renderHtmlReport(report: ReportV2, bundle: EvidenceBundleV1): string {
  const p = report.privacy;
  const issues = p.findings.filter((f) => f.kind === 'issue').length;
  const risks = p.findings.filter((f) => f.kind === 'risk').length;
  const note = coverageNote(report);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IGRIS scan — ${esc(report.scan.hostname)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 76rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  .meta, .muted { color: #6e7781; font-size: 0.85rem; }
  .cards { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1.5rem 0; }
  .card { border: 1px solid #8884; border-radius: 8px; padding: 0.8rem 1.2rem; min-width: 9rem; }
  .card .n { font-size: 1.8rem; font-weight: 650; font-variant-numeric: tabular-nums; }
  .score { font-size: 3rem !important; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.88rem; }
  th, td { border-bottom: 1px solid #8884; padding: 0.45rem 0.6rem; text-align: left; vertical-align: top; }
  th { font-weight: 600; }
  .sev { color: #fff; border-radius: 4px; padding: 0.05rem 0.45rem; font-size: 0.75rem; text-transform: uppercase; }
  code.snippet { display: block; font-size: 0.78rem; word-break: break-all; opacity: 0.85; }
  .pts { text-align: right; font-variant-numeric: tabular-nums; }
  .coverage { border-left: 4px solid #9a6700; padding: 0.5rem 1rem; background: #9a670014; }
  ul.hdrs { margin: 0.2rem 0; padding-left: 1rem; }
  hr { border: 0; border-top: 1px dashed #8884; }
  footer { margin: 3rem 0 1rem; border-top: 1px solid #8884; padding-top: 1rem; }
</style>
</head>
<body>
<h1>IGRIS scan: <code>${esc(report.scan.hostname)}</code></h1>
<p class="meta">${esc(report.scan.target)} · scanned ${esc(report.scan.scannedAt)} · scanner v${esc(report.scan.scannerVersion)} · report v${esc(report.reportVersion)}${report.migratedFrom ? ` (migrated from ${esc(report.migratedFrom)})` : ''} · status <strong>${esc(report.scan.status)}</strong> · egress ${esc(report.scan.egress)}</p>
${note ? `<p class="coverage"><strong>${esc(note)}</strong></p>` : ''}
<div class="cards">
  <div class="card"><div class="n score" style="color:${scoreColor(p.score)}">${p.score === null ? '—' : p.score}</div>privacy score / 100${p.coverage === 'pre-connect-only' ? ' (pre-connect only)' : ''}</div>
  <div class="card"><div class="n">${issues}</div>confirmed privacy issues</div>
  <div class="card"><div class="n">${risks}</div>privacy risks</div>
  <div class="card"><div class="n">${report.security.observations.filter((o) => o.kind !== 'observation').length}</div>security observations</div>
  <div class="card"><div class="n">${report.contacts.length}</div>third parties contacted</div>
  <div class="card"><div class="n">${report.wallet.usesAnonRpc ? 'yes' : 'no'}</div>uses Anon-RPC</div>
</div>

<h2>Privacy findings (${p.findings.length})</h2>
<p class="muted">The canary address is always shown as <code>&lt;CANARY&gt;</code>. Only privacy findings marked “scored” affect the score.</p>
<table><tr><th>severity</th><th>kind</th><th>finding</th><th>evidence</th></tr>
${findingRows(p.findings, bundle)}
</table>

<h2>Score ledger</h2>
<p class="muted">Start at 100; each deduction names its rule and the findings behind it. A heuristic, not an audit (docs/SCORING.md).</p>
<table><tr><th>#</th><th>penalty</th><th>rule</th><th>findings</th><th class="pts">points</th></tr>
${p.ledger
  .map(
    (l) =>
      `<tr><td>${esc(l.id)}</td><td>${esc(l.label)}</td><td><code>${esc(l.rule)}</code></td><td>${l.findingIds.map((i) => `<code>${esc(i)}</code>`).join(' ') || '—'}</td><td class="pts">−${l.points}</td></tr>`,
  )
  .join('\n')}
<tr><th colspan="4">score</th><th class="pts">${p.score === null ? 'not scored' : p.score}</th></tr>
</table>

<h2>Security observations (${report.security.observations.length})</h2>
<p class="muted">Reported separately. They never affect the privacy score.</p>
<table><tr><th>severity</th><th>kind</th><th>observation</th><th>evidence</th></tr>
${findingRows(report.security.observations, bundle)}
</table>

<h2>Third parties contacted</h2>
<table><tr><th>host</th><th>class</th><th>phases</th><th class="pts">requests</th></tr>
${report.contacts
  .map(
    (t) =>
      `<tr><td>${esc(t.host)}</td><td>${esc(t.class)}</td><td>${t.phases.map(esc).join(', ')}</td><td class="pts">${t.requestCount}</td></tr>`,
  )
  .join('\n')}
</table>

<h2>Reads routed through the wallet (no penalty)</h2>
${
  report.wallet.readsViaWallet.length
    ? `<table><tr><th>method</th><th class="pts">count</th></tr>${report.wallet.readsViaWallet
        .map(
          (r) => `<tr><td><code>${esc(r.method)}</code></td><td class="pts">${r.count}</td></tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">none seen</p>'
}

<details><summary>Scan notes (${report.scan.notes.length + report.scan.connectionLog.length})</summary>
<ul>${[...report.scan.connectionLog, ...report.scan.notes].map((e) => `<li><code>${esc(e)}</code></li>`).join('')}</ul>
</details>

<footer class="muted">
  Evidence bundle <code>${esc(report.evidence.bundleVersion)}</code>, ${report.evidence.itemCount} items,
  sha256 <code>${esc(report.evidence.sha256)}</code> (RFC 8785 canonical JSON; verify with <code>igris verify report.json</code>).
  Canary of this scan: <code>${esc(report.scan.canaryAddress)}</code> (throwaway). This file makes no network requests.
</footer>
</body>
</html>`;
}
