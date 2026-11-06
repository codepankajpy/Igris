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
  validateRecords,
  type RegistryQuery,
  type RegistryRecord,
  type ScanRecord,
} from '@igris/registry/browser';

/**
 * No scanner is pinned by default: trust is the viewer's decision. (A
 * hardcoded "ours" address would pre-trust a key on the user's behalf.)
 */
const DEFAULT_PINNED: string[] = [];

/**
 * Where a record shown here came from. Only 'arkiv-live' rows were read from
 * Arkiv in this session; nothing else may be presented as an Arkiv entity.
 */
type Provenance = 'arkiv-live' | 'snapshot' | 'unpublished';
type ViewRecord = RegistryRecord & { provenance: Provenance };

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
  records: ViewRecord[];
  /** Scans run through the optional API in this tab — never on Arkiv. */
  unpublished: ViewRecord[];
  lastLoad: { count: number; dropped: number; at: string } | null;
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
    notes: Array<{ file: string; line: number; message: string }>;
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
  unpublished: [],
  lastLoad: null,
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

/** Render a number defensively: anything non-finite becomes an em dash. */
function num(n: unknown): string {
  return typeof n === 'number' && Number.isFinite(n) ? String(n) : '—';
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
    let dropped = 0;
    if (state.mode === 'arkiv') {
      const registry = new ArkivRegistry({ rpcUrl: state.endpoint });
      const rows = await registry.query(currentQuery());
      dropped = registry.lastValidation.dropped;
      state.records = rows.map((r) => ({ ...r, provenance: 'arkiv-live' as const }));
    } else {
      const res = await fetch('./snapshot.json');
      if (!res.ok) throw new Error(`snapshot.json not found next to the page (${res.status})`);
      const file = (await res.json()) as { records?: unknown };
      // Snapshot files are untrusted input too (anyone can hand you one).
      const validated = validateRecords(Array.isArray(file.records) ? file.records : [], {
        source: 'local',
      });
      dropped = validated.dropped;
      state.records = validated.records
        .filter((r) => matchesQuery(r, currentQuery()))
        .map((r) => ({ ...r, provenance: 'snapshot' as const }));
    }
    state.lastLoad = { count: state.records.length, dropped, at: new Date().toISOString() };
    state.loaded = true;
  } catch (err) {
    state.error = String(err);
  }
  render();
}

/** Latest record per (hostname, scanner); also counts agreeing scanners. */
function latestPerScanner(records: ViewRecord[]): Array<ViewRecord & { agree: number }> {
  const latest = new Map<string, ViewRecord>();
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
  const detail = state.detailId
    ? [...state.records, ...state.unpublished].find((r) => r.id === state.detailId)
    : null;
  app.innerHTML = `
  <div class="wrap">
    <header>
      <div class="tagline-badge">Runtime privacy audits for dapps</div>
      <div class="header-brand">
        <div class="logo-icon">I</div>
        <h1>Igris Registry</h1>
      </div>
      <p>Which third parties learn a dapp user's wallet address or IP — measured with a throwaway canary wallet, published as signed attestations by independent scanners.</p>
    </header>

    ${renderHeroAuditor()}
    ${renderSource()}
    ${detail ? renderDetail(detail) : renderList()}
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
        <h4 style="margin:0 0 0.5rem">Repository analysed: ${esc(state.repoPatchResult.repoUrl)}</h4>
        <p style="font-size:0.85rem;margin:0 0 0.5rem">${
          state.repoPatchResult.changedFiles.length
            ? `${num(state.repoPatchResult.changedFiles.length)} file(s) would change to route RPC reads through Anon-RPC. Review the diff and apply it yourself (or run <span class="mono">igris fix --write</span> locally).`
            : 'The patcher found no viem / ethers / wagmi RPC setup it can rewrite. This does not mean the dapp is private: it may use other libraries or patterns the patcher does not recognise.'
        }</p>
        ${
          state.repoPatchResult.notes.length
            ? `<ul class="row-meta">${state.repoPatchResult.notes.map((n) => `<li>${esc(n.file)}:${num(n.line)} — ${esc(n.message)}</li>`).join('')}</ul>`
            : ''
        }
        ${state.repoPatchResult.diff ? `<div class="diff-box">${esc(state.repoPatchResult.diff)}</div>` : ''}
      </div>`
        : ''
    }
  </div>`;
}

function renderSource(): string {
  return `<div class="panel">
    <div class="panel-header">
      <span>📡 Data Source & Attestation Network</span>
      <span style="font-size:0.8rem;font-weight:normal" class="muted">${
        state.error
          ? 'Last load failed'
          : state.lastLoad
            ? `${num(state.lastLoad.count)} record(s) from ${state.mode === 'arkiv' ? 'Arkiv' : 'snapshot'} at ${esc(state.lastLoad.at.slice(11, 19))} UTC${state.lastLoad.dropped ? ` · ${num(state.lastLoad.dropped)} malformed entit${state.lastLoad.dropped === 1 ? 'y' : 'ies'} ignored` : ''}`
            : 'Not loaded yet'
      }</span>
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
      <span class="muted" style="font-size:0.85rem;font-weight:600">Pinned scanners (your choice, stored in this browser):</span>
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
        <button id="pin-add">Pin scanner</button>
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
    'wallet-sdk',
    'ipfs-gateway',
    'cdn',
    'unknown-third-party',
  ];
  let rows = latestPerScanner(state.records);
  if (f.pinnedOnly) rows = rows.filter((r) => isPinned(r.scanner));
  return `
  ${renderUnpublished()}
  <div class="panel">
    <div class="panel-header">
      <span>Registry</span>
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
    ${!state.error && !state.loaded ? `Loading records from ${state.mode === 'arkiv' ? 'Arkiv' : 'the snapshot file'}…` : ''}
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
              ${r.agree > 1 ? `<span class="badge agree">${num(r.agree)} scanners published</span>` : ''}</td>
          <td class="score ${scoreClass(r.score)}">${num(r.score)}${coveragePartial(r) ? '<span class="row-meta"> partial</span>' : ''}</td>
          <td>${num(r.leakCount)}</td>
          <td>${esc(r.leakClasses || '—')}</td>
          <td>${num(r.thirdPartyCount)}</td>
          <td class="row-meta">${esc(new Date(r.scannedAt * 1000).toISOString().slice(0, 16).replace('T', ' '))}</td>
          <td>${scannerLabel(r)}</td>
        </tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </div>`;
}

/** Scan covered only the pre-connect phase (wallet never connected). */
function coveragePartial(r: RegistryRecord): boolean {
  const c =
    r.summary.coverage ??
    (r.summary.status === 'wallet-connect-failed' ? 'pre-connect-only' : 'full');
  return c === 'pre-connect-only';
}

/** Scanner cell for the list: only live Arkiv rows have an attested owner. */
function scannerLabel(r: ViewRecord): string {
  if (r.provenance === 'unpublished') return '<span class="badge unpinned">unpublished</span>';
  if (r.scanner === 'local') return '<span class="row-meta">local file</span>';
  const pin = isPinned(r.scanner)
    ? '<span class="badge anon-rpc">pinned</span>'
    : '<span class="badge unpinned">not pinned</span>';
  const src = r.provenance === 'snapshot' ? '<span class="row-meta"> (snapshot)</span>' : '';
  return `<span class="mono">${esc(shortAddr(r.scanner))}</span> ${pin}${src}`;
}

/** Provenance paragraph: says exactly what is and is not established. */
function provenanceBlock(r: ViewRecord): string {
  if (r.provenance === 'unpublished') {
    return `<p class="provenance unpublished"><strong>Unpublished — not on Arkiv.</strong>
      Produced in this browser tab by the scanner API at <span class="mono">${esc(state.apiUrl)}</span>.
      No scanner key attests it, it is not stored anywhere, and it disappears on reload.
      To publish an attestation, run <span class="mono">igris scan</span> + <span class="mono">igris publish</span> with your own scanner key.</p>`;
  }
  if (r.provenance === 'snapshot') {
    return `<p class="provenance">From a <strong>snapshot file</strong> (offline mode).
      Entity key and scanner below are as recorded in the file and were <strong>not checked against Arkiv</strong> in this session.<br>
      Recorded entity: <span class="mono">${esc(r.id)}</span> · scanner: <span class="mono">${esc(r.scanner)}</span></p>`;
  }
  return `<p class="provenance">Read live from <strong>Arkiv</strong> (${esc(state.endpoint)}).
    Entity <span class="mono">${esc(r.id)}</span> · owner (scanner) <span class="mono">${esc(r.scanner)}</span>
    ${isPinned(r.scanner) ? '<span class="badge anon-rpc">pinned by you</span>' : '<span class="badge unpinned">not pinned by you</span>'}
    · expires ${esc(r.expiresAt ?? 'unknown')}<br>
    <a href="${esc(RABDI_EXPLORER_URL)}" rel="noreferrer noopener" target="_blank">Open the Rabdi explorer</a> and search the entity key to inspect it independently.</p>`;
}

function renderDetail(r: ViewRecord): string {
  const s = r.summary;
  const partial = coveragePartial(r);
  const statusBadge =
    s.status === 'completed'
      ? '<span class="badge anon-rpc">wallet connected</span>'
      : '<span class="badge unpinned">wallet not connected</span>';
  const counted = s.findings.filter((f) => f.counted);
  const uncounted = s.findings.length - counted.length;
  const h = s.securityHeaders;

  return `<div class="panel detail">
    <button class="back" id="back">← Back to results</button>
    <h2>${esc(r.hostname)} <span class="score ${scoreClass(r.score)}">${num(r.score)}</span> / 100 ${statusBadge}</h2>
    ${
      partial
        ? `<p class="coverage-note"><strong>Partial scan:</strong> the wallet never connected, so address leaks after connect were <strong>not tested</strong>. The score covers only what happens before connect.</p>`
        : ''
    }
    ${provenanceBlock(r)}
    <p class="row-meta">
      Scanned ${esc(new Date(r.scannedAt * 1000).toISOString())} · scanner v${esc(r.scannerVersion)} · report v${esc(r.reportVersion)}<br>
      report sha256 <span class="mono">${esc(r.reportSha256)}</span>
      <span class="row-meta">(hash of the scanner's full report; that report is not published yet, so this hash cannot be checked independently)</span><br>
      Canary address <span class="mono">${esc(s.canaryAddress)}</span> (throwaway) · MetaMask spoofing ${s.spoofMetaMask ? 'on' : 'off'}
    </p>

    <div class="telemetry-grid">
      <div class="telemetry-card">
        <div class="telemetry-label">Network traffic</div>
        <div class="telemetry-value">${s.telemetry ? `${num(s.telemetry.totalRequests)} requests` : 'not recorded'}</div>
        <div class="telemetry-sub">${s.telemetry ? `${num(s.telemetry.preConnectRequests)} pre / ${num(s.telemetry.postConnectRequests)} post connect` : ''}</div>
      </div>
      <div class="telemetry-card">
        <div class="telemetry-label">Third parties</div>
        <div class="telemetry-value">${num(s.thirdParties.length)} contacted</div>
        <div class="telemetry-sub">${num(s.thirdParties.filter((t) => t.phases.includes('pre-connect')).length)} before connect</div>
      </div>
      <div class="telemetry-card">
        <div class="telemetry-label">Security headers (main document)</div>
        <div class="telemetry-value">${h ? (h.cspPresent ? 'CSP present' : 'CSP missing') : 'Unknown'}</div>
        <div class="telemetry-sub">${h ? (h.hstsPresent ? 'HSTS present' : 'HSTS missing') : 'not observed in this record'}</div>
      </div>
      <div class="telemetry-card">
        <div class="telemetry-label">Address leaks to third parties</div>
        <div class="telemetry-value" style="color:${counted.length ? 'var(--bad)' : 'var(--fg)'}">${num(counted.length)}</div>
        <div class="telemetry-sub">${uncounted ? `${num(uncounted)} more observation(s) not scored (local storage, first-party, partial)` : partial ? 'post-connect not tested' : 'none observed'}</div>
      </div>
    </div>

    ${
      s.connectionLog && s.connectionLog.length
        ? `<h3>Wallet connection log</h3>
        <div class="connection-log">
          ${s.connectionLog.map((line) => `<div class="connection-log-step">${esc(line)}</div>`).join('')}
        </div>`
        : ''
    }

    <h3>Observations (${num(s.findings.length)})</h3>
    <p class="row-meta">Per-request evidence (redacted snippets) lives in the scanner's full report, which is not part of this record.</p>
    ${
      s.findings.length
        ? `<div class="table-container"><table><thead><tr><th>class</th><th>destination</th><th>where</th><th>encoding</th><th>phase</th><th>scored</th></tr></thead>
      <tbody>${s.findings
        .map(
          (f) =>
            `<tr><td><strong>${esc(f.class)}</strong></td><td>${esc(f.host)}</td><td>${esc(f.location)}</td><td class="mono">${esc(f.encoding)}</td><td>${esc(f.phase)}</td><td>${f.counted ? 'yes' : 'no'}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
        : `<p class="muted">No canary address observed in captured traffic${partial ? ' (post-connect phase not tested)' : ''}.</p>`
    }

    <h3>Score ledger</h3>
    <div class="table-container"><table><thead><tr><th>rule</th><th>why</th><th style="text-align:right">points</th></tr></thead>
    <tbody>${s.ledger
      .map(
        (l) =>
          `<tr><td class="mono">${esc(l.rule)}</td><td>${esc(l.label)}</td><td style="text-align:right;color:var(--bad)">−${num(l.points)}</td></tr>`,
      )
      .join('')}</tbody></table></div>

    <h3>Third parties contacted (${num(s.thirdParties.length)})</h3>
    <div class="table-container"><table><thead><tr><th>host</th><th>class</th><th>requests</th><th>phases</th></tr></thead>
    <tbody>${s.thirdParties
      .map(
        (t) =>
          `<tr><td><strong>${esc(t.host)}</strong></td><td>${esc(t.class)}</td><td>${num(t.requestCount)}</td><td>${t.phases.map(esc).join(', ')}</td></tr>`,
      )
      .join('')}</tbody></table></div>
  </div>`;
}

function renderUnpublished(): string {
  if (!state.unpublished.length) return '';
  return `<div class="panel">
    <div class="panel-header"><span>Your unpublished scans (this tab only — not on Arkiv)</span></div>
    <div class="table-container"><table>
      <thead><tr><th>dapp</th><th>score</th><th>leaks</th><th>scanned</th><th>status</th></tr></thead>
      <tbody>${state.unpublished
        .map(
          (r) => `<tr data-id="${esc(r.id)}">
        <td><strong>${esc(r.hostname)}</strong></td>
        <td class="score ${scoreClass(r.score)}">${num(r.score)}${coveragePartial(r) ? '<span class="row-meta"> partial</span>' : ''}</td>
        <td>${num(r.leakCount)}</td>
        <td class="row-meta">${esc(new Date(r.scannedAt * 1000).toISOString().slice(0, 16).replace('T', ' '))}</td>
        <td><span class="badge unpinned">unpublished</span></td>
      </tr>`,
        )
        .join('')}</tbody>
    </table></div>
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
    state.scanProgress = `Scanning ${targetUrl} on the scanner API at ${state.apiUrl} (optional hosted node; the result will be unpublished)…`;
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

      const data = (await res.json()) as {
        provenance: 'unpublished';
        preview: ScanRecord | null;
        // Report v2 (only the fields this view needs).
        report: { scan: { status: string; notes: string[] }; privacy: { score: number | null } };
      };
      if (!data.preview) {
        // Nothing was measured: no score, nothing to show as a result.
        state.scanProgress = `Not scored: the page did not load (${data.report.scan.status}). ${data.report.scan.notes[0] ?? ''}`;
      } else {
        const record: ViewRecord = {
          ...data.preview,
          id: `unpublished-${Date.now()}-${state.unpublished.length + 1}`,
          scanner: 'unpublished',
          provenance: 'unpublished',
        };
        state.unpublished.unshift(record);
        state.detailId = record.id;
        state.scanProgress = `Scan finished (unpublished, not on Arkiv). Score ${num(record.score)}/100${coveragePartial(record) ? ' — partial: wallet not connected' : ''}.`;
      }
    } catch (err: unknown) {
      console.warn('Backend scan error:', err);
      state.scanProgress = `Scan failed: ${err instanceof Error ? err.message : 'scanner API unreachable'} (API: ${state.apiUrl}). You can always scan locally: pnpm igris scan ${targetUrl}`;
    } finally {
      // Render the outcome immediately. The message stays until the next
      // action, so "not scored" and failures are never silently cleared.
      state.isScanning = false;
      render();
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
    } catch (err: unknown) {
      state.scanProgress = `Repository analysis failed: ${err instanceof Error ? err.message : 'scanner API unreachable'} (API: ${state.apiUrl}). You can run "pnpm igris fix <path>" locally.`;
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
