/** Scan history: every scan on this node, newest first. */
import { useEffect, useState } from 'preact/hooks';
import { api, type JobState, type ScanMeta } from '../api.js';
import { go } from '../router.js';
import { Empty, ErrorNote, KIT_NAME, LevelBadge, Loading, ago, stamp } from '../ui.js';

/** Kit name only when identified; a low-confidence guess is not named. */
function kitLabel(kit: { id: string; confidence: string } | null): string {
  if (!kit || (kit.confidence !== 'high' && kit.confidence !== 'medium')) return '';
  const name = KIT_NAME[kit.id] ?? kit.id;
  return ` · ${name}${kit.confidence === 'medium' ? ' (likely)' : ''}`;
}

export function ScanTable({ scans }: { scans: ScanMeta[] }) {
  return (
    <div class="panel flush table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>dApp</th>
            <th>Assessment</th>
            <th class="r">Score</th>
            <th class="r">Findings</th>
            <th class="r">Leaks</th>
            <th>Wallet</th>
            <th class="r">When</th>
          </tr>
        </thead>
        <tbody>
          {scans.map((m) => {
            const s = m.summary;
            return (
              <tr class="link" key={m.id} onClick={() => go(`/scans/${m.id}`)}>
                <td>
                  <a href={`#/scans/${m.id}`} class="mono" style={{ fontSize: '0.84rem' }}>
                    {m.hostname}
                  </a>
                </td>
                <td>
                  {s ? (
                    <LevelBadge level={s.level} />
                  ) : (
                    <StateChip state={m.state} error={m.error} />
                  )}
                </td>
                <td class="r">
                  <span class="display num" style={{ fontSize: '1.5rem' }}>
                    {s ? (s.score ?? '—') : ''}
                  </span>
                </td>
                <td class="r mono num">{s ? s.findings.total : ''}</td>
                <td class="r mono num">
                  {s ? <span class={s.addressLeaks ? '' : 'muted'}>{s.addressLeaks}</span> : ''}
                </td>
                <td class="small dim">
                  {s
                    ? s.walletConnected
                      ? `connected${kitLabel(s.kit)}`
                      : s.score === null
                        ? '—'
                        : 'not connected'
                    : ''}
                </td>
                <td class="r muted small" title={stamp(m.createdAt)}>
                  {ago(m.createdAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StateChip({ state, error }: { state: JobState; error?: string | undefined }) {
  if (state === 'failed')
    return (
      <span class="chip" title={error}>
        failed
      </span>
    );
  return (
    <span class="chip row" style={{ gap: 6 }}>
      <span class="live-dot" style={{ width: 5, height: 5 }} />
      {state}
    </span>
  );
}

export function History() {
  const [scans, setScans] = useState<ScanMeta[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'leaks' | 'failed'>('all');

  useEffect(() => {
    let live = true;
    const load = () =>
      api.list().then(
        (s) => live && setScans(s),
        (e) => live && setError(e),
      );
    void load();
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
  if (!scans) return <Loading label="Loading history" />;

  const needle = q.trim().toLowerCase();
  const shown = scans
    .filter((m) => !needle || m.url.toLowerCase().includes(needle))
    .filter((m) =>
      filter === 'leaks'
        ? (m.summary?.addressLeaks ?? 0) > 0
        : filter === 'failed'
          ? m.state === 'failed' || m.summary?.score === null
          : true,
    );

  return (
    <div class="page" style={{ paddingTop: 56 }}>
      <div class="spread rise" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <div class="eyebrow">Scan history</div>
          <h1 class="h1" style={{ marginTop: 12 }}>
            {scans.length} scan{scans.length === 1 ? '' : 's'}
          </h1>
        </div>
        <div class="row" style={{ flexWrap: 'wrap' }}>
          <div class="segmented compact">
            {(
              [
                ['all', 'All'],
                ['leaks', 'Address leaks'],
                ['failed', 'Not scored / failed'],
              ] as const
            ).map(([k, l]) => (
              <button key={k} class={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
                <b>{l}</b>
              </button>
            ))}
          </div>
          <input
            class="input"
            style={{ width: 220 }}
            placeholder="Filter by URL"
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            aria-label="Filter scans by URL"
          />
        </div>
      </div>
      <div class="rise d1" style={{ marginTop: 28 }}>
        {scans.length === 0 ? (
          <Empty title="No scans yet">
            <a class="btn primary" href="#/scan" style={{ marginTop: 8 }}>
              Scan a dApp
            </a>
          </Empty>
        ) : shown.length === 0 ? (
          <p class="muted">No scans match.</p>
        ) : (
          <ScanTable scans={shown} />
        )}
      </div>
    </div>
  );
}
