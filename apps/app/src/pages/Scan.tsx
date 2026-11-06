/**
 * One scan: live progress while it runs, the report once it completes.
 * Progress is exactly what the scanner emitted (SSE replay + live); there is
 * no percentage and nothing is interpolated.
 */
import { useEffect, useState } from 'preact/hooks';
import {
  SCAN_STAGES,
  api,
  type JobState,
  type ReportResponse,
  type ScanMeta,
  type ScanProgressEvent,
  type ScanStage,
} from '../api.js';
import { ErrorNote, Loading, duration, stamp } from '../ui.js';
import { ScanForm } from '../ScanForm.js';
import { Report } from './Report.js';

export function ScanPage({ id }: { id: string }) {
  const [meta, setMeta] = useState<ScanMeta | null>(null);
  const [report, setReport] = useState<Omit<ReportResponse, 'scan'> | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = async () => {
    try {
      const m = await api.get(id);
      setMeta(m);
      if (m.state === 'completed') setReport(await api.report(id));
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    void load();
  }, [id]);

  if (error)
    return (
      <div class="page" style={{ paddingTop: 64 }}>
        <ErrorNote error={error} />
      </div>
    );
  if (!meta) return <Loading label="Loading scan" />;
  if (meta.state === 'completed') {
    if (!report) return <Loading label="Verifying report and evidence" />;
    return <Report scan={meta} data={report} />;
  }
  return <LiveScan meta={meta} onDone={() => void load()} />;
}

// ---------------------------------------------------------------------------

const STAGE_LABEL: Record<ScanStage, [string, string]> = {
  browser: ['Isolated browser', 'Fresh Chromium profile, canary wallet injected'],
  navigation: ['Load the dApp', 'Navigate and classify the page load'],
  'observe-pre-connect': ['Observe before connecting', 'Every request a visitor triggers'],
  wallet: ['Connect canary wallet', 'Find the connect control and approve'],
  'observe-post-connect': ['Observe after connecting', 'Where the address travels next'],
  detection: ['Run detectors', 'Canary leaks, third parties, headers'],
  evidence: ['Seal evidence', 'Content-addressed evidence bundle'],
  report: ['Score and report', 'Deterministic scoring rules'],
};

type StageState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

function stageView(events: ScanProgressEvent[], stage: ScanStage) {
  const mine = events.filter((e) => e.stage === stage);
  const last = mine.at(-1);
  let state: StageState = 'pending';
  if (last)
    state =
      last.status === 'completed'
        ? 'done'
        : last.status === 'failed'
          ? 'failed'
          : last.status === 'skipped'
            ? 'skipped'
            : 'running';
  const started = mine.find((e) => e.status === 'started');
  const ended = mine.find((e) => e.status === 'completed' || e.status === 'failed');
  const detail = [...mine].reverse().find((e) => e.detail)?.detail;
  const ms =
    started && ended ? new Date(ended.at).getTime() - new Date(started.at).getTime() : undefined;
  return { state, detail, ms, started };
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function LiveScan({ meta, onDone }: { meta: ScanMeta; onDone: () => void }) {
  const [events, setEvents] = useState<ScanProgressEvent[]>(meta.events);
  const [state, setState] = useState<JobState>(meta.state);
  const [error, setError] = useState<string | null>(meta.error ?? null);
  const [connected, setConnected] = useState(false);
  const finished = state === 'failed' || state === 'completed';

  useEffect(() => {
    if (meta.state === 'failed' || meta.state === 'completed') return;
    const es = new EventSource(`/api/scans/${meta.id}/events`);
    es.onopen = () => {
      // The server replays every event on (re)connect: start from scratch.
      setEvents([]);
      setConnected(true);
    };
    es.onerror = () => setConnected(false);
    es.addEventListener('state', (e) => setState(JSON.parse((e as MessageEvent).data).state));
    es.addEventListener('progress', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as ScanProgressEvent;
      setEvents((xs) => [...xs, ev]);
    });
    es.addEventListener('done', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { state: JobState; error: string | null };
      es.close();
      setConnected(false);
      setState(d.state);
      setError(d.error);
      // Let the final stage settle on screen, then load the verified report.
      setTimeout(onDone, d.state === 'completed' ? 900 : 0);
    });
    return () => es.close();
  }, [meta.id]);

  const now = useNow(!finished);
  const t0 = meta.startedAt ?? events[0]?.at;
  const elapsed = t0
    ? (finished && meta.finishedAt ? new Date(meta.finishedAt) : new Date(now)).getTime() -
      new Date(t0).getTime()
    : 0;
  const counters = [...events].reverse().find((e) => e.counters)?.counters;
  const firstAt = events[0] ? new Date(events[0].at).getTime() : 0;

  return (
    <div class="page" style={{ paddingTop: 56 }}>
      <div class="spread rise" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <div class="eyebrow row" style={{ gap: 10 }}>
            <span class={`live-dot ${finished ? 'off' : ''}`} />
            {state === 'queued'
              ? 'Queued — waiting for a scanner slot'
              : state === 'running'
                ? 'Scanning'
                : state === 'failed'
                  ? 'Scan failed'
                  : 'Scan complete'}
          </div>
          <h1 class="h1" style={{ marginTop: 12 }}>
            {meta.hostname}
          </h1>
          <div class="mono muted" style={{ marginTop: 6 }}>
            {meta.url}
          </div>
        </div>
        <div class="live-clock">
          <div class="display num">{t0 ? duration(Math.max(0, elapsed)) : '—'}</div>
          <div class="eyebrow">elapsed · started {stamp(meta.createdAt)}</div>
        </div>
      </div>

      {state === 'failed' && (
        <div class="panel failure rise" style={{ marginTop: 32 }}>
          <div class="eyebrow">What happened</div>
          <p style={{ margin: '10px 0 18px' }}>{error ?? 'The scan did not finish.'}</p>
          <ScanForm initial={meta.url} />
        </div>
      )}

      <div class="live-grid">
        <ol class="stages rise d1">
          {SCAN_STAGES.map((s, i) => {
            const v = stageView(events, s);
            return (
              <li class={`stage ${v.state}`} key={s}>
                <div class="stage-mark">
                  {v.state === 'running' ? (
                    <span class="spinner" />
                  ) : v.state === 'done' ? (
                    '✓'
                  ) : v.state === 'failed' ? (
                    '×'
                  ) : v.state === 'skipped' ? (
                    '–'
                  ) : (
                    <span class="mono">{String(i + 1).padStart(2, '0')}</span>
                  )}
                </div>
                <div class="stage-body">
                  <div class="spread">
                    <span class="stage-title">{STAGE_LABEL[s][0]}</span>
                    <span class="mono muted stage-ms">
                      {v.ms !== undefined ? duration(v.ms) : v.state === 'skipped' ? 'skipped' : ''}
                    </span>
                  </div>
                  <div class="stage-detail">{v.detail ?? STAGE_LABEL[s][1]}</div>
                </div>
              </li>
            );
          })}
        </ol>

        <div class="stack rise d2" style={{ '--gap': '16px' }}>
          <div class="panel">
            <div class="panel-head">
              <h2 class="h2">Observed so far</h2>
              <span class="muted" style={{ fontSize: '0.76rem' }}>
                from the scanner, live
              </span>
            </div>
            <div class="grid g-3 counters">
              <div>
                <div class="display num counter">{counters?.requests ?? '—'}</div>
                <div class="eyebrow">requests</div>
              </div>
              <div>
                <div class="display num counter">{counters?.hosts ?? '—'}</div>
                <div class="eyebrow">hosts</div>
              </div>
              <div>
                <div class="display num counter">{counters?.wsConnections ?? '—'}</div>
                <div class="eyebrow">websockets</div>
              </div>
            </div>
          </div>
          <div class="panel flush">
            <div class="panel-head" style={{ padding: '16px 18px 0' }}>
              <h2 class="h2">Scanner log</h2>
              <span class="row muted" style={{ fontSize: '0.76rem', gap: 6 }}>
                <span class={`live-dot ${connected ? '' : 'off'}`} />
                {connected ? 'streaming' : finished ? 'closed' : 'connecting'}
              </span>
            </div>
            <div class="log" role="log" aria-live="polite">
              {events.length === 0 && <div class="muted">Waiting for the first event…</div>}
              {events.map((e, i) => (
                <div class="log-line" key={i}>
                  <span class="muted">
                    +{((new Date(e.at).getTime() - firstAt) / 1000).toFixed(1).padStart(5, ' ')}s
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
        </div>
      </div>
    </div>
  );
}
