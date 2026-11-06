import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import './styles.css';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, type RegistryInfo } from './api.js';
import { useRoute, type Route } from './router.js';
import { SearchBox } from './SearchBox.js';
import { Sigil, short } from './ui.js';
import { Landing } from './pages/Landing.js';
import { SitePage } from './pages/Site.js';
import { ScanPage } from './pages/Scan.js';
import { EvidencePage } from './pages/Evidence.js';
import { ScanReportPage } from './pages/ScanReport.js';

function useRegistry(): { info: RegistryInfo | null; down: boolean } {
  const [info, setInfo] = useState<RegistryInfo | null>(null);
  const [down, setDown] = useState(false);
  useEffect(() => {
    // Re-check periodically: the API may start (or restart) after the page.
    let live = true;
    const check = () =>
      api.registry().then(
        (i) => {
          if (!live) return;
          setInfo(i);
          setDown(false);
        },
        () => live && setDown(true),
      );
    void check();
    const t = setInterval(check, 20_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return { info, down };
}

function RegistryChip({ info, down }: { info: RegistryInfo | null; down: boolean }) {
  if (down)
    return (
      <span class="row muted small node-label">
        <span class="live-dot off" /> API offline
      </span>
    );
  if (!info) return null;
  const where = info.mode === 'arkiv' ? `Arkiv · ${info.network}` : 'Local registry';
  const title = info.ready
    ? info.publisher
      ? `Reports are published by ${info.publisher}`
      : 'Read-only: this instance cannot publish'
    : (info.reason ?? 'Registry not ready');
  return (
    <span class="row muted small node-label" title={title}>
      <span class={`live-dot ${info.ready ? '' : 'off'}`} />
      {where}
      {info.publisher ? <span class="mono"> · {short(info.publisher, 6, 4)}</span> : null}
    </span>
  );
}

function Nav({ route, registry }: { route: Route; registry: ReturnType<typeof useRegistry> }) {
  return (
    <header class="nav">
      <div class="nav-inner">
        <a href="#/" class="wordmark" aria-label="IGRIS home">
          <Sigil />
          <span class="wordmark-text">IGRIS</span>
        </a>
        {route.name !== 'landing' && (
          <div class="nav-search">
            <SearchBox compact />
          </div>
        )}
        <div class="nav-right">
          <RegistryChip {...registry} />
        </div>
      </div>
    </header>
  );
}

function NotFound() {
  return (
    <div class="page" style={{ paddingTop: 96 }}>
      <h1 class="h1">Nothing here.</h1>
      <p class="muted">
        That address does not match a page. <a href="#/">Search for a site</a>.
      </p>
    </div>
  );
}

function App() {
  const route = useRoute();
  const registry = useRegistry();
  const routeKey = JSON.stringify(route);
  useEffect(() => {
    // Evidence item changes keep the scroll position; everything else starts at the top.
    if (route.name !== 'evidence' && route.name !== 'scan-evidence') scrollTo({ top: 0 });
  }, [route.name === 'evidence' || route.name === 'scan-evidence' ? route.name : routeKey]);
  let page;
  switch (route.name) {
    case 'landing':
      page = <Landing />;
      break;
    case 'site':
      page = <SitePage key={route.hostname} hostname={route.hostname} registry={registry.info} />;
      break;
    case 'version':
      page = (
        <SitePage
          key={route.hostname}
          hostname={route.hostname}
          version={route.version}
          registry={registry.info}
        />
      );
      break;
    case 'evidence':
      page = (
        <EvidencePage
          key={`${route.hostname}@${route.version}`}
          reportRef={{ kind: 'version', hostname: route.hostname, version: route.version }}
          item={route.item}
        />
      );
      break;
    case 'scan':
      page = <ScanPage key={route.id} id={route.id} />;
      break;
    case 'scan-report':
      page = <ScanReportPage key={route.id} id={route.id} registry={registry.info} />;
      break;
    case 'scan-evidence':
      page = (
        <EvidencePage
          key={`scan:${route.id}`}
          reportRef={{ kind: 'scan', id: route.id }}
          item={route.item}
        />
      );
      break;
    default:
      page = <NotFound />;
  }
  return (
    <>
      <a
        class="skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>
      <Nav route={route} registry={registry} />
      <main id="main" tabIndex={-1}>
        {page}
      </main>
      <footer class="page footer">
        <div class="spread" style={{ flexWrap: 'wrap' }}>
          <span>
            IGRIS is open source. Scans run in an isolated browser with a throwaway wallet; reports
            are published on Arkiv with their evidence so anyone can re-verify them.
          </span>
          <span class="mono">no trackers · no third-party requests</span>
        </div>
      </footer>
    </>
  );
}

render(<App />, document.getElementById('root')!);
