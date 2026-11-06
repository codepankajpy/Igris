import { useState } from 'preact/hooks';
import { ScanForm } from '../ScanForm.js';

const DWELL = [
  { ms: 4000, label: 'Standard', hint: '4 s per phase' },
  { ms: 8000, label: 'Patient', hint: '8 s — for slow, script-heavy apps' },
  { ms: 15000, label: 'Thorough', hint: '15 s — late beacons and polling' },
];

const SAMPLES = [
  'app.uniswap.org',
  'app.aave.com',
  'app.gearbox.fi',
  'app.spark.fi',
  'matcha.xyz',
  'www.bungee.exchange',
];

export function NewScan() {
  const [dwell, setDwell] = useState(4000);
  const [seed, setSeed] = useState({ v: '', k: 0 });

  return (
    <div class="page narrow" style={{ paddingTop: 72 }}>
      <div class="eyebrow rise">New scan</div>
      <h1 class="h1 rise d1" style={{ marginTop: 12 }}>
        Which dApp should we examine?
      </h1>
      <p class="muted rise d1" style={{ maxWidth: 560 }}>
        Paste the address of the app itself (the page where you would connect a wallet), not its
        marketing site.
      </p>

      <div class="rise d2" style={{ marginTop: 32 }}>
        <ScanForm key={seed.k} initial={seed.v} autofocus dwellMs={dwell} />
        <div class="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          <span class="muted" style={{ fontSize: '0.8rem' }}>
            Try
          </span>
          {SAMPLES.map((s) => (
            <button
              key={s}
              class="chip sample"
              type="button"
              onClick={() => setSeed({ v: s, k: seed.k + 1 })}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div class="panel rise d3" style={{ marginTop: 40 }}>
        <div class="panel-head">
          <h2 class="h2">Observation window</h2>
          <span class="muted" style={{ fontSize: '0.8rem' }}>
            How long to watch traffic before and after connecting
          </span>
        </div>
        <div class="segmented" role="radiogroup" aria-label="Observation window">
          {DWELL.map((d) => (
            <button
              key={d.ms}
              type="button"
              role="radio"
              aria-checked={dwell === d.ms}
              class={dwell === d.ms ? 'on' : ''}
              onClick={() => setDwell(d.ms)}
            >
              <b>{d.label}</b>
              <span>{d.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div class="grid g-3 rise d4" style={{ marginTop: 16 }}>
        <div class="panel">
          <div class="eyebrow">Isolation</div>
          <p class="dim small">
            Fresh Chromium profile per scan. Network egress is restricted to public addresses; the
            scanner cannot reach your local network.
          </p>
        </div>
        <div class="panel">
          <div class="eyebrow">Wallet</div>
          <p class="dim small">
            A freshly generated throwaway key that holds nothing. Your own wallet is never involved.
          </p>
        </div>
        <div class="panel">
          <div class="eyebrow">Output</div>
          <p class="dim small">
            A verified report and evidence bundle, stored on this scanner node only. Nothing is
            published.
          </p>
        </div>
      </div>
    </div>
  );
}
