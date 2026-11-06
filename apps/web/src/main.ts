/**
 * Igris Registry viewer — a static page, no backend of ours.
 *
 * Privacy posture (docs/METHODOLOGY.md):
 *  - Reads reveal the READER's IP to whichever Arkiv RPC endpoint is used, so
 *    the endpoint is user-configurable and shown, and a fully offline
 *    "snapshot" mode (a JSON file produced by `igris snapshot`) exists.
 *  - Trust: an entity is an attestation by its scanner address, not a fact.
 *    The viewer only highlights entities from scanner addresses the user has
 *    pinned (stored in the viewer's own localStorage), and labels the rest.
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
 * Scanner addresses pinned by default — "ours". TODO(human): replace with the
 * real Igris team scanner address after the first funded publish, so fresh
 * visitors see our attestations as pinned.
 */
const DEFAULT_PINNED: string[] = [];

const LS = {
  endpoint: 'igris:endpoint',
  pinned: 'igris:pinnedScanners',
  mode: 'igris:mode',
};

type Mode = 'arkiv' | 'snapshot';

interface State {
  mode: Mode;
  endpoint: string;
  pinned: string[];
  records: RegistryRecord[];
  loaded: boolean;
  error: string | null;
  detailId: string | null;
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
  pinned: JSON.parse(localStorage.getItem(LS.pinned) || 'null') ?? DEFAULT_PINNED,
  records: [],
  loaded: false,
  error: null,
  detailId: null,
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
      // THE Arkiv read: a filtered select over igris.scan.v1 entities. The
      // filters drive the query itself (not just client-side trimming).
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
  const detail = state.detailId
    ? state.records.find((r) => r.id === state.detailId)
    : null;
  app.innerHTML = `
  <div class="wrap">
    <header>
      <h1>Igris Registry</h1>
      <p>Scan attestations for dapp privacy, stored on Arkiv. An entity is an
         attestation by its scanner address — pin the scanners you trust.</p>
    </header>
    ${renderSource()}
    ${detail ? renderDetail(detail) : renderList()}
  </div>`;
  wire();
}

function renderSource(): string {
  return `<div class="panel">
    <div class="filters">
      <label>data source
        <select id="mode">
          <option value="arkiv" ${state.mode === 'arkiv' ? 'selected' : ''}>Arkiv (live)</option>
          <option value="snapshot" ${state.mode === 'snapshot' ? 'selected' : ''}>local snapshot.json (offline)</option>
        </select>
      </label>
      <label style="flex:1;min-width:20rem">Arkiv RPC endpoint (reads reveal your IP to it)
        <input id="endpoint" value="${esc(state.endpoint)}" ${state.mode !== 'arkiv' ? 'disabled' : ''} />
      </label>
      <button id="reload" class="primary">Load</button>
    </div>
    <div class="row-meta">chain: Rabdi testnet · explorer: <span class="mono">${esc(RABDI_EXPLORER_URL)}</span></div>
    <div>
      <span class="muted">pinned scanners (trusted):</span>
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
        <button id="pin-add">pin</button>
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
    <div class="filters">
      <label>hostname <input id="f-hostname" value="${esc(f.hostname)}" placeholder="app.example.org" /></label>
      <label>min score <input id="f-min" value="${esc(f.minScore)}" size="4" inputmode="numeric" /></label>
      <label>max score <input id="f-max" value="${esc(f.maxScore)}" size="4" inputmode="numeric" /></label>
      <label>leak class
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
      <label>scanner <input id="f-scanner" value="${esc(f.scanner)}" placeholder="0x…" size="12" /></label>
      <label>&nbsp;<span><input type="checkbox" id="f-pinned" ${f.pinnedOnly ? 'checked' : ''}/> pinned only</span></label>
      <button id="apply" class="primary">Apply filters</button>
    </div>
  </div>
  <div class="status">
    ${state.error ? `<span class="error">${esc(state.error)}</span>` : ''}
    ${!state.error && !state.loaded ? 'loading…' : ''}
    ${state.loaded ? `${rows.length} result(s) — latest entity per hostname per scanner` : ''}
  </div>
  <table>
    <thead><tr><th>dapp</th><th>score</th><th>leaks</th><th>leak classes</th><th>third parties</th><th>scanned</th><th>scanner</th></tr></thead>
    <tbody>
      ${rows
        .map(
          (r) => `<tr data-id="${esc(r.id)}">
        <td><strong>${esc(r.hostname)}</strong>
            ${r.usesAnonRpc ? '<span class="badge anon">anon-rpc</span>' : ''}
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
  </table>`;
}

function renderDetail(r: RegistryRecord): string {
  const s = r.summary;
  return `<div class="panel detail">
    <button class="back" id="back">← back to results</button>
    <h2>${esc(r.hostname)} <span class="score ${scoreClass(r.score)}">${r.score}</span>/100</h2>
    <p class="row-meta">
      scanned ${new Date(r.scannedAt * 1000).toISOString()} · scanner <span class="mono">${esc(r.scanner)}</span>
      ${isPinned(r.scanner) || r.scanner === 'local' ? '(pinned)' : '<span class="badge unpinned">unpinned</span>'}<br>
      entity <span class="mono">${esc(r.id)}</span> · ${esc(r.expiresAt ?? '')} ·
      report sha256 <span class="mono">${esc(r.reportSha256)}</span><br>
      scan status: ${esc(s.status)} · scanner v${esc(r.scannerVersion)} · report v${esc(r.reportVersion)} ·
      canary <span class="mono">${esc(s.canaryAddress)}</span>
    </p>

    <h3>Findings (${s.findings.length})</h3>
    ${
      s.findings.length
        ? `<table><thead><tr><th>class</th><th>destination</th><th>where</th><th>encoding</th><th>phase</th><th>counted</th></tr></thead>
      <tbody>${s.findings
        .map(
          (f) =>
            `<tr><td>${esc(f.class)}</td><td>${esc(f.host)}</td><td>${esc(f.location)}</td><td class="mono">${esc(f.encoding)}</td><td>${esc(f.phase)}</td><td>${f.counted ? 'yes' : 'no'}</td></tr>`,
        )
        .join('')}</tbody></table>`
        : '<p class="muted">no canary leaks recorded.</p>'
    }

    <h3>Score ledger</h3>
    <table><thead><tr><th>rule</th><th>why</th><th class="right">points</th></tr></thead>
    <tbody>${s.ledger
      .map(
        (l) =>
          `<tr><td class="mono">${esc(l.rule)}</td><td>${esc(l.label)}</td><td class="right">−${l.points}</td></tr>`,
      )
      .join('')}</tbody></table>

    <h3>Third parties contacted (${s.thirdParties.length})</h3>
    <table><thead><tr><th>host</th><th>class</th><th>phases</th></tr></thead>
    <tbody>${s.thirdParties
      .map(
        (t) =>
          `<tr><td>${esc(t.host)}</td><td>${esc(t.class)}</td><td>${t.phases.map(esc).join(', ')}</td></tr>`,
      )
      .join('')}</tbody></table>
  </div>`;
}

function wire(): void {
  document.querySelector<HTMLSelectElement>('#mode')?.addEventListener('change', (e) => {
    state.mode = (e.target as HTMLSelectElement).value as Mode;
    localStorage.setItem(LS.mode, state.mode);
    render();
  });
  document.querySelector<HTMLButtonElement>('#reload')?.addEventListener('click', () => {
    const endpoint = document.querySelector<HTMLInputElement>('#endpoint')?.value;
    if (endpoint) {
      state.endpoint = endpoint;
      localStorage.setItem(LS.endpoint, endpoint);
    }
    void load();
  });
  document.querySelector<HTMLButtonElement>('#apply')?.addEventListener('click', () => {
    readFilters();
    void load();
  });
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
  document.querySelectorAll<HTMLTableRowElement>('tbody tr[data-id]').forEach((tr) =>
    tr.addEventListener('click', () => {
      state.detailId = tr.dataset.id ?? null;
      render();
    }),
  );
  document.querySelector<HTMLButtonElement>('#back')?.addEventListener('click', () => {
    state.detailId = null;
    render();
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
// Initial load. In snapshot mode this touches only ./snapshot.json (same
// origin); in arkiv mode the ONLY network destination is the user-configured
// endpoint — asserted by the zero-network Playwright test.
void load();
