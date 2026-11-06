/**
 * The report's detail sections: what changed since the previous version,
 * findings, wallet connection, network & storage, security headers,
 * integrity, and the scan run. Every value is the backend's; the only
 * computation is the in-browser integrity re-check of the data received.
 */
import { useEffect, useState } from 'preact/hooks';
import {
  bundleHash,
  contentHash,
  verifyReportIntegrity,
  type DocumentHeadersEvidence,
  type FindingV3,
  type IntegrityResult,
} from '@igris/core/contracts';
import type { Changes } from '../api.js';
import type { ReportData } from './data.js';
import { paths } from '../router.js';
import {
  ADDRESS_LABEL,
  Check,
  Hash,
  NotRecorded,
  Section,
  VerdictChip,
  classLabel,
  download,
  duration,
  kitWording,
  plural,
  stamp,
} from '../ui.js';

// ------------------------------------------------------------- changes

export function ChangesSection({
  changes,
  version,
}: {
  changes: Changes | null;
  /** Null for a scan that is not published yet (it is not a version). */
  version: number | null;
}) {
  const prev = version === null ? null : version - 1;
  let body;
  if (changes === null) {
    body = (
      <p class="muted">
        {version === null
          ? 'This scan is not published yet, so it is not a version of this site and is not compared with one.'
          : version === 1
            ? 'This is the first published version of this site — there is nothing to compare yet.'
            : 'No comparison with the previous version is available.'}
      </p>
    );
  } else {
    const none = !changes.added.length && !changes.removed.length && !changes.changed.length;
    body = (
      <>
        <div class={`panel change-banner ${changes.sameBehaviour ? 'same' : 'diff'}`}>
          <span class="change-mark" aria-hidden="true">
            {changes.sameBehaviour ? '=' : 'Δ'}
          </span>
          <div>
            <b>
              {changes.sameBehaviour
                ? `Same behaviour as v${prev}`
                : `Behaviour changed since v${prev}`}
            </b>
            <div class="muted small">
              {changes.sameBehaviour
                ? 'The set of findings is identical to the previous version.'
                : 'The set of findings differs from the previous version.'}
              {none && ' No third party was added, removed or re-classified.'}
            </div>
          </div>
        </div>
        {!none && (
          <div class="grid g-3" style={{ marginTop: 16 }}>
            <ChangeList title="New third parties" items={changes.added} empty="None" />
            <ChangeList title="No longer contacted" items={changes.removed} empty="None" />
            <div class="panel">
              <div class="eyebrow">Changed</div>
              {changes.changed.length === 0 ? (
                <p class="muted small">None</p>
              ) : (
                <ul class="change-list">
                  {changes.changed.map((c) => (
                    <li key={`${c.ref.registrableDomain}|${c.ref.class}`}>
                      <b class="mono">{c.ref.registrableDomain}</b>{' '}
                      <span class="muted small">{classLabel(c.ref.class)}</span>
                      <div class="change-ft">
                        <VerdictChip verdict={c.from.verdict} />
                        <span class="muted">→</span>
                        <VerdictChip verdict={c.to.verdict} />
                      </div>
                      {c.from.address !== c.to.address && (
                        <div class="muted small">
                          {ADDRESS_LABEL[c.from.address]} → {ADDRESS_LABEL[c.to.address]}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </>
    );
  }
  return (
    <Section
      id="changes"
      title={prev === null || prev === 0 ? 'What changed' : `What changed since v${prev}`}
      aside="computed by the API from the two published reports"
    >
      {body}
    </Section>
  );
}

function ChangeList({
  title,
  items,
  empty,
}: {
  title: string;
  items: Changes['added'];
  empty: string;
}) {
  return (
    <div class="panel">
      <div class="eyebrow">{title}</div>
      {items.length === 0 ? (
        <p class="muted small">{empty}</p>
      ) : (
        <ul class="change-list">
          {items.map((r) => (
            <li key={`${r.registrableDomain}|${r.class}`}>
              <b class="mono">{r.registrableDomain}</b>{' '}
              <span class="muted small">{classLabel(r.class)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------- findings

const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

function groupFindings(fs: FindingV3[]): FindingV3[][] {
  const m = new Map<string, FindingV3[]>();
  for (const f of [...fs].sort(
    (a, b) =>
      SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) ||
      a.title.localeCompare(b.title),
  )) {
    const k = `${f.severity}|${f.kind}|${f.title}`;
    m.set(k, [...(m.get(k) ?? []), f]);
  }
  return [...m.values()];
}

export function Sev({ s }: { s: string }) {
  return (
    <span class={`sev ${s}`}>
      <i aria-hidden="true" />
      {s}
    </span>
  );
}

function FindingRow({
  group,
  evidenceHref,
  open: initiallyOpen = false,
}: {
  group: FindingV3[];
  evidenceHref: (id: string) => string;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const f = group[0]!;
  return (
    <div class={`finding ${open ? 'open' : ''}`}>
      <button
        class="finding-head"
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <Sev s={f.severity} />
        <span class="finding-title">
          {f.title}
          {group.length > 1 && <span class="mono muted"> ×{group.length}</span>}
        </span>
        <span class="finding-meta">
          <span class="chip">{f.kind}</span>
          <span class="finding-caret" aria-hidden="true">
            ›
          </span>
        </span>
      </button>
      {open && (
        <div class="finding-body">
          <div class="grid g-2">
            <div>
              <div class="eyebrow">Impact</div>
              <p>{f.impact}</p>
            </div>
            <div>
              <div class="eyebrow">Remediation</div>
              <p>{f.remediation}</p>
            </div>
          </div>
          {group.map((g) => (
            <div class="finding-foot" key={g.id}>
              <span class="mono muted">{g.id}</span>
              <span class="mono muted">
                {g.detector}@{g.detectorVersion}
              </span>
              <span class="mono muted">confidence: {g.confidence}</span>
              <span style={{ marginLeft: 'auto', flexWrap: 'wrap' }} class="row">
                {g.evidence.map((ref) => (
                  <a key={ref.id} class="chip evidence-link" href={evidenceHref(ref.id)}>
                    {ref.type} · {ref.id.slice(3, 11)} →
                  </a>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function FindingsSection({
  findings,
  evidenceHref,
  id = 'findings',
  title = 'Findings',
  empty = 'No privacy findings.',
}: {
  findings: FindingV3[];
  evidenceHref: (id: string) => string;
  id?: string;
  title?: string;
  empty?: string;
}) {
  const groups = groupFindings(findings);
  return (
    <Section id={id} title={title} aside={plural(findings.length, 'finding')}>
      {groups.length === 0 ? (
        <p class="muted">{empty}</p>
      ) : (
        <div class="panel flush">
          {groups.map((g, i) => (
            <FindingRow
              key={g[0]!.id}
              group={g}
              evidenceHref={evidenceHref}
              open={i === 0 && (g[0]!.severity === 'critical' || g[0]!.severity === 'high')}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------- wallet

export function WalletSection({ data }: { data: ReportData }) {
  const { report } = data;
  const conn = report.scan.connection;
  const kit = conn?.kit;
  return (
    <Section id="wallet" title="Wallet connection" aside="how the throwaway wallet was connected">
      <div class="grid g-2">
        <div class="panel">
          <div class="eyebrow">Connection</div>
          <div class="big-statement">
            {report.scan.status === 'completed'
              ? 'Connected'
              : report.scan.status === 'wallet-connect-failed'
                ? 'Not connected'
                : 'Page did not load'}
          </div>
          <div class="muted small">
            {conn
              ? `${plural(conn.requestAccountsCalls, 'eth_requestAccounts call')} received · strategy ${conn.strategy}${conn.recipe ? ` · recipe ${conn.recipe}` : ''}`
              : 'No connection diagnostics in this report'}
          </div>
          {conn?.failure && (
            <div class="small" style={{ marginTop: 10 }}>
              <span class="mono">{conn.failure.category}</span> at {conn.failure.step}:{' '}
              <span class="dim">{conn.failure.detail}</span>
            </div>
          )}
        </div>
        <div class="panel">
          <div class="eyebrow">Wallet kit</div>
          <div class="big-statement">
            {kit && kit.id !== 'none'
              ? kitWording(kit.id, kit.confidence)
              : 'No known kit identified'}
          </div>
          {kit && kit.signals.length > 0 ? (
            <div class="signals">
              {kit.signals.map((s) => (
                <code key={s}>{s}</code>
              ))}
            </div>
          ) : (
            <div class="muted small">No identifying signals recorded.</div>
          )}
        </div>
      </div>
      {conn && conn.steps.length > 0 && (
        <div class="panel flush table-wrap" style={{ marginTop: 16 }}>
          <table class="table">
            <thead>
              <tr>
                <th>Connect step</th>
                <th>Result</th>
                <th>Detail</th>
                <th class="r">Time</th>
              </tr>
            </thead>
            <tbody>
              {conn.steps.map((s, i) => (
                <tr key={i}>
                  <td class="mono">{s.step}</td>
                  <td>
                    <span class="chip">{s.result}</span>
                  </td>
                  <td class="dim small">{s.detail}</td>
                  <td class="r mono muted num">{duration(s.ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------- network

export function NetworkSection({ data }: { data: ReportData }) {
  const { report } = data;
  const t = report.telemetry;
  const contacts = [...report.contacts].sort(
    (a, b) => b.requestCount - a.requestCount || a.host.localeCompare(b.host),
  );
  const max = Math.max(1, ...contacts.map((c) => c.requestCount));
  return (
    <Section id="network" title="Network & storage">
      {t === null ? (
        <NotRecorded what="This version’s report carries no request, cookie or storage counts." />
      ) : (
        <div class="stat-grid">
          <Stat
            k={t.totalRequests}
            l="requests"
            s={`${t.preConnectRequests} before · ${t.postConnectRequests} after connecting`}
          />
          <Stat k={t.cookiesCount} l="cookies" />
          <Stat k={t.localStorageCount} l="localStorage keys" />
          <Stat k={t.sessionStorageCount} l="sessionStorage keys" />
          <Stat
            k={t.wsConnections ?? '—'}
            l="websockets"
            s={t.wsFrames === null ? 'frames not recorded' : `${t.wsFrames} frames`}
          />
        </div>
      )}
      {contacts.length > 0 && (
        <div class="panel flush table-wrap" style={{ marginTop: 16 }}>
          <table class="table">
            <caption class="sr-only">Third-party hosts contacted, with request counts</caption>
            <thead>
              <tr>
                <th scope="col">Third-party host</th>
                <th scope="col">Class</th>
                <th scope="col">When</th>
                <th scope="col" class="r">
                  Requests
                </th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={`${c.host}|${c.class}`}>
                  <td class="mono">{c.host}</td>
                  <td class="small">{classLabel(c.class)}</td>
                  <td class="small muted">
                    {c.phases.map((p) => (p === 'pre-connect' ? 'before' : 'after')).join(' + ')}
                  </td>
                  <td class="r">
                    <span class="hbar inline" aria-hidden="true">
                      <span style={{ width: `${(c.requestCount / max) * 100}%` }} />
                    </span>
                    <span class="mono num">{c.requestCount}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Stat({ k, l, s }: { k: string | number; l: string; s?: string }) {
  return (
    <div class="panel stat">
      <div class="stat-k num">{k}</div>
      <div class="eyebrow">{l}</div>
      {s && <div class="muted small">{s}</div>}
    </div>
  );
}

// ------------------------------------------------------------- security

const HEADER_LABEL: Record<string, string> = {
  'content-security-policy': 'Content-Security-Policy',
  'content-security-policy-report-only': 'CSP (report-only)',
  'strict-transport-security': 'Strict-Transport-Security',
  'x-frame-options': 'X-Frame-Options',
};

export function SecuritySection({
  data,
  evidenceHref,
}: {
  data: ReportData;
  evidenceHref: (id: string) => string;
}) {
  const { report, evidence } = data;
  const doc = Object.entries(evidence.items).find(([, i]) => i.type === 'document-headers') as
    [string, DocumentHeadersEvidence] | undefined;
  return (
    <>
      <Section
        id="security"
        title="Security headers"
        aside="main document · listed separately from privacy"
      >
        {doc ? (
          <div class="panel flush table-wrap" style={{ marginBottom: 16 }}>
            <table class="table">
              <caption class="sr-only">Security headers of the main document</caption>
              <thead>
                <tr>
                  <th scope="col">Header</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(doc[1].headers).map(([k, v]) => (
                  <tr key={k}>
                    <td class="mono small">{HEADER_LABEL[k] ?? k}</td>
                    <td class="mono small header-value">{v ?? <span class="chip">absent</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div class="table-foot small muted">
              {doc[1].documentUrl} · HTTP {doc[1].status} ·{' '}
              <a class="link" href={evidenceHref(doc[0])}>
                evidence →
              </a>
            </div>
          </div>
        ) : (
          <p class="muted">No main-document response was observed.</p>
        )}
      </Section>
      <FindingsSection
        id="security-observations"
        title="Security observations"
        findings={report.security.observations}
        evidenceHref={evidenceHref}
        empty="No security observations."
      />
    </>
  );
}

// ------------------------------------------------------------- integrity

export function IntegritySection({ data }: { data: ReportData }) {
  const { report, evidence, scan } = data;
  const [local, setLocal] = useState<{
    integrity: IntegrityResult;
    reportHash: string;
    bundle: string;
    ms: number;
  } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      const t0 = performance.now();
      const integrity = verifyReportIntegrity(report, evidence);
      const reportHash = contentHash(report);
      const bundle = bundleHash(evidence);
      setLocal({ integrity, reportHash, bundle, ms: Math.round(performance.now() - t0) });
    }, 30);
    return () => clearTimeout(t);
  }, [report, evidence]);
  const base =
    data.ref.kind === 'version'
      ? `${data.hostname}-v${data.ref.version}`
      : `${data.hostname}-scan-${data.ref.id.slice(0, 8)}`;
  const from =
    data.source === 'arkiv'
      ? 'the Arkiv entity'
      : scan
        ? 'the published entity, as stored on this server'
        : 'this server’s cached copy of the scan';

  return (
    <Section id="integrity" title="Integrity" aside="can this report be trusted as delivered?">
      <div class="grid g-2">
        <div class="panel">
          <div class="eyebrow">Verified by the API on read</div>
          <div class="check-list">
            <Check
              ok={data.verified}
              label={
                data.verified
                  ? `Hashes match ${from}; schema valid; recipients and verdicts recompute`
                  : 'Verification failed'
              }
            />
          </div>
          {data.problems.length > 0 && (
            <ul class="points small">
              {data.problems.map((p) => (
                <li key={p} class="mono">
                  {p}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div class="panel">
          <div class="eyebrow">Re-verified in this browser</div>
          {local ? (
            <>
              <div class="check-list">
                {scan ? (
                  <>
                    <Check
                      ok={local.reportHash === scan.scanId}
                      label="Report hashes to the published scanId"
                    />
                    <Check
                      ok={
                        local.bundle === scan.evidenceSha256 &&
                        local.bundle === report.evidence.sha256
                      }
                      label="Evidence bundle hashes to the published and reported sha256"
                    />
                  </>
                ) : (
                  <Check
                    ok={local.bundle === report.evidence.sha256}
                    label="Evidence bundle hashes to the reported sha256 (not published yet: no scanId to compare with)"
                  />
                )}
                <Check
                  ok={local.integrity.ok}
                  label={`Evidence ids, finding references, finding set and recipients recompute (${local.ms} ms)`}
                />
              </div>
              {local.integrity.problems.length > 0 && (
                <ul class="points small">
                  {local.integrity.problems.map((p) => (
                    <li key={p} class="mono">
                      {p}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <div class="row muted" style={{ marginTop: 14 }}>
              <span class="spinner" /> hashing {report.evidence.itemCount} items…
            </div>
          )}
        </div>
      </div>
      <dl class="kv" style={{ marginTop: 16 }}>
        <dt>scanId</dt>
        <dd>
          {scan ? (
            <code class="mono">{scan.scanId}</code>
          ) : (
            <span class="muted">not published yet</span>
          )}
        </dd>
        <dt>Evidence sha256</dt>
        <dd>
          <code class="mono">{report.evidence.sha256}</code>
        </dd>
        <dt>Bundle</dt>
        <dd class="mono">
          {report.evidence.bundleVersion} · {report.evidence.canonicalization} ·{' '}
          {report.evidence.itemCount} items
        </dd>
        <dt>Finding set</dt>
        <dd>
          <Hash value={report.findingSet.sha256} n={24} />{' '}
          <span class="muted small">
            {report.findingSet.count} findings · equal across scans of the same behaviour
          </span>
        </dd>
      </dl>
      <div class="row" style={{ marginTop: 16, flexWrap: 'wrap', gap: 8 }}>
        <button
          class="btn sm"
          type="button"
          onClick={() => download(`${base}.report.json`, JSON.stringify(report, null, 2))}
        >
          report.json
        </button>
        <button
          class="btn sm"
          type="button"
          onClick={() => download(`${base}.evidence.json`, JSON.stringify(evidence, null, 2))}
        >
          evidence.json
        </button>
        <a class="btn sm" href={`#${paths.evidenceOf(data.ref)}`}>
          Explore evidence →
        </a>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------- scan run

export function ScanRunSection({ data }: { data: ReportData }) {
  const { report } = data;
  const s = report.scan;
  return (
    <Section id="run" title="Scan run">
      <div class="grid g-2">
        <dl class="kv panel">
          <dt>Target</dt>
          <dd class="mono">{s.target}</dd>
          <dt>Scanned</dt>
          <dd>{stamp(s.scannedAt)}</dd>
          <dt>Scanner</dt>
          <dd class="mono">igris-scanner {s.scannerVersion}</dd>
          <dt>Report</dt>
          <dd class="mono">
            {report.reportVersion}
            {report.migratedFrom ? ` (migrated from ${report.migratedFrom})` : ''}
          </dd>
          <dt>Status</dt>
          <dd>
            {s.status} · coverage {report.privacy.coverage}
          </dd>
          <dt>Chain</dt>
          <dd class="mono">{s.chainId}</dd>
          <dt>Egress</dt>
          <dd class="mono">{s.egress}</dd>
          <dt>Wallet</dt>
          <dd>
            throwaway <code class="mono">{s.canaryAddress}</code> (never funded)
            {s.spoofMetaMask ? ' · presented as MetaMask' : ''}
          </dd>
        </dl>
        <div class="panel">
          <div class="eyebrow">Detectors</div>
          <div class="signals">
            {report.detectors.map((d) => (
              <code key={d.id}>
                {d.id}@{d.version} · {d.domain}
              </code>
            ))}
          </div>
          <div class="eyebrow" style={{ marginTop: 18 }}>
            Notes
          </div>
          {s.notes.length === 0 ? (
            <p class="muted small">None.</p>
          ) : (
            <ul class="points small">
              {s.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          {s.failure && (
            <p class="small">
              <span class="mono">{s.failure.category}</span>: {s.failure.detail}
            </p>
          )}
        </div>
      </div>
      {s.connectionLog.length > 0 && (
        <details class="disclosure">
          <summary>Connection log · {s.connectionLog.length} lines</summary>
          <pre class="json">{s.connectionLog.join('\n')}</pre>
        </details>
      )}
      <p class="muted small" style={{ marginTop: 14 }}>
        Verdicts come from the scanner’s deterministic rules (the rule id is shown on each third
        party). A browser scan sees only what the page sends; server-side sharing is invisible to
        it.
      </p>
    </Section>
  );
}
