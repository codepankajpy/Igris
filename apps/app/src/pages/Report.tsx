/**
 * The scan report. Every number, verdict and sentence here comes from the
 * backend (report, evidence bundle, assess()). The only computation done in
 * the browser is an independent integrity re-check of the data it received.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  verifyReportIntegrity,
  type ContactClassificationEvidence,
  type FindingV2,
  type IntegrityResult,
} from '@igris/core/contracts';
import { api, type ReportResponse, type ScanMeta } from '../api.js';
import { go } from '../router.js';
import {
  Hash,
  Kpi,
  LevelBadge,
  ScoreDial,
  Section,
  Sev,
  SeverityBar,
  SEVERITY_ORDER,
  download,
  duration,
  kitWording,
  stamp,
} from '../ui.js';

type Data = Omit<ReportResponse, 'scan'>;

const sevRank = (s: string) => SEVERITY_ORDER.indexOf(s as never);
const byImportance = (a: FindingV2, b: FindingV2) =>
  sevRank(a.severity) - sevRank(b.severity) ||
  Number(b.countsTowardPrivacyScore) - Number(a.countsTowardPrivacyScore) ||
  a.title.localeCompare(b.title);

const RECIPIENT_LABEL: Record<string, string> = {
  'first-party': 'First party',
  'rpc-provider': 'RPC provider',
  analytics: 'Analytics',
  'error-monitoring': 'Error monitoring',
  'support-chat': 'Support chat',
  'walletconnect-relay': 'WalletConnect relay',
  'ipfs-gateway': 'IPFS gateway',
  cdn: 'CDN',
  'anon-rpc': 'Anon-RPC',
  'unknown-third-party': 'Unidentified',
};

export function Report({ scan, data }: { scan: ScanMeta; data: Data }) {
  const { report, evidence, assessment, verification } = data;
  // A page that never loaded has nothing to explore: no empty sections.
  const observed = report.privacy.coverage !== 'none';
  const [rescanning, setRescanning] = useState(false);

  const severity = useMemo(() => {
    const c = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of report.privacy.findings) c[f.severity] += 1;
    return c;
  }, [report]);

  async function rescan() {
    setRescanning(true);
    try {
      const { id } = await api.submit(report.scan.target);
      go(`/scans/${id}`);
    } catch {
      setRescanning(false);
    }
  }

  return (
    <div class="page">
      <div class="report-top rise">
        <div class="crumbs mono muted">
          <a href="#/history">Scans</a> / {scan.hostname}
        </div>
        <div class="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {report.evidence.itemCount > 0 && (
            <a class="btn sm" href={`#/scans/${scan.id}/evidence`}>
              Evidence explorer
            </a>
          )}
          <button
            class="btn sm"
            onClick={() =>
              download(`igris-${scan.hostname}-report.json`, JSON.stringify(report, null, 2))
            }
          >
            report.json
          </button>
          <button
            class="btn sm"
            onClick={() =>
              download(`igris-${scan.hostname}-evidence.json`, JSON.stringify(evidence, null, 2))
            }
          >
            evidence.json
          </button>
          <button class="btn sm primary" disabled={rescanning} onClick={rescan}>
            {rescanning ? 'Starting…' : 'Scan again'}
          </button>
        </div>
      </div>

      {/* ---------------------------------------------------------------- hero */}
      <section class={`report-hero panel rise d1 lvl-${assessment.level}`}>
        <div class="report-hero-light" aria-hidden="true" />
        <ScoreDial score={report.privacy.score} level={assessment.level} />
        <div class="report-hero-text">
          <div class="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <LevelBadge level={assessment.level} />
            <span class="chip">coverage: {report.privacy.coverage}</span>
          </div>
          <h1 class="display report-headline">{assessment.headline}</h1>
          <div class="mono muted" style={{ fontSize: '0.8rem' }}>
            {report.scan.target} · scanned {stamp(report.scan.scannedAt)}
          </div>
        </div>
      </section>

      <div class="grid g-2 rise d2" style={{ marginTop: 16 }}>
        <div class="panel">
          <div class="eyebrow">Executive summary</div>
          <ul class="points">
            {assessment.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
        <div class="panel">
          <div class="eyebrow">Read this before relying on the score</div>
          <ul class="points caveats">
            {assessment.caveats.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {observed && (
            <>
              <div class="hairline" style={{ margin: '16px 0' }} />
              <div class="eyebrow" style={{ marginBottom: 10 }}>
                Privacy findings by severity
              </div>
              <SeverityBar counts={severity} />
              <div class="row sev-legend">
                {SEVERITY_ORDER.filter((s) => severity[s]).map((s) => (
                  <span key={s} class="row" style={{ gap: 6 }}>
                    <Sev s={s} />
                    <span class="num">{severity[s]}</span>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {observed && (
        <>
          <nav class="report-nav rise d3" aria-label="Report sections">
            {[
              ['findings', 'Findings'],
              ['wallet', 'Wallet'],
              ['third-parties', 'Third parties'],
              ['network', 'Network'],
              ['security', 'Security'],
              ['integrity', 'Integrity'],
              ['run', 'Scan run'],
            ].map(([id, label]) => (
              <a
                key={id}
                href={`#/scans/${scan.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  document
                    .getElementById(id!)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                {label}
              </a>
            ))}
          </nav>

          <Findings data={data} scanId={scan.id} />
          <Wallet data={data} />
          <ThirdParties data={data} />

          {/* ------------------------------------------------------------ network */}
          <Section
            id="network"
            title="Network observations"
            aside="What the isolated browser recorded during the scan"
          >
            {report.telemetry ? (
              <div class="grid g-4">
                <Kpi
                  k={report.telemetry.totalRequests}
                  l="requests"
                  s={`${report.telemetry.preConnectRequests} before connecting · ${report.telemetry.postConnectRequests} after`}
                />
                <Kpi
                  k={new Set(report.contacts.map((c) => c.registrableDomain)).size}
                  l="third-party domains"
                  s={`${report.contacts.length} distinct hosts`}
                />
                <Kpi
                  k={report.telemetry.wsConnections ?? '—'}
                  l="websockets"
                  s={
                    report.telemetry.wsFrames === null
                      ? 'frames not recorded'
                      : `${report.telemetry.wsFrames} frames`
                  }
                />
                <Kpi
                  k={report.telemetry.cookiesCount}
                  l="cookies set"
                  s={`${report.telemetry.localStorageCount} localStorage · ${report.telemetry.sessionStorageCount} sessionStorage keys`}
                />
              </div>
            ) : (
              <p class="muted">This report carries no telemetry.</p>
            )}
          </Section>

          {/* ----------------------------------------------------------- security */}
          <Section
            id="security"
            title="Security observations"
            aside="Main-document headers · reported separately, never part of the privacy score"
          >
            {report.security.observations.length === 0 ? (
              <p class="muted">No security observations were made.</p>
            ) : (
              <div class="panel flush">
                {groupFindings([...report.security.observations].sort(byImportance)).map((g) => (
                  <FindingRow key={g[0]!.id} group={g} scanId={scan.id} />
                ))}
              </div>
            )}
          </Section>
        </>
      )}

      <Integrity data={data} serverVerified={verification} />

      {/* ---------------------------------------------------------- run log */}
      <Section id="run" title="Scan run" aside="The scanner's own progress events for this scan">
        <div class="panel flush">
          <div class="log" style={{ maxHeight: 360 }}>
            {scan.events.map((e, i) => (
              <div class="log-line" key={i}>
                <span class="muted">
                  +
                  {((new Date(e.at).getTime() - new Date(scan.events[0]!.at).getTime()) / 1000)
                    .toFixed(1)
                    .padStart(5, ' ')}
                  s
                </span>
                <span class={`log-status ${e.status}`}>{e.status}</span>
                <span class="log-detail">
                  <span class="dim">{e.stage}</span>{' '}
                  {e.detail ??
                    (e.counters
                      ? `${e.counters.requests} requests · ${e.counters.hosts} hosts · ${e.counters.wsConnections} ws`
                      : '')}
                </span>
              </div>
            ))}
          </div>
        </div>
        <dl class="kv" style={{ marginTop: 16 }}>
          <dt>Scanner</dt>
          <dd class="mono">
            igris-scanner {report.scan.scannerVersion} · report {report.reportVersion}
          </dd>
          <dt>Detectors</dt>
          <dd class="mono">{report.detectors.map((d) => `${d.id}@${d.version}`).join(' · ')}</dd>
          <dt>Egress policy</dt>
          <dd class="mono">{report.scan.egress}</dd>
          <dt>Chain</dt>
          <dd class="mono">{report.scan.chainId}</dd>
          <dt>Canary address</dt>
          <dd class="mono">
            {report.scan.canaryAddress.slice(0, 8)}…{report.scan.canaryAddress.slice(-6)}{' '}
            <span class="muted">(throwaway, generated for this scan)</span>
          </dd>
          {scan.startedAt && scan.finishedAt && (
            <>
              <dt>Duration</dt>
              <dd class="mono">
                {duration(new Date(scan.finishedAt).getTime() - new Date(scan.startedAt).getTime())}
              </dd>
            </>
          )}
          {report.scan.notes.length > 0 && (
            <>
              <dt>Notes</dt>
              <dd>
                {report.scan.notes.map((n) => (
                  <div key={n}>{n}</div>
                ))}
              </dd>
            </>
          )}
        </dl>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Findings with the same title, severity and kind shown as one row (display grouping only). */
function groupFindings(fs: FindingV2[]): FindingV2[][] {
  const m = new Map<string, FindingV2[]>();
  for (const f of fs) {
    const k = `${f.severity}|${f.kind}|${f.title}`;
    m.set(k, [...(m.get(k) ?? []), f]);
  }
  return [...m.values()];
}

function FindingRow({
  group,
  scanId,
  points,
  open: initiallyOpen = false,
}: {
  group: FindingV2[];
  scanId: string;
  points?: number;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const f = group[0]!;
  return (
    <div class={`finding ${open ? 'open' : ''} sev-${f.severity}`}>
      <button class="finding-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Sev s={f.severity} />
        <span class="finding-title">
          {f.title}
          {group.length > 1 && <span class="mono muted"> ×{group.length}</span>}
        </span>
        <span class="finding-meta">
          <span class="chip">{f.kind}</span>
          {points !== undefined && points > 0 && <span class="chip solid num">−{points}</span>}
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
              <span class="mono muted">{g.countsTowardPrivacyScore ? 'scored' : 'not scored'}</span>
              <span style={{ marginLeft: 'auto', flexWrap: 'wrap' }} class="row">
                {g.evidence.map((ref) => (
                  <a
                    key={ref.id}
                    class="chip evidence-link"
                    href={`#/scans/${scanId}/evidence/${ref.id}`}
                  >
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

function Findings({ data, scanId }: { data: Data; scanId: string }) {
  const { report } = data;
  const [kind, setKind] = useState<'all' | 'issue' | 'risk' | 'observation'>('all');
  // Points shown on a row only when whole ledger lines belong to that row's
  // findings; lines spanning several rows stay in the ledger table only.
  const pointsFor = (group: FindingV2[]) => {
    const ids = new Set(group.map((f) => f.id));
    const lines = report.privacy.ledger.filter(
      (l) => l.findingIds.length > 0 && l.findingIds.every((id) => ids.has(id)),
    );
    return Math.round(lines.reduce((a, l) => a + l.points, 0) * 10) / 10;
  };
  const groups = groupFindings(
    [...report.privacy.findings]
      .filter((f) => kind === 'all' || f.kind === kind)
      .sort(byImportance),
  );
  const counts = {
    all: report.privacy.findings.length,
    issue: report.privacy.findings.filter((f) => f.kind === 'issue').length,
    risk: report.privacy.findings.filter((f) => f.kind === 'risk').length,
    observation: report.privacy.findings.filter((f) => f.kind === 'observation').length,
  };
  const totalPenalty = report.privacy.ledger.reduce((a, l) => a + l.points, 0);

  return (
    <Section
      id="findings"
      title="Privacy findings"
      aside={
        report.privacy.score === null
          ? 'Not scored'
          : `100 − ${Math.round(totalPenalty * 10) / 10} points of deductions → ${report.privacy.score}`
      }
    >
      <div class="segmented compact" role="tablist" style={{ marginBottom: 14 }}>
        {(['all', 'issue', 'risk', 'observation'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            class={kind === k ? 'on' : ''}
            onClick={() => setKind(k)}
          >
            <b>{k === 'all' ? 'All' : k[0]!.toUpperCase() + k.slice(1) + 's'}</b>
            <span class="num">{counts[k]}</span>
          </button>
        ))}
      </div>
      {groups.length === 0 ? (
        <p class="muted">No findings of this kind.</p>
      ) : (
        <div class="panel flush">
          {groups.map((g, i) => (
            <FindingRow
              key={g[0]!.id}
              group={g}
              scanId={scanId}
              points={pointsFor(g)}
              open={i === 0 && (g[0]!.severity === 'critical' || g[0]!.severity === 'high')}
            />
          ))}
        </div>
      )}
      {report.privacy.ledger.length > 0 && (
        <details class="ledger">
          <summary>Score ledger · {report.privacy.ledger.length} deductions</summary>
          <table class="table">
            <thead>
              <tr>
                <th>Deduction</th>
                <th>Rule</th>
                <th class="r">Points</th>
              </tr>
            </thead>
            <tbody>
              {report.privacy.ledger.map((l) => (
                <tr key={l.id}>
                  <td>{l.label}</td>
                  <td class="mono muted">{l.rule}</td>
                  <td class="r mono num">−{l.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </Section>
  );
}

function Wallet({ data }: { data: Data }) {
  const { report } = data;
  const conn = report.scan.connection;
  const kit = conn?.kit;
  return (
    <Section id="wallet" title="Wallet integration" aside="How the canary wallet was connected">
      <div class="grid g-3">
        <div class="panel">
          <div class="eyebrow">Connection</div>
          <div class="wallet-big">
            {report.scan.status === 'completed'
              ? 'Connected'
              : report.scan.status === 'wallet-connect-failed'
                ? 'Not connected'
                : 'Page did not load'}
          </div>
          <div class="muted small">
            {conn
              ? `${conn.requestAccountsCalls} eth_requestAccounts call${conn.requestAccountsCalls === 1 ? '' : 's'} received`
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
          <div class="wallet-big">
            {kit && kit.id !== 'none'
              ? kitWording(kit.id, kit.confidence)
              : 'No known kit identified'}
          </div>
          <div class="muted small">
            {conn
              ? `strategy: ${conn.strategy}${conn.recipe ? ` · recipe ${conn.recipe}` : ''}`
              : '—'}
          </div>
          {kit && kit.signals.length > 0 && (
            <div class="signals">
              {kit.signals.map((s) => (
                <code key={s}>{s}</code>
              ))}
            </div>
          )}
        </div>
        <div class="panel">
          <div class="eyebrow">RPC</div>
          <div class="wallet-big">
            {report.wallet.usesAnonRpc ? 'Anon-RPC in use' : 'Anon-RPC not detected'}
          </div>
          <div class="muted small">Reads the dApp sent through the wallet:</div>
          {report.wallet.readsViaWallet.length === 0 ? (
            <div class="small muted" style={{ marginTop: 8 }}>
              none
            </div>
          ) : (
            <div class="signals">
              {report.wallet.readsViaWallet.map((r) => (
                <code key={r.method}>
                  {r.method} ×{r.count}
                </code>
              ))}
            </div>
          )}
        </div>
      </div>
      {conn && conn.steps.length > 0 && (
        <div class="panel flush" style={{ marginTop: 16 }}>
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
                    <span class={`chip ${s.result === 'failed' ? 'signal' : ''}`}>{s.result}</span>
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

function ThirdParties({ data }: { data: Data }) {
  const { report, evidence } = data;
  const [filter, setFilter] = useState<'all' | 'pre' | 'leak'>('all');
  const classByHost = useMemo(() => {
    const m = new Map<string, ContactClassificationEvidence>();
    for (const i of Object.values(evidence.items))
      if (i.type === 'contact-classification') m.set(i.host, i);
    return m;
  }, [evidence]);
  const leakHosts = useMemo(() => {
    const s = new Set<string>();
    for (const i of Object.values(evidence.items)) if (i.type === 'canary-match') s.add(i.host);
    return s;
  }, [evidence]);
  const rows = [...report.contacts]
    .filter((c) =>
      filter === 'pre'
        ? c.phases.includes('pre-connect')
        : filter === 'leak'
          ? leakHosts.has(c.host)
          : true,
    )
    .sort(
      (a, b) =>
        Number(leakHosts.has(b.host)) - Number(leakHosts.has(a.host)) ||
        b.requestCount - a.requestCount ||
        a.host.localeCompare(b.host),
    );
  const maxReq = Math.max(1, ...report.contacts.map((c) => c.requestCount));

  return (
    <Section
      id="third-parties"
      title="Third-party domains"
      aside={`${report.contacts.length} hosts across ${new Set(report.contacts.map((c) => c.registrableDomain)).size} domains`}
    >
      <div class="segmented compact" role="tablist" style={{ marginBottom: 14 }}>
        {(
          [
            ['all', 'All hosts'],
            ['pre', 'Before connecting'],
            ['leak', 'Received the address'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            role="tab"
            aria-selected={filter === k}
            class={filter === k ? 'on' : ''}
            onClick={() => setFilter(k)}
          >
            <b>{l}</b>
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p class="muted">No hosts match.</p>
      ) : (
        <div class="panel flush table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Host</th>
                <th>Class</th>
                <th>Relationship</th>
                <th>Phases</th>
                <th class="r">Requests</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const cls = classByHost.get(c.host);
                const leak = leakHosts.has(c.host);
                return (
                  <tr key={c.host}>
                    <td>
                      <div class="mono" style={{ fontSize: '0.82rem' }}>
                        {c.host}
                      </div>
                      {leak && (
                        <span class="chip signal" style={{ marginTop: 6 }}>
                          received the wallet address
                        </span>
                      )}
                    </td>
                    <td class="dim">{RECIPIENT_LABEL[c.class] ?? c.class}</td>
                    <td>
                      {cls ? (
                        <span title={`${cls.rule}: ${cls.basis.map((b) => b.detail).join('; ')}`}>
                          {cls.relationship}
                          <span class="muted small"> · {cls.confidence}</span>
                        </span>
                      ) : (
                        <span class="muted">—</span>
                      )}
                    </td>
                    <td class="mono muted small">{c.phases.join(' + ')}</td>
                    <td class="r">
                      <div class="row" style={{ justifyContent: 'flex-end', gap: 10 }}>
                        <div class="bar" style={{ width: 64 }}>
                          <span style={{ width: `${(c.requestCount / maxReq) * 100}%` }} />
                        </div>
                        <span class="mono num" style={{ minWidth: 28 }}>
                          {c.requestCount}
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Integrity({ data, serverVerified }: { data: Data; serverVerified: Data['verification'] }) {
  const { report, evidence } = data;
  const [local, setLocal] = useState<IntegrityResult | null>(null);
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      const t0 = performance.now();
      setLocal(verifyReportIntegrity(report, evidence));
      setMs(Math.round(performance.now() - t0));
    }, 50);
    return () => clearTimeout(t);
  }, [report, evidence]);

  return (
    <Section id="integrity" title="Integrity" aside="Can this report be trusted as delivered?">
      <div class="grid g-2">
        <div class="panel">
          <div class="eyebrow">Scanner node</div>
          <div class="check-list">
            <Check
              ok={serverVerified.schema}
              label="Report and evidence match their published schemas"
            />
            <Check
              ok={serverVerified.integrity}
              label="Evidence bundle hash and references re-verified on load"
            />
          </div>
        </div>
        <div class="panel">
          <div class="eyebrow">Recomputed in this browser</div>
          {local ? (
            <>
              <div class="check-list">
                <Check
                  ok={local.bundleSha256 === report.evidence.sha256}
                  label={`Evidence bundle hashes to the value in the report (${ms} ms)`}
                />
                <Check
                  ok={!local.problems.some((p) => p.includes('content id'))}
                  label={`All ${report.evidence.itemCount} evidence items match their content ids`}
                />
                <Check
                  ok={!local.problems.some((p) => p.includes('findingSet'))}
                  label="Finding-set digest matches the findings"
                />
                <Check
                  ok={!local.problems.some((p) => p.includes('references'))}
                  label="Every finding resolves to evidence of the stated type"
                />
              </div>
              {local.problems.length > 0 && (
                <ul class="points small">
                  {local.problems.map((p) => (
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
            {report.findingSet.count} findings · stable across scans of the same behaviour, unlike
            the evidence hash
          </span>
        </dd>
      </dl>
    </Section>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div class={`check ${ok ? 'ok' : 'bad'}`}>
      <span class="check-mark">{ok ? '✓' : '×'}</span>
      {label}
    </div>
  );
}
