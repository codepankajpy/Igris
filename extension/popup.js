/**
 * Igris extension stub. Privacy rule it exists to demonstrate: NEVER query a
 * registry per visited site (that ships your browsing history to an RPC).
 * Instead, a registry snapshot (produced by `igris snapshot`) is bundled with
 * the extension and matched locally.
 */
/** Snapshot data is untrusted (anyone can publish entities): escape everything. */
function esc(v) {
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Integer in [min, max], else null. */
function int(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max ? v : null;
}

async function main() {
  const out = document.getElementById('out');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const hostname = tab?.url ? new URL(tab.url).hostname : null;
    if (!hostname) {
      out.textContent = 'no active site';
      return;
    }
    const res = await fetch(chrome.runtime.getURL('snapshot.json'));
    const { records } = await res.json();
    // Latest record per scanner for this hostname.
    const matches = (Array.isArray(records) ? records : [])
      .filter(
        (r) =>
          r &&
          r.hostname === hostname &&
          int(r.score, 0, 100) !== null &&
          int(r.scannedAt, 0, Number.MAX_SAFE_INTEGER) !== null,
      )
      .sort((a, b) => b.scannedAt - a.scannedAt);
    if (matches.length === 0) {
      out.innerHTML = `<strong>${esc(hostname)}</strong><br>not in the local snapshot.`;
      return;
    }
    const best = matches[0];
    const cls = best.score >= 90 ? 'good' : best.score >= 60 ? 'warn' : 'bad';
    const leaks = int(best.leakCount, 0, 1e6) ?? '?';
    const tps = int(best.thirdPartyCount, 0, 1e6) ?? '?';
    const scanner = typeof best.scanner === 'string' ? best.scanner.slice(0, 10) : '?';
    out.innerHTML = `
      <strong>${esc(hostname)}</strong>
      <div class="score ${cls}">${esc(best.score)}<span style="font-size:0.9rem">/100</span></div>
      <ul>
        <li>${esc(leaks)} address leak(s)${best.leakClasses ? ` (${esc(best.leakClasses)})` : ''}</li>
        <li>${esc(tps)} third parties contacted</li>
        <li>${best.usesAnonRpc === true ? 'uses Anon-RPC' : 'Anon-RPC not detected'}</li>
      </ul>
      <span class="muted">from the bundled snapshot (not checked against Arkiv) ·
      scanned ${esc(new Date(best.scannedAt * 1000).toISOString().slice(0, 10))}
      by ${esc(scanner)}…</span>`;
  } catch (err) {
    out.textContent = 'error: ' + String(err);
  }
}
main();
