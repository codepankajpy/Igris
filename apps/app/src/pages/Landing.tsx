import { useEffect, useState } from 'preact/hooks';
import { api, type PublishedScan } from '../api.js';
import { paths } from '../router.js';
import { SearchBox } from '../SearchBox.js';
import { StateChip, ago, plural } from '../ui.js';

export function Landing() {
  const [recent, setRecent] = useState<PublishedScan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.sites(12).then(setRecent, (e: unknown) => {
      setRecent([]);
      setError(e instanceof Error ? e.message : String(e));
    });
  }, []);

  return (
    <div class="page">
      <section class="hero">
        <div class="hero-glow" aria-hidden="true" />
        <div class="eyebrow rise">Open privacy reports for dApps</div>
        <h1 class="display hero-title rise d1">
          Who learns your
          <br />
          <em>wallet address?</em>
        </h1>
        <div class="hero-form rise d2">
          <SearchBox autofocus />
        </div>
        <p class="hero-sub rise d3">
          IGRIS opens a site in an isolated browser, connects a throwaway wallet that holds nothing,
          and watches every request: where the address goes (in any encoding), who learns the
          visitor’s IP before and after connecting, which RPC endpoints and methods are called,
          trackers, cookies and storage, and the security headers of the page. Each third party gets
          a verdict — expected, avoidable, tracking or unidentified — backed by content-addressed
          evidence. Every report is published on Arkiv, and every retest adds a new version to the
          site’s history.
        </p>
      </section>

      <section class="section" aria-labelledby="recent-h">
        <div class="section-head">
          <h2 class="h2" id="recent-h">
            Recently scanned
          </h2>
          {recent && recent.length > 0 && (
            <span class="muted small">latest version of each site</span>
          )}
        </div>
        {recent === null ? (
          <div class="grid g-3">
            {[0, 1, 2].map((i) => (
              <div class="panel recent-card skeleton" key={i} aria-hidden="true" />
            ))}
          </div>
        ) : recent.length === 0 ? (
          <p class="muted">
            {error ?? 'No site has been scanned yet. Search for one above to run the first scan.'}
          </p>
        ) : (
          <div class="grid g-3">
            {recent.map((s) => (
              <a href={`#${paths.site(s.hostname)}`} class="panel recent-card" key={s.key}>
                <div class="spread">
                  <span class="mono recent-host">{s.hostname}</span>
                  <span class="mono muted small">v{s.version}</span>
                </div>
                <div style={{ margin: '14px 0 16px' }}>
                  <StateChip state={s.state} />
                </div>
                <div class="recent-counts">
                  <span>
                    <b class="num">{s.recipients}</b> third parties
                  </span>
                  <span>
                    <b class="num">{s.addressRecipients}</b> got the address
                  </span>
                  <span>
                    <b class="num">{s.trackingRecipients}</b> tracking or unidentified
                  </span>
                </div>
                <div class="muted small" style={{ marginTop: 14 }}>
                  scanned {ago(s.scannedAt)} · {plural(s.version, 'version')}
                </div>
              </a>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
