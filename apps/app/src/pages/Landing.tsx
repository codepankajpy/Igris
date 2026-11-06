import { useEffect, useState } from 'preact/hooks';
import { api, type ScanMeta } from '../api.js';
import { ScanForm } from '../ScanForm.js';
import { LevelBadge, ago } from '../ui.js';

const METHOD = [
  {
    n: '01',
    t: 'Isolated browser',
    d: 'Each scan opens the dApp in a fresh Chromium profile. Egress is filtered to public addresses only.',
  },
  {
    n: '02',
    t: 'Canary wallet',
    d: 'A throwaway wallet with a unique address connects like a real user would. It holds nothing.',
  },
  {
    n: '03',
    t: 'Evidence, not guesses',
    d: 'Every request is watched for the canary in any encoding. Each finding points to a content-addressed evidence item.',
  },
  {
    n: '04',
    t: 'Deterministic score',
    d: 'A published rule set turns findings into a score. Same behaviour, same finding IDs, same number.',
  },
];

export function Landing() {
  const [recent, setRecent] = useState<ScanMeta[] | null>(null);
  useEffect(() => {
    api.list().then(
      (s) => setRecent(s.filter((m) => m.state === 'completed' && m.summary).slice(0, 4)),
      () => setRecent([]),
    );
  }, []);

  return (
    <div class="page">
      <section class="hero">
        <div class="hero-glow" aria-hidden="true" />
        <div class="eyebrow rise">Privacy intelligence for dApps</div>
        <h1 class="display hero-title rise d1">
          See who learns your
          <br />
          <em>wallet address.</em>
        </h1>
        <p class="hero-sub rise d2">
          Igris loads a dApp in an isolated browser, connects a throwaway wallet, and records every
          third party that receives it — with the evidence to prove it.
        </p>
        <div class="hero-form rise d3">
          <ScanForm autofocus />
          <div class="muted hero-hint">
            Runs on your scanner node · about 30–60 seconds · nothing is published
          </div>
        </div>
      </section>

      <section class="section">
        <div class="method">
          {METHOD.map((m, i) => (
            <div class={`method-step rise d${Math.min(4, i + 1)}`} key={m.n}>
              <div class="mono muted">{m.n}</div>
              <h3 class="h2" style={{ marginTop: 18 }}>
                {m.t}
              </h3>
              <p class="muted" style={{ margin: '8px 0 0', fontSize: '0.88rem' }}>
                {m.d}
              </p>
            </div>
          ))}
        </div>
      </section>

      {recent && recent.length > 0 && (
        <section class="section">
          <div class="section-head">
            <h2 class="h2">Recent scans on this node</h2>
            <a href="#/history" class="muted" style={{ fontSize: '0.82rem' }}>
              All scans →
            </a>
          </div>
          <div class="grid g-4">
            {recent.map((m) => (
              <a href={`#/scans/${m.id}`} class="panel recent-card" key={m.id}>
                <div class="spread">
                  <span class="mono" style={{ fontSize: '0.8rem' }}>
                    {m.hostname}
                  </span>
                  <span class="muted" style={{ fontSize: '0.74rem' }}>
                    {ago(m.createdAt)}
                  </span>
                </div>
                <div class="recent-score display num">{m.summary!.score ?? '—'}</div>
                <LevelBadge level={m.summary!.level} />
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
