/** Dashboard: aggregates of the scans on this node (GET /api/stats). Nothing else. */
import { useEffect, useState } from 'preact/hooks';
import { api, type ScanMeta, type Stats } from '../api.js';
import { ScanTable } from './History.js';
import {
  Empty,
  ErrorNote,
  KIT_NAME,
  Kpi,
  Loading,
  Section,
  Sev,
  SeverityBar,
  SEVERITY_ORDER,
} from '../ui.js';

export function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [scans, setScans] = useState<ScanMeta[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all([api.stats(), api.list()]).then(([s, l]) => {
        if (!live) return;
        setStats(s);
        setScans(l);
      }, setError);
    void load();
    // Refresh while scans are in flight so counts stay true.
    const t = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (error)
    return (
      <div class="page" style={{ paddingTop: 64 }}>
        <ErrorNote error={error} />
      </div>
    );
  if (!stats || !scans) return <Loading label="Loading dashboard" />;

  const t = stats.totals;
  return (
    <div class="page" style={{ paddingTop: 56 }}>
      <div class="spread rise" style={{ alignItems: 'flex-end' }}>
        <div>
          <div class="eyebrow">Dashboard · this scanner node · {stats.basis}</div>
          <h1 class="h1" style={{ marginTop: 12 }}>
            What your scans have found
          </h1>
        </div>
        <a class="btn primary" href="#/scan">
          New scan
        </a>
      </div>

      {t.scans === 0 ? (
        <div style={{ marginTop: 40 }}>
          <Empty title="No scans yet">
            <p>Every number on this page is computed from scans you run. Start with one dApp.</p>
            <a class="btn primary" href="#/scan" style={{ marginTop: 12 }}>
              Scan a dApp
            </a>
          </Empty>
        </div>
      ) : (
        <>
          <div class="grid g-4 rise d1" style={{ marginTop: 32 }}>
            <Kpi
              k={t.dapps}
              l="dApps scanned"
              s={`${t.scans} scans: ${t.completed} completed · ${t.failed} failed${t.inProgress ? ` · ${t.inProgress} running` : ''}`}
            />
            <Kpi
              k={stats.averageScore ?? '—'}
              l="average privacy score"
              s={`over ${t.scored} scored dApp${t.scored === 1 ? '' : 's'}${t.notScored ? ` · ${t.notScored} not scored` : ''}`}
            />
            <Kpi
              k={stats.addressLeaks}
              l="wallet-address leaks"
              s={`to ${stats.topLeakDomains.length} distinct domain${stats.topLeakDomains.length === 1 ? '' : 's'}`}
            />
            <Kpi
              k={SEVERITY_ORDER.reduce((a, s) => a + stats.severity[s], 0)}
              l="findings"
              s={`${stats.severity.critical + stats.severity.high} critical or high`}
            />
          </div>

          <div class="grid g-2 rise d2" style={{ marginTop: 16 }}>
            <div class="panel">
              <div class="panel-head">
                <h2 class="h2">Findings by severity</h2>
              </div>
              <SeverityBar counts={stats.severity} />
              <div class="sev-table">
                {SEVERITY_ORDER.map((s) => (
                  <div class="spread" key={s}>
                    <Sev s={s} />
                    <span class="mono num">{stats.severity[s]}</span>
                  </div>
                ))}
              </div>
            </div>
            <div class="panel">
              <div class="panel-head">
                <h2 class="h2">Wallet kits</h2>
                <span class="muted small">dApps, by identification confidence</span>
              </div>
              {stats.kits.length === 0 ? (
                <p class="muted small">No wallet kit detected yet.</p>
              ) : (
                <table class="table compact-table">
                  <thead>
                    <tr>
                      <th>Kit</th>
                      <th class="r" title="Kit modal observed">
                        Identified
                      </th>
                      <th class="r">Likely</th>
                      <th class="r" title="Weak signals only, e.g. a kit's network host">
                        Unconfirmed
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.kits.map((k) => (
                      <tr key={k.id}>
                        <td>{KIT_NAME[k.id] ?? k.id}</td>
                        <td class="r mono num">{k.high || <span class="muted">0</span>}</td>
                        <td class="r mono num">{k.medium || <span class="muted">0</span>}</td>
                        <td class="r mono num muted">{k.low}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div class="grid g-2 rise d3" style={{ marginTop: 16 }}>
            <div class="panel">
              <div class="panel-head">
                <h2 class="h2">Where wallet addresses went</h2>
                <span class="muted small">domains, by number of dApps</span>
              </div>
              {stats.topLeakDomains.length === 0 ? (
                <p class="muted small">No wallet-address leak observed in any scan.</p>
              ) : (
                <Bars rows={stats.topLeakDomains} total={t.dapps} />
              )}
            </div>
            <div class="panel">
              <div class="panel-head">
                <h2 class="h2">Most common third parties</h2>
                <span class="muted small">domains, by number of dApps</span>
              </div>
              {stats.topThirdParties.length === 0 ? (
                <p class="muted small">None recorded.</p>
              ) : (
                <Bars rows={stats.topThirdParties} total={t.dapps} />
              )}
            </div>
          </div>

          <Section title="Recent scans" aside={<a href="#/history">All scans →</a>}>
            <ScanTable scans={scans.slice(0, 6)} />
          </Section>
        </>
      )}
    </div>
  );
}

function Bars({
  rows,
  total,
  signal,
}: {
  rows: Array<{ domain: string; scans: number }>;
  total: number;
  signal?: boolean;
}) {
  return (
    <div class="bars">
      {rows.map((r) => (
        <div class="bars-row" key={r.domain}>
          <span class="mono bars-label">{r.domain}</span>
          <div class={`bar ${signal ? 'signal' : ''}`}>
            <span style={{ width: `${(r.scans / Math.max(1, total)) * 100}%` }} />
          </div>
          <span class="mono num muted bars-n">
            {r.scans}/{total}
          </span>
        </div>
      ))}
    </div>
  );
}
