/**
 * A completed scan that is not published (yet): its report, served from the
 * server's cache by GET /api/scans/:id/report and re-verified there, drawn by
 * the same report view as a published version — under a banner saying it is
 * not on Arkiv, with Retry publish. Once published, the version page is the
 * report's home and this page forwards to it.
 */
import { useEffect, useState } from 'preact/hooks';
import { ApiError, api, type Job, type RegistryInfo } from '../api.js';
import { go, paths } from '../router.js';
import { ErrorNote, Loading } from '../ui.js';
import { fromScanReport, type ReportData } from '../report/data.js';
import { ReportView } from './Report.js';

export function ScanReportPage({ id, registry }: { id: string; registry: RegistryInfo | null }) {
  const [job, setJob] = useState<Job | null>(null);
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    Promise.all([api.job(id), api.scanReport(id)]).then(([j, r]) => {
      if (j.state === 'completed' && j.version !== null && j.publish?.ok)
        go(paths.version(j.hostname, j.version), true);
      else {
        setJob(j);
        setData(fromScanReport(j, r));
      }
    }, setError);
  }, [id]);

  if (error)
    return (
      <div class="page" style={{ paddingTop: 56 }}>
        <ErrorNote error={error} />
        <p class="muted" style={{ marginTop: 16 }}>
          {error instanceof ApiError && error.status === 409 ? (
            <a class="link" href={`#${paths.scan(id)}`}>
              Watch the scan →
            </a>
          ) : (
            <a class="link" href="#/">
              Search for a site →
            </a>
          )}
        </p>
      </div>
    );
  if (!job || !data) return <Loading label="Loading and verifying the scan’s report" />;
  return (
    <div class="page" style={{ paddingTop: 40 }}>
      <div class="site-header rise">
        <div style={{ minWidth: 0 }}>
          <div class="crumbs mono muted small">
            <a href="#/">IGRIS</a> / <a href={`#${paths.site(job.hostname)}`}>{job.hostname}</a> /{' '}
            <a href={`#${paths.scan(job.id)}`}>scan</a> / report
          </div>
          <h1 class="h1 site-title">{job.hostname}</h1>
        </div>
      </div>
      <UnpublishedBanner job={job} registry={registry} />
      <ReportView data={data} registry={registry} />
    </div>
  );
}

function UnpublishedBanner({ job, registry }: { job: Job; registry: RegistryInfo | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const where =
    registry?.mode === 'local'
      ? 'Not saved to the local registry yet'
      : 'Not published on Arkiv yet';
  return (
    <div class="panel publish bad unpublished-banner rise" role="status">
      <span class="proof-mark" aria-hidden="true">
        ×
      </span>
      <div style={{ minWidth: 0 }}>
        <b>{where}</b>
        <div class="muted small">
          {job.publish?.error
            ? `Publishing failed: ${job.publish.error}. `
            : 'Publishing has not finished. '}
          This report is served from this server’s cache; it becomes a version of {job.hostname}{' '}
          once it is published.
        </div>
        <div class="row" style={{ marginTop: 12 }}>
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
                if (p.ok && fresh.version !== null)
                  go(paths.version(fresh.hostname, fresh.version), true);
                else setErr(p.error ?? 'Publishing did not complete.');
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
