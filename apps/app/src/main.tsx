import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import './styles.css';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from './api.js';
import { useRoute, type Route } from './router.js';
import { Sigil } from './ui.js';
import { Landing } from './pages/Landing.js';
import { Dashboard } from './pages/Dashboard.js';
import { NewScan } from './pages/NewScan.js';
import { ScanPage } from './pages/Scan.js';
import { EvidenceExplorer } from './pages/Evidence.js';
import { History } from './pages/History.js';

function useApiHealth(): 'up' | 'down' | 'unknown' {
  const [s, setS] = useState<'up' | 'down' | 'unknown'>('unknown');
  useEffect(() => {
    let live = true;
    const check = () =>
      api.health().then(
        () => live && setS('up'),
        () => live && setS('down'),
      );
    void check();
    const t = setInterval(check, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return s;
}

function Nav({ route }: { route: Route }) {
  const health = useApiHealth();
  const active = (n: Route['name'][]) => (n.includes(route.name) ? 'nav-link active' : 'nav-link');
  return (
    <header class="nav">
      <div class="nav-inner">
        <a href="#/" class="wordmark" aria-label="Igris home">
          <Sigil />
          IGRIS
        </a>
        <nav class="nav-links">
          <a href="#/dashboard" class={`${active(['dashboard'])} keep`}>
            Dashboard
          </a>
          <a href="#/history" class={`${active(['history'])} keep`}>
            History
          </a>
        </nav>
        <div class="nav-right">
          <span
            class="row muted node-label"
            style={{ gap: 8, fontSize: '0.78rem' }}
            title="Scans run on this machine's scanner node"
          >
            <span class={`live-dot ${health === 'up' ? '' : 'off'}`} />
            {health === 'up'
              ? 'Local scanner online'
              : health === 'down'
                ? 'Scanner offline'
                : 'Checking scanner'}
          </span>
          <a href="#/scan" class="btn sm primary">
            New scan
          </a>
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
        That address does not match a page. <a href="#/">Go home</a>.
      </p>
    </div>
  );
}

function App() {
  const route = useRoute();
  useEffect(() => {
    scrollTo({ top: 0 });
  }, [route.name, 'id' in route ? route.id : '']);
  let page;
  switch (route.name) {
    case 'landing':
      page = <Landing />;
      break;
    case 'dashboard':
      page = <Dashboard />;
      break;
    case 'new':
      page = <NewScan />;
      break;
    case 'history':
      page = <History />;
      break;
    case 'scan':
      page = <ScanPage key={route.id} id={route.id} />;
      break;
    case 'evidence':
      page = <EvidenceExplorer key={route.id} id={route.id} item={route.item} />;
      break;
    default:
      page = <NotFound />;
  }
  return (
    <>
      <Nav route={route} />
      <main>{page}</main>
      <footer class="page footer">
        <div class="spread">
          <span>
            Igris scans run locally in an isolated browser with a throwaway wallet. Results are not
            published.
          </span>
          <span class="mono">egress: public-only</span>
        </div>
      </footer>
    </>
  );
}

render(<App />, document.getElementById('root')!);
