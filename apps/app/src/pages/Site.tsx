/**
 * A site: its published versions (newest first) as a history rail, the
 * selected version's report, and Retest. Not scanned yet → an empty state
 * with "Scan this site". A scan already running → its live view.
 */
import type { ComponentChildren } from 'preact';
import { ExplorerLink } from '../explorer.js';
import { useEffect, useState } from 'preact/hooks';
import {
  api,
  startScan,
  type PublishedScan,
  type RegistryInfo,
  type SiteResponse,
} from '../api.js';
import { go, paths } from '../router.js';
import { Empty, ErrorNote, Loading, StateChip, day, plural } from '../ui.js';
import { railChange } from '../wording.js';
import { loadReport, type ReportData } from '../report/data.js';
import { ReportView } from './Report.js';

/** Interval between site page re-checks while a scan of the site runs (one same-origin GET). */
const RECHECK_MS = 20_000;

function ScanButton({
  hostname,
  url,
  label,
  primary = true,
  disabled,
}: {
  hostname: string;
  url?: string;
  label: string;
  primary?: boolean;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div class="scan-action">
      <button
        type="button"
        class={`btn ${primary ? 'primary' : ''}`}
        disabled={busy || disabled}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            go(paths.scan((await startScan(hostname, url)).id));
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
          }
        }}
      >
        {busy && <span class="spinner dark" />}
        {busy ? 'Starting' : label}
      </button>
      {error && (
        <div class="form-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function SitePage({
  hostname,
  version,
  registry,
}: {
  hostname: string;
  version?: number;
  registry: RegistryInfo | null;
}) {
  const [site, setSite] = useState<SiteResponse | null>(null);
  // The newest version when the page loaded: shown by default, so the version
  // a running scan publishes meanwhile is added to the rail without replacing
  // the report being read.
  const [shown, setShown] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setSite(null);
    setShown(null);
    setError(null);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // While a scan of this site runs here, look again (one same-origin GET
    // every RECHECK_MS) so its version appears without a reload; stop once no
    // scan is running. A failed re-check keeps what is shown.
    const schedule = (s: SiteResponse) => {
      if (live && s.scanning !== null) timer = setTimeout(recheck, RECHECK_MS);
    };
    const recheck = () =>
      api.site(hostname).then(
        (s) => {
          if (!live) return;
          setSite(s);
          setShown((n) => n ?? s.versions[0]?.version ?? null);
          schedule(s);
        },
        () => undefined,
      );
    api.site(hostname).then((s) => {
      if (!live) return;
      // Nothing published yet but a scan is running: show it live.
      if (s.versions.length === 0 && s.scanning) return go(paths.scan(s.scanning.id), true);
      setSite(s);
      setShown(s.versions[0]?.version ?? null);
      schedule(s);
    }, setError);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [hostname]);

  if (error)
    return (
      <div class="page" style={{ paddingTop: 48 }}>
        <ErrorNote error={error} />
      </div>
    );
  if (!site) return <Loading label={`Looking up ${hostname}`} />;

  if (site.versions.length === 0)
    return (
      <div class="page narrow" style={{ paddingTop: 56 }}>
        <SiteHeader hostname={hostname} />
        <div class="rise d1" style={{ marginTop: 32 }}>
          <Empty title="Not scanned yet">
            <p style={{ maxWidth: 520, margin: '0 auto 22px' }}>
              Nobody has published a report for <b class="mono">{hostname}</b>. A scan opens{' '}
              <span class="mono">https://{hostname}/</span> in an isolated browser with a throwaway
              wallet, runs every check, and publishes the report on Arkiv as version 1. It takes
              about a minute.
            </p>
            <ScanButton hostname={hostname} label="Scan this site" />
          </Empty>
        </div>
      </div>
    );

  const latest = site.versions[0]!;
  const n = version ?? shown ?? latest.version;
  return (
    <div class="page" style={{ paddingTop: 40 }}>
      <SiteHeader hostname={hostname}>
        <ScanButton hostname={hostname} label="Retest" disabled={site.scanning !== null} />
      </SiteHeader>
      {site.scanning && (
        <a class="panel scanning-banner rise" href={`#${paths.scan(site.scanning.id)}`}>
          <span class="live-dot" />
          <span>
            A new scan of this site is {site.scanning.state}. <u>Watch it live →</u>
          </span>
        </a>
      )}
      <VersionRail hostname={hostname} versions={site.versions} current={n} />
      {registry?.mode === 'arkiv' && (
        <p class="small rail-explorer">
          <ExplorerLink kind="versions" value={hostname}>
            Every version of {hostname} on the Arkiv explorer
          </ExplorerLink>
        </p>
      )}
      <VersionBody key={`${hostname}@${n}`} hostname={hostname} n={n} registry={registry} />
    </div>
  );
}

function SiteHeader({ hostname, children }: { hostname: string; children?: ComponentChildren }) {
  return (
    <div class="site-header rise">
      <div style={{ minWidth: 0 }}>
        <div class="crumbs mono muted small">
          <a href="#/">IGRIS</a> / site
        </div>
        <h1 class="h1 site-title">{hostname}</h1>
      </div>
      {children}
    </div>
  );
}

function VersionBody({
  hostname,
  n,
  registry,
}: {
  hostname: string;
  n: number;
  registry: RegistryInfo | null;
}) {
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    loadReport({ kind: 'version', hostname, version: n }).then(setData, setError);
  }, [hostname, n]);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading label={`Loading and verifying v${n}`} />;
  return <ReportView data={data} registry={registry} />;
}

/** Version history: newest first, each compared with version − 1 when it is listed. */
function VersionRail({
  hostname,
  versions,
  current,
}: {
  hostname: string;
  versions: PublishedScan[];
  current: number;
}) {
  return (
    <nav class="rail rise d1" aria-label="Version history">
      <div class="eyebrow rail-title">Version history · {plural(versions.length, 'version')}</div>
      <ol class="rail-list">
        {versions.map((v) => (
          <li key={v.key}>
            <a
              href={`#${paths.version(hostname, v.version)}`}
              class={`rail-item ${v.version === current ? 'on' : ''}`}
              aria-current={v.version === current ? 'page' : undefined}
            >
              <span class="rail-dot" aria-hidden="true" />
              <span class="spread">
                <b class="mono">v{v.version}</b>
                <span class="muted small">{day(v.scannedAt)}</span>
              </span>
              <StateChip state={v.state} />
              <span class="rail-counts small">
                {v.recipients} parties · {v.addressRecipients} got address · {v.trackingRecipients}{' '}
                tracking/unidentified
              </span>
              <span class="rail-change small muted">{railChange(v, versions)}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
