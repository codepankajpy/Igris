/**
 * Igris extension stub. Privacy rule it exists to demonstrate: NEVER query a
 * registry per visited site (that ships your browsing history to an RPC).
 * Instead, a registry snapshot (produced by `igris snapshot`) is bundled with
 * the extension and matched locally.
 */
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
    const matches = records
      .filter((r) => r.hostname === hostname)
      .sort((a, b) => b.scannedAt - a.scannedAt);
    if (matches.length === 0) {
      out.innerHTML = `<strong>${hostname}</strong><br>not in the local snapshot.`;
      return;
    }
    const best = matches[0];
    const cls = best.score >= 90 ? 'good' : best.score >= 60 ? 'warn' : 'bad';
    out.innerHTML = `
      <strong>${hostname}</strong>
      <div class="score ${cls}">${best.score}<span style="font-size:0.9rem">/100</span></div>
      <ul>
        <li>${best.leakCount} address leak(s)${best.leakClasses ? ` (${best.leakClasses})` : ''}</li>
        <li>${best.thirdPartyCount} third parties contacted</li>
        <li>${best.usesAnonRpc ? 'uses Anon-RPC ✓' : 'does not use Anon-RPC'}</li>
      </ul>
      <span class="muted">scanned ${new Date(best.scannedAt * 1000).toISOString().slice(0, 10)}
      by ${best.scanner.slice(0, 10)}…</span>`;
  } catch (err) {
    out.textContent = 'error: ' + err;
  }
}
main();
