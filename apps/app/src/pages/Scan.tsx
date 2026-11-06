/**
 * A scan job, live. Progress is exactly what the scanner emitted (SSE replay
 * + live): no percentage, nothing interpolated. When it completes and is
 * published, the site's new version opens; when publishing failed (or has not
 * finished), the reason is shown with a retry and the report can be viewed
 * from the server's cache; when the scan failed, the reason and a retry.
 * A scan started from this tab also shows the open request it answers (the
 * igris.request.v1 entity), which other scanner nodes may fulfil too.
 */
import { ExplorerLink } from '../explorer.js';
import { useEffect, useState } from 'preact/hooks';
import {
  SCAN_STAGES,
  api,
  requestFor,
  startScan,
  type Job,
  type JobState,
  type NodeInfo,
  type ScanRequest,
  type PublishStatus,
  type ScanProgressEvent,
  type ScanStage,
} from '../api.js';
import { go, paths } from '../router.js';
import { ErrorNote, Loading, duration, short, stamp } from '../ui.js';
import { elapsedMs } from '../wording.js';
import { nodeLabel } from '../rounds.js';

export function ScanPage({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.job(id).then((j) => {
      // Opened after the fact and already published: go straight to the report.
      if (j.state === 'completed' && j.version !== null && j.publish?.ok)
        go(paths.version(j.hostname, j.version), true);
      else setJob(j);
    }, setError);
  }, [id]);

  if (error)
    return (
      <div class="page" style={{ paddingTop: 56 }}>
        <ErrorNote error={error} />
        <p class="muted" style={{ marginTop: 16 }}>
          <a class="link" href="#/">
            Search for a site →
          </a>
        </p>
      </div>
    );
  if (!job) return <Loading label="Loading scan" />;
  return <LiveScan job={job} />;
}

// ---------------------------------------------------------------------------

const STAGE_LABEL: Record<ScanStage, [string, string]> = {
  browser: ['Isolated browser', 'Fresh Chromium profile, throwaway wallet injected'],
  navigation: ['Load the site', 'Navigate and classify the page load'],
  'observe-pre-connect': ['Observe before connecting', 'Every request a visitor triggers'],
  wallet: ['Connect the throwaway wallet', 'Find the connect control and approve'],
  'observe-post-connect': ['Observe after connecting', 'Where the address travels next'],
  detection: ['Run detectors', 'Address leaks, IP exposure, RPC, headers'],
  evidence: ['Seal evidence', 'Content-addressed evidence bundle'],
  report: ['Write the report', 'Verdicts, timeline, traffic, RPC inventory'],
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
  return { state, detail, ms };
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

interface Done {
  state: JobState;
  hostname: string;
  version: number | null;
  error: string | null;
  publish: PublishStatus | null;
}

/** The latest server timestamp known, paired with the browser time it was seen. */
function initialAnchor(job: Job): { at: string; seenAt: number } | undefined {
  const at = job.events.at(-1)?.at ?? job.startedAt;
  return at ? { at, seenAt: Date.now() } : undefined;
}

function LiveScan({ job }: { job: Job }) {
  const [events, setEvents] = useState<ScanProgressEvent[]>(job.events);
  const [anchor, setAnchor] = useState(() => initialAnchor(job));
  const [state, setState] = useState<JobState>(job.state);
  const [error, setError] = useState<string | null>(job.error ?? null);
  const [version, setVersion] = useState<number | null>(job.version);
  const [publish, setPublish] = useState<PublishStatus | null>(job.publish);
  const [finishedAt, setFinishedAt] = useState<string | undefined>(job.finishedAt);
  const [streaming, setStreaming] = useState(false);
  const finished = state === 'failed' || state === 'completed';

  useEffect(() => {
    if (job.state === 'failed' || job.state === 'completed') return;
    const es = new EventSource(`/api/scans/${encodeURIComponent(job.id)}/events`);
    es.onopen = () => {
      // The server replays every event on (re)connect: start from scratch.
      setEvents([]);
      setStreaming(true);
    };
    es.onerror = () => setStreaming(false);
    es.addEventListener('state', (e) =>
      setState((JSON.parse((e as MessageEvent).data) as { state: JobState }).state),
    );
    es.addEventListener('progress', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as ScanProgressEvent;
      setEvents((xs) => [...xs, ev]);
      setAnchor({ at: ev.at, seenAt: Date.now() });
    });
    es.addEventListener('done', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as Done;
      es.close();
      setStreaming(false);
      setState(d.state);
      setError(d.error);
      setVersion(d.version);
      setPublish(d.publish);
      // The job's own finishedAt (server clock); until it arrives, the last
      // event's time stands in. Never the browser's clock.
      api.job(job.id).then(
        (j) => setFinishedAt(j.finishedAt),
        () => undefined,
      );
    });
    return () => es.close();
  }, [job.id]);

  // Completed and published: let the final state settle on screen, then open the report.
  useEffect(() => {
    if (state !== 'completed' || version === null || !publish?.ok) return;
    const t = setTimeout(() => go(paths.version(job.hostname, version), true), 1400);
    return () => clearTimeout(t);
  }, [state, version, publish]);

  const now = useNow(!finished);
  const t0 = job.startedAt ?? events[0]?.at;
  const elapsed = elapsedMs({ t0, anchor, finishedAt, finished, now });
  const counters = [...events].reverse().find((e) => e.counters)?.counters;
  const [request] = useState(() => requestFor(job.id));
  const firstAt = events[0] ? new Date(events[0].at).getTime() : 0;

  return (
    <div class="page" style={{ paddingTop: 48 }}>
      <div class="spread rise" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div class="crumbs mono muted small">
            <a href="#/">IGRIS</a> / <a href={`#${paths.site(job.hostname)}`}>{job.hostname}</a> /
            scan
          </div>
          <div class="eyebrow row" style={{ gap: 10, marginTop: 14 }} role="status">
            <span class={`live-dot ${finished ? 'off' : ''}`} />
            {state === 'queued'
              ? 'Queued — waiting for a scanner slot'
              : state === 'running'
                ? 'Scanning'
                : state === 'failed'
                  ? 'Scan failed'
                  : 'Scan complete'}
          </div>
          <h1 class="h1 site-title" style={{ marginTop: 10 }}>
            {job.hostname}
          </h1>
          <div class="mono muted small" style={{ marginTop: 6 }}>
            {job.url}
          </div>
        </div>
        <div class="live-clock">
          <div class="display num">{elapsed !== null ? duration(elapsed) : '—'}</div>
          <div class="eyebrow">elapsed · requested {stamp(job.createdAt)}</div>
        </div>
      </div>

      {request && <RequestPanel request={request} />}

      {state === 'failed' && (
        <div class="panel failure rise" style={{ marginTop: 28 }} role="alert">
          <div class="eyebrow">What happened</div>
          <p style={{ margin: '10px 0 18px' }}>{error ?? 'The scan did not finish.'}</p>
          <p class="muted small" style={{ margin: '0 0 16px' }}>
            Nothing was published: a scan whose page never loaded is not a version.
          </p>
          <RetryScan hostname={job.hostname} url={job.url} />
        </div>
      )}

      {state === 'completed' && (
        <PublishPanel
          job={job}
          version={version}
          publish={publish}
          onPublished={(p, v) => {
            setPublish(p);
            setVersion(v);
          }}
        />
      )}

      <div class="live-grid">
        <ol class="stages rise d1" aria-label="Scan stages">
          {SCAN_STAGES.map((s, i) => {
            const v = stageView(events, s);
            return (
              <li class={`stage ${v.state}`} key={s}>
                <div class="stage-mark" aria-hidden="true">
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
                    <span class="stage-title">
                      {STAGE_LABEL[s][0]}
                      <span class="sr-only"> — {v.state}</span>
                    </span>
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
              <span class="muted small">from the scanner, live</span>
            </div>
            <div class="grid g-3 counters-live">
              <div>
                <div class="display num live-counter">{counters?.requests ?? '—'}</div>
                <div class="eyebrow">requests</div>
              </div>
              <div>
                <div class="display num live-counter">{counters?.hosts ?? '—'}</div>
                <div class="eyebrow">hosts</div>
              </div>
              <div>
                <div class="display num live-counter">{counters?.wsConnections ?? '—'}</div>
                <div class="eyebrow">websockets</div>
              </div>
            </div>
          </div>
          <div class="panel flush">
            <div class="panel-head" style={{ padding: '16px 18px 0' }}>
              <h2 class="h2">Scanner log</h2>
              <span class="row muted small" style={{ gap: 6 }}>
                <span class={`live-dot ${streaming ? '' : 'off'}`} />
                {streaming ? 'streaming' : finished ? 'closed' : 'connecting'}
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

/** The open request this scan answers, and the scanner nodes that may answer it too. */
function RequestPanel({ request }: { request: ScanRequest }) {
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    api.nodes().then(
      (n) => live && setNodes(n),
      () => live && setNodes([]),
    );
    return () => {
      live = false;
    };
  }, []);
  const self = nodes?.find((n) => n.self) ?? null;
  const others = nodes?.filter((n) => !n.self) ?? [];
  return (
    <section class="panel request-panel rise" aria-labelledby="request-h" style={{ marginTop: 28 }}>
      <div class="eyebrow" id="request-h">
        Open scan request
      </div>
      <p style={{ margin: '10px 0 6px' }}>
        This scan answers a request for <span class="mono">{request.url}</span>, made{' '}
        {stamp(request.requestedAt)} and published as entity{' '}
        <span class="mono">{short(request.key, 10, 6)}</span>.{' '}
        <ExplorerLink kind="entity" value={request.key}>
          Request on the Arkiv explorer
        </ExplorerLink>
      </p>
      <p class="muted small" style={{ margin: 0 }}>
        Other scanner nodes may pick this request up and publish their own scans of it. The site
        page then compares their reports, third party by third party.
      </p>
      {nodes !== null && nodes.length > 0 && (
        <p class="small request-nodes" style={{ margin: '10px 0 0' }}>
          {self && (
            <>
              <span class="chip node-chip">{nodeLabel(self.label)}</span> this node, running this
              scan
            </>
          )}
          {others.length > 0 && (
            <>
              {self ? ' · ' : ''}may also answer:{' '}
              {others.map((n) => (
                <span key={n.label} class="chip node-chip">
                  {nodeLabel(n.label)}
                </span>
              ))}
            </>
          )}
        </p>
      )}
    </section>
  );
}

function RetryScan({ hostname, url }: { hostname: string; url: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <div class="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <button
          type="button"
          class="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              go(paths.scan((await startScan(hostname, url)).id));
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
              setBusy(false);
            }
          }}
        >
          {busy && <span class="spinner dark" />}
          Retry scan
        </button>
        <a class="btn" href={`#${paths.site(hostname)}`}>
          Back to {hostname}
        </a>
      </div>
      {err && (
        <div class="form-error" role="alert">
          {err}
        </div>
      )}
    </>
  );
}

function PublishPanel({
  job,
  version,
  publish,
  onPublished,
}: {
  job: Job;
  version: number | null;
  publish: PublishStatus | null;
  onPublished: (p: PublishStatus, version: number | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (publish?.ok)
    return (
      <div class="panel publish ok rise" style={{ marginTop: 28 }} role="status">
        <span class="proof-mark" aria-hidden="true">
          ✓
        </span>
        <div style={{ minWidth: 0 }}>
          <b>
            {publish.mode === 'local' ? 'Saved to the local registry' : 'Published on Arkiv'}
            {version !== null ? ` · v${version}` : ''}
            {publish.txHash ? ` · tx ${short(publish.txHash, 10, 6)}` : ''}
          </b>
          <div class="muted small mono">
            {publish.scanKey ? `entity ${short(publish.scanKey, 10, 6)}` : ''}
            {publish.flowKeys ? ` · ${publish.flowKeys.length} flow entities` : ''}
          </div>
          {publish.mode !== 'local' && (
            <div class="row small" style={{ flexWrap: 'wrap', gap: 14, marginTop: 6 }}>
              {publish.txHash && (
                <ExplorerLink kind="tx" value={publish.txHash}>
                  Transaction on the Arkiv explorer
                </ExplorerLink>
              )}
              {publish.scanKey && (
                <ExplorerLink kind="entity" value={publish.scanKey}>
                  Report entity
                </ExplorerLink>
              )}
            </div>
          )}
          {version !== null && (
            <a class="link small" href={`#${paths.version(job.hostname, version)}`}>
              Opening the report…
            </a>
          )}
        </div>
      </div>
    );
  return (
    <div class="panel publish bad rise" style={{ marginTop: 28 }} role="alert">
      <span class="proof-mark" aria-hidden="true">
        ×
      </span>
      <div style={{ minWidth: 0 }}>
        <b>Not published: {publish?.error ?? 'the report has not been published yet.'}</b>
        <div class="muted small">
          The scan completed. Publishing makes it a version of {job.hostname}; until then its report
          is served from this server’s cache.
        </div>
        <div class="row" style={{ marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
          <button
            type="button"
            class="btn sm primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const p = await api.retryPublish(job.id);
                const fresh = await api.job(job.id);
                onPublished(p, fresh.version);
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <span class="spinner dark" />}
            Retry publish
          </button>
          <a class="btn sm" href={`#${paths.scanReport(job.id)}`}>
            View report (not published yet)
          </a>
        </div>
        {err && (
          <div class="form-error" role="alert">
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
