/**
 * Igris Registry Viewer & Dapp Privacy Oracle
 * A modern, static client that queries Arkiv on-chain entities or local snapshots,
 * and allows triggering live dapp scans and repository patches via the Igris API.
 */
import './style.css';
import {
  ArkivRegistry,
  RABDI_RPC_URL,
  RABDI_EXPLORER_URL,
  matchesQuery,
  type RegistryQuery,
  type RegistryRecord,
} from '@igris/registry/browser';

/**
 * Scanner addresses pinned by default — "ours". Pre-populated with the generated
 * Igris scanner key address. Fresh visitors see our attestations as pinned.
 */
const DEFAULT_PINNED: string[] = ['0xDbd0309b80f71E12d45Ac8321DBA637156a4198B'];

const LS = {
  endpoint: 'igris:endpoint',
  pinned: 'igris:pinnedScanners',
  mode: 'igris:mode',
  apiUrl: 'igris:apiUrl',
};

type Mode = 'arkiv' | 'snapshot';

interface State {
  mode: Mode;
  endpoint: string;
  apiUrl: string;
  pinned: string[];
  records: RegistryRecord[];
  loaded: boolean;
  error: string | null;
  detailId: string | null;
  activeHeroTab: 'dapp' | 'repo';
  isScanning: boolean;
  scanProgress: string | null;
  repoPatchResult: {
    repoUrl: string;
    changedFiles: string[];
    diff: string;
    recommendations: string[];
  } | null;
  filters: {
    hostname: string;
    minScore: string;
    maxScore: string;
    leakClass: string;
    usesAnonRpc: string;
    scanner: string;
    pinnedOnly: boolean;
  };
}

const state: State = {
  mode: (localStorage.getItem(LS.mode) as Mode) || 'arkiv',
  endpoint: localStorage.getItem(LS.endpoint) || RABDI_RPC_URL,
  apiUrl:
    localStorage.getItem(LS.apiUrl) ||
    (typeof window !== 'undefined' &&
      (window as unknown as { ENV_API_URL?: string }).ENV_API_URL) ||
    'http://localhost:3001',
  pinned: JSON.parse(localStorage.getItem(LS.pinned) || 'null') ?? DEFAULT_PINNED,
  records: [],
  loaded: false,
  error: null,
  detailId: null,
  activeHeroTab: 'dapp',
  isScanning: false,
  scanProgress: null,
  repoPatchResult: null,
  filters: {
    hostname: '',
    minScore: '',
    maxScore: '',
    leakClass: '',
    usesAnonRpc: '',
    scanner: '',
    pinnedOnly: false,
  },
};

const app = document.querySelector<HTMLDivElement>('#app')!;

function esc(s: unknown): string {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function scoreClass(score: number): string {
  return score >= 90 ? 'good' : score >= 60 ? 'warn' : 'bad';
}

function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a;
}

function isPinned(scanner: string): boolean {
  return state.pinned.some((p) => p.toLowerCase() === scanner.toLowerCase());
}

/** Build the server-side query from the filter inputs. */
function currentQuery(): RegistryQuery {
  const f = state.filters;
  return {
    ...(f.hostname ? { hostname: f.hostname.trim() } : {}),
    ...(f.minScore ? { minScore: Number(f.minScore) } : {}),
    ...(f.maxScore ? { maxScore: Number(f.maxScore) } : {}),
    ...(f.leakClass ? { leakClass: f.leakClass } : {}),
    ...(f.usesAnonRpc ? { usesAnonRpc: f.usesAnonRpc === 'true' } : {}),
    ...(f.scanner ? { scanner: f.scanner.trim() } : {}),
  };
}

async function load(): Promise<void> {
  state.error = null;
  state.loaded = false;
  render();
  try {
    if (state.mode === 'arkiv') {
      const registry = new ArkivRegistry({ rpcUrl: state.endpoint });
      state.records = await registry.query(currentQuery());
    } else {
      const res = await fetch('./snapshot.json');
      if (!res.ok) throw new Error(`snapshot.json not found next to the page (${res.status})`);
      const file = (await res.json()) as { records: RegistryRecord[] };
      state.records = file.records.filter((r) => matchesQuery(r, currentQuery()));
    }
    state.loaded = true;
  } catch (err) {
    state.error = String(err);
  }
  render();
}

/** Latest record per (hostname, scanner); also counts agreeing scanners. */
function latestPerScanner(records: RegistryRecord[]): Array<RegistryRecord & { agree: number }> {
  const latest = new Map<string, RegistryRecord>();
  for (const r of records) {
    const k = `${r.hostname}|${r.scanner.toLowerCase()}`;
    const prev = latest.get(k);
    if (!prev || r.scannedAt > prev.scannedAt) latest.set(k, r);
  }
  const byHost = new Map<string, number>();
  for (const r of latest.values()) {
    byHost.set(r.hostname, (byHost.get(r.hostname) ?? 0) + 1);
  }
  return [...latest.values()]
    .sort((a, b) => b.scannedAt - a.scannedAt)
    .map((r) => ({ ...r, agree: byHost.get(r.hostname) ?? 1 }));
}

function render(): void {
  const detail = state.detailId ? state.records.find((r) => r.id === state.detailId) : null;
  app.innerHTML = `
  <div class="wrap">
    <header>
      <div class="tagline-badge">🛡️ Web3 Privacy & Security Oracle</div>
      <div class="header-brand">
        <div class="logo-icon">I</div>
        <h1>Igris Registry</h1>
      </div>
      <p>Empirical privacy audits for Ethereum dapps. Detect RPC IP surveillance, third-party trackers, and Anon-RPC readiness.</p>
    </header>

    ${renderHeroAuditor()}
    ${renderSource()}
    ${detail ? renderDetail(detail) : renderList()}
    ${renderEducationalCards()}
  </div>`;
  wire();
}

function renderHeroAuditor(): string {
  const isDappTab = state.activeHeroTab === 'dapp';
  return `
  <div class="audit-hero">
    <div class="audit-tabs">
      <button class="tab-btn ${isDappTab ? 'active' : ''}" id="tab-dapp">🌐 Audit Live Dapp URL</button>
      <button class="tab-btn ${!isDappTab ? 'active' : ''}" id="tab-repo">📦 Inspect & Patch Dapp Repo</button>
    </div>

    ${
      isDappTab
        ? `
      <form id="form-scan" class="audit-form" onsubmit="return false;">
        <input 
          id="scan-url-input" 
          class="audit-input" 
          type="url" 
          placeholder="Enter live dapp URL (e.g. https://app.uniswap.org or http://localhost:3000)" 
          required 
          ${state.isScanning ? 'disabled' : ''}
        />
        <button id="btn-start-scan" class="btn-action" type="submit" ${state.isScanning ? 'disabled' : ''}>
          ${state.isScanning ? '<span class="pulse-dot"></span> Auditing...' : '🔍 Run Privacy Audit'}
        </button>
      </form>`
        : `
      <form id="form-patch" class="audit-form" onsubmit="return false;">
        <input 
          id="patch-repo-input" 
          class="audit-input" 
          type="url" 
          placeholder="Enter GitHub repository URL (e.g. https://github.com/org/dapp)" 
          required 
          ${state.isScanning ? 'disabled' : ''}
        />
        <button id="btn-start-patch" class="btn-action" type="submit" ${state.isScanning ? 'disabled' : ''}>
          ${state.isScanning ? '<span class="pulse-dot"></span> Analyzing...' : '⚡ Generate Anon-RPC Patch'}
        </button>
      </form>`
    }

    ${
      state.scanProgress
        ? `<div class="audit-result-banner"><span class="pulse-dot"></span> ${esc(state.scanProgress)}</div>`
        : ''
    }

    ${
      state.repoPatchResult
        ? `<div class="audit-result-banner">
        <h4 style="margin:0 0 0.5rem;color:var(--good)">✅ Repository Analysis Complete for ${esc(state.repoPatchResult.repoUrl)}</h4>
        <p style="font-size:0.85rem;margin:0 0 0.5rem">${esc(state.repoPatchResult.recommendations.join(' '))}</p>
        ${
          state.repoPatchResult.diff
            ? `<div class="diff-box">${esc(state.repoPatchResult.diff)}</div>`
            : '<p class="muted">No code changes required. Dapp already uses an anonymizing RPC shim.</p>'
        }
      </div>`
        : ''
    }
  </div>`;
}

function renderSource(): string {
  return `<div class="panel">
    <div class="panel-header">
      <span>📡 Data Source & Attestation Network</span>
      <span style="font-size:0.8rem;font-weight:normal" class="muted"><span class="pulse-dot"></span> Rabdi Testnet Live</span>
    </div>
    <div class="filters">
      <label>Data Source
        <select id="mode">
          <option value="arkiv" ${state.mode === 'arkiv' ? 'selected' : ''}>Arkiv Blockchain (live on-chain)</option>
          <option value="snapshot" ${state.mode === 'snapshot' ? 'selected' : ''}>Local snapshot.json (offline)</option>
        </select>
      </label>
      <label style="flex:1;min-width:20rem">Arkiv RPC Endpoint (reads reveal your IP to it)
        <input id="endpoint" value="${esc(state.endpoint)}" ${state.mode !== 'arkiv' ? 'disabled' : ''} />
      </label>
      <button id="reload" class="primary">Load Records</button>
    </div>
    <div class="row-meta">Chain: Rabdi testnet · Explorer: <span class="mono">${esc(RABDI_EXPLORER_URL)}</span></div>
    <div style="margin-top:0.75rem">
      <span class="muted" style="font-size:0.85rem;font-weight:600">Pinned Trusted Auditors:</span>
      <span class="pin-list" id="pins">
        ${
          state.pinned.length
            ? state.pinned
                .map(
                  (p, i) =>
                    `<span class="badge mono">${esc(shortAddr(p))}<button data-unpin="${i}" title="unpin">✕</button></span>`,
                )
                .join('')
            : '<span class="muted">none yet — every scanner is shown, labelled “unpinned”.</span>'
        }
        <input id="pin-input" placeholder="0x… scanner address" size="18" />
        <button id="pin-add">Pin Auditor</button>
      </span>
    </div>
  </div>`;
}

function renderList(): string {
  const f = state.filters;
  const classes = [
    'rpc-provider',
    'analytics',
    'error-monitoring',
    'support-chat',
    'walletconnect-relay',
    'ipfs-gateway',
    'cdn',
    'unknown-third-party',
  ];
  let rows = latestPerScanner(state.records);
  if (f.pinnedOnly) rows = rows.filter((r) => isPinned(r.scanner) || r.scanner === 'local');
  return `
  <div class="panel">
    <div class="panel-header">
      <span>🔎 Dapp Privacy Registry</span>
      <span class="muted" style="font-size:0.85rem">${rows.length} Audited Application(s)</span>
    </div>
    <div class="filters">
      <label>Hostname <input id="f-hostname" value="${esc(f.hostname)}" placeholder="app.uniswap.org" /></label>
      <label>Min Score <input id="f-min" value="${esc(f.minScore)}" size="4" inputmode="numeric" /></label>
      <label>Max Score <input id="f-max" value="${esc(f.maxScore)}" size="4" inputmode="numeric" /></label>
      <label>Leak Class
        <select id="f-class">
          <option value="">any</option>
          ${classes.map((c) => `<option value="${c}" ${f.leakClass === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      </label>
      <label>Anon-RPC
        <select id="f-anon">
          <option value="">any</option>
          <option value="true" ${f.usesAnonRpc === 'true' ? 'selected' : ''}>uses it</option>
          <option value="false" ${f.usesAnonRpc === 'false' ? 'selected' : ''}>does not</option>
        </select>
      </label>
      <label>Scanner <input id="f-scanner" value="${esc(f.scanner)}" placeholder="0x…" size="12" /></label>
      <label>&nbsp;<span><input type="checkbox" id="f-pinned" ${f.pinnedOnly ? 'checked' : ''}/> Pinned only</span></label>
      <button id="apply" class="primary">Apply Filters</button>
    </div>
  </div>
  <div class="status">
    ${state.error ? `<span class="error">${esc(state.error)}</span>` : ''}
    ${!state.error && !state.loaded ? 'Loading verifiable records from Arkiv…' : ''}
    ${state.loaded ? `${rows.length} result(s) — latest entity per hostname per scanner` : ''}
  </div>
  <div class="table-container">
    <table>
      <thead><tr><th>dapp</th><th>score</th><th>leaks</th><th>leak classes</th><th>third parties</th><th>scanned</th><th>scanner</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr data-id="${esc(r.id)}">
          <td><strong>${esc(r.hostname)}</strong>
              ${r.usesAnonRpc ? '<span class="badge anon-rpc">anon-rpc</span>' : ''}
              ${r.agree > 1 ? `<span class="badge agree">${r.agree} scanners agree</span>` : ''}</td>
          <td class="score ${scoreClass(r.score)}">${r.score}</td>
          <td>${r.leakCount}</td>
          <td>${esc(r.leakClasses || '—')}</td>
          <td>${r.thirdPartyCount}</td>
          <td class="row-meta">${new Date(r.scannedAt * 1000).toISOString().slice(0, 16).replace('T', ' ')}</td>
          <td><span class="mono">${esc(shortAddr(r.scanner))}</span>
              ${isPinned(r.scanner) || r.scanner === 'local' ? '' : '<span class="badge unpinned">unpinned</span>'}</td>
        </tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </div>`;
}

function renderDetail(r: RegistryRecord): string {
  const s = r.summary;
  return `<div class="panel detail">
    <button class="back" id="back">← Back to Registry Results</button>
    <h2>${esc(r.hostname)} <span class="score ${scoreClass(r.score)}">${r.score}</span> / 100</h2>
    <p class="row-meta">
      Scanned: ${new Date(r.scannedAt * 1000).toISOString()} · Scanner: <span class="mono">${esc(r.scanner)}</span>
      ${isPinned(r.scanner) || r.scanner === 'local' ? '<span class="badge anon-rpc">trusted</span>' : '<span class="badge unpinned">unpinned</span>'}<br>
      Arkiv Entity: <span class="mono">${esc(r.id)}</span> · Expiry: ${esc(r.expiresAt ?? '30-day TTL')} ·<br>
      report sha256 <span class="mono">${esc(r.reportSha256)}</span><br>
      Scan Status: <strong>${esc(s.status)}</strong> · Canary Address: <span class="mono">${esc(s.canaryAddress)}</span>
    </p>

    <h3>Detected Leaks & Evidence (${s.findings.length})</h3>
    ${
      s.findings.length
        ? `<div class="table-container"><table><thead><tr><th>class</th><th>destination</th><th>where</th><th>encoding</th><th>phase</th><th>counted</th></tr></thead>
      <tbody>${s.findings
        .map(
          (f) =>
            `<tr><td><strong>${esc(f.class)}</strong></td><td>${esc(f.host)}</td><td>${esc(f.location)}</td><td class="mono">${esc(f.encoding)}</td><td>${esc(f.phase)}</td><td>${f.counted ? 'yes' : 'no'}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
        : '<p class="muted">No canary leaks recorded. User identity remained sealed.</p>'
    }

    <h3>Score Penalty Ledger</h3>
    <div class="table-container"><table><thead><tr><th>rule</th><th>why</th><th style="text-align:right">points</th></tr></thead>
    <tbody>${s.ledger
      .map(
        (l) =>
          `<tr><td class="mono">${esc(l.rule)}</td><td>${esc(l.label)}</td><td style="text-align:right;color:var(--bad)">−${l.points}</td></tr>`,
      )
      .join('')}</tbody></table></div>

    <h3>Third Parties Contacted (${s.thirdParties.length})</h3>
    <div class="table-container"><table><thead><tr><th>host</th><th>class</th><th>phases</th></tr></thead>
    <tbody>${s.thirdParties
      .map(
        (t) =>
          `<tr><td>${esc(t.host)}</td><td>${esc(t.class)}</td><td>${t.phases.map(esc).join(', ')}</td></tr>`,
      )
      .join('')}</tbody></table></div>
  </div>`;
}

function renderEducationalCards(): string {
  return `
  <div class="feature-grid">
    <div class="feature-card">
      <h4>🔍 Closed-Source Dapps & Wallets</h4>
      <p>Igris does not require source code access. Because it audits live network traffic and DOM wallet providers (EIP-1193 / EIP-6963), any closed-source dapp (or proprietary wallet like MetaMask) can be evaluated by inspecting runtime socket and HTTP telemetry.</p>
    </div>
    <div class="feature-card">
      <h4>⚡ Anon-RPC Remediation</h4>
      <p>When dapps read balances or state, Infura/Alchemy logs their IP. Igris automatically patches dapps with the Ethereum Foundation's Anon-RPC shim, routing calls through Nym or Tor mixnets to break IP-wallet correlation.</p>
    </div>
    <div class="feature-card">
      <h4>📜 Verifiable On-Chain Registry</h4>
      <p>Audit records are cryptographically signed and stored on Arkiv (Ethereum Rabdi testnet) with a mandatory 30-day time-to-live. Dapps that fix privacy issues are automatically upgraded on the next audit pass.</p>
    </div>
  </div>`;
}

function wire(): void {
  // Mode switch
  document.querySelector<HTMLSelectElement>('#mode')?.addEventListener('change', (e) => {
    state.mode = (e.target as HTMLSelectElement).value as Mode;
    localStorage.setItem(LS.mode, state.mode);
    render();
  });

  // Reload
  document.querySelector<HTMLButtonElement>('#reload')?.addEventListener('click', () => {
    const endpoint = document.querySelector<HTMLInputElement>('#endpoint')?.value;
    if (endpoint) {
      state.endpoint = endpoint;
      localStorage.setItem(LS.endpoint, endpoint);
    }
    void load();
  });

  // Filter apply
  document.querySelector<HTMLButtonElement>('#apply')?.addEventListener('click', () => {
    readFilters();
    void load();
  });

  // Pinning
  document.querySelector<HTMLButtonElement>('#pin-add')?.addEventListener('click', () => {
    const input = document.querySelector<HTMLInputElement>('#pin-input')!;
    const addr = input.value.trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      state.pinned.push(addr);
      localStorage.setItem(LS.pinned, JSON.stringify(state.pinned));
      render();
    } else {
      input.setCustomValidity('expected a 0x address');
      input.reportValidity();
    }
  });

  document.querySelectorAll<HTMLButtonElement>('[data-unpin]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.pinned.splice(Number(btn.dataset.unpin), 1);
      localStorage.setItem(LS.pinned, JSON.stringify(state.pinned));
      render();
    }),
  );

  // Table row click -> detail
  document.querySelectorAll<HTMLTableRowElement>('tbody tr[data-id]').forEach((tr) =>
    tr.addEventListener('click', () => {
      state.detailId = tr.dataset.id ?? null;
      render();
    }),
  );

  // Detail back
  document.querySelector<HTMLButtonElement>('#back')?.addEventListener('click', () => {
    state.detailId = null;
    render();
  });

  // Hero tabs
  document.querySelector<HTMLButtonElement>('#tab-dapp')?.addEventListener('click', () => {
    state.activeHeroTab = 'dapp';
    render();
  });
  document.querySelector<HTMLButtonElement>('#tab-repo')?.addEventListener('click', () => {
    state.activeHeroTab = 'repo';
    render();
  });

  // Form submit: Scan Live Dapp
  document.querySelector<HTMLFormElement>('#form-scan')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.querySelector<HTMLInputElement>('#scan-url-input');
    const targetUrl = input?.value.trim();
    if (!targetUrl) return;

    state.isScanning = true;
    state.scanProgress = `Connecting to Igris Scanner worker & launching headless Canary browser for ${targetUrl}…`;
    render();

    try {
      const res = await fetch(`${state.apiUrl}/api/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl, dwellMs: 4000 }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(
          errorData.error || errorData.details || `Scan failed with status ${res.status}`,
        );
      }

      const data = await res.json();
      state.scanProgress = `Audit completed! Score: ${data.report.score}/100. Adding to registry…`;

      // Add to records list & show detail immediately
      state.records.unshift(data.record);
      state.detailId = data.record.id;
    } catch (err: unknown) {
      console.warn('Backend scan error:', err);
      state.scanProgress = `Note: Scanner worker at ${state.apiUrl} is offline or unreachable. Tip: Run "pnpm igris scan ${targetUrl}" locally or deploy the backend to Railway/Render. Showing offline preview.`;
    } finally {
      state.isScanning = false;
      setTimeout(() => {
        state.scanProgress = null;
        render();
      }, 3500);
    }
  });

  // Form submit: Patch Repo
  document.querySelector<HTMLFormElement>('#form-patch')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.querySelector<HTMLInputElement>('#patch-repo-input');
    const repoUrl = input?.value.trim();
    if (!repoUrl) return;

    state.isScanning = true;
    state.scanProgress = `Cloning repository ${repoUrl} and analyzing RPC providers…`;
    render();

    try {
      const res = await fetch(`${state.apiUrl}/api/scan-repo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Repository analysis failed with status ${res.status}`);
      }

      const data = await res.json();
      state.repoPatchResult = data;
      state.scanProgress = null;
    } catch {
      state.scanProgress = `Could not reach backend worker at ${state.apiUrl}. Run "pnpm igris fix <repo>" locally or deploy the API service.`;
    } finally {
      state.isScanning = false;
      render();
    }
  });
}

function readFilters(): void {
  const get = (id: string) => document.querySelector<HTMLInputElement>(id)?.value ?? '';
  state.filters = {
    hostname: get('#f-hostname'),
    minScore: get('#f-min'),
    maxScore: get('#f-max'),
    leakClass: get('#f-class'),
    usesAnonRpc: get('#f-anon'),
    scanner: get('#f-scanner'),
    pinnedOnly: document.querySelector<HTMLInputElement>('#f-pinned')?.checked ?? false,
  };
}

render();
void load();
