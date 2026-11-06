/** Shared presentational components. No data decisions live here. */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Level, SeverityCounts } from './api.js';

export const LEVEL_LABEL: Record<Level, string> = {
  'not-assessed': 'Not assessed',
  critical: 'Critical exposure',
  high: 'High exposure',
  elevated: 'Elevated exposure',
  moderate: 'Moderate exposure',
  low: 'Low exposure',
};

export function LevelBadge({ level }: { level: Level }) {
  return (
    <span class={`chip level-${level} ${level === 'critical' ? 'signal' : ''}`}>
      <span class="level-mark" />
      {LEVEL_LABEL[level]}
    </span>
  );
}

export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type SeverityName = (typeof SEVERITY_ORDER)[number];

export function Sev({ s }: { s: SeverityName }) {
  return (
    <span class={`sev ${s}`}>
      <i />
      {s}
    </span>
  );
}

/** Severity distribution as a stacked bar, monochrome by intensity. */
export function SeverityBar({ counts }: { counts: SeverityCounts }) {
  const total = SEVERITY_ORDER.reduce((a, s) => a + counts[s], 0);
  if (!total) return <div class="stackbar" />;
  return (
    <div
      class="stackbar"
      role="img"
      aria-label={SEVERITY_ORDER.map((s) => `${counts[s]} ${s}`).join(', ')}
    >
      {SEVERITY_ORDER.filter((s) => counts[s]).map((s) => (
        <span key={s} class={`sb-${s}`} style={{ flex: counts[s] }} title={`${counts[s]} ${s}`} />
      ))}
    </div>
  );
}

export function ScoreDial({
  score,
  level,
  size = 180,
}: {
  score: number | null;
  level: Level;
  size?: number;
}) {
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const t = requestAnimationFrame(() => setShown(score ?? 0));
    return () => cancelAnimationFrame(t);
  }, [score]);
  return (
    <div
      class={`dial ${level === 'critical' ? 'signal' : ''}`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle class="track" cx={size / 2} cy={size / 2} r={r} fill="none" stroke-width="5" />
        {score !== null && (
          <circle
            class="arc"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke-width="5"
            stroke-dasharray={c}
            stroke-dashoffset={c * (1 - shown / 100)}
          />
        )}
      </svg>
      <div class="v">
        <div>
          <b style={{ fontSize: size / 45 + 'rem' }}>{score ?? '—'}</b>
          <div class="eyebrow" style={{ marginTop: 8 }}>
            {score === null ? 'not scored' : 'privacy / 100'}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Kpi({ k, l, s }: { k: ComponentChildren; l: string; s?: ComponentChildren }) {
  return (
    <div class="panel kpi">
      <div class="k num">{k}</div>
      <div class="l eyebrow">{l}</div>
      {s !== undefined && <div class="s">{s}</div>}
    </div>
  );
}

export function Section({
  title,
  aside,
  children,
  id,
}: {
  title: string;
  aside?: ComponentChildren;
  children: ComponentChildren;
  id?: string;
}) {
  return (
    <section class="section" id={id}>
      <div class="section-head">
        <h2 class="h2">{title}</h2>
        {aside && (
          <div class="muted" style={{ fontSize: '0.82rem' }}>
            {aside}
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div class="panel empty">
      <h3 class="h1">{title}</h3>
      <div style={{ marginTop: 12 }}>{children}</div>
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div class="row muted" style={{ padding: '48px 0', justifyContent: 'center' }}>
      <span class="spinner" />
      {label}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <div class="panel">
      <div class="form-error" style={{ marginTop: 0 }}>
        {error instanceof Error ? error.message : String(error)}
      </div>
    </div>
  );
}

export function Hash({ value, n = 12 }: { value: string; n?: number }) {
  return (
    <code class="mono" title={value}>
      {value.slice(0, n)}…
    </code>
  );
}

export function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      class="btn sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

/** Save data the page already holds as a file (no network). */
export function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function ago(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const a = Math.abs(s);
  if (a < 60) return rtf.format(s, 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
export function stamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} m ${Math.round(s % 60)} s`;
}

/** Wording for kit identification confidence (high = modal observed). */
export const KIT_NAME: Record<string, string> = {
  rainbowkit: 'RainbowKit',
  connectkit: 'ConnectKit',
  appkit: 'Reown AppKit',
  privy: 'Privy',
  dynamic: 'Dynamic',
};
export function kitWording(id: string, confidence: string): string {
  const name = KIT_NAME[id] ?? id;
  if (confidence === 'high') return `${name} — identified (modal observed)`;
  if (confidence === 'medium') return `${name} — likely`;
  return `${name} — possible, unconfirmed`;
}

export function Sigil({ size = 18 }: { size?: number }) {
  return (
    <svg
      class="sigil"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10.5" stroke="currentColor" stroke-opacity="0.5" />
      <circle cx="12" cy="12" r="5.5" stroke="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <path d="M12 0.5V4M12 20v3.5M0.5 12H4M20 12h3.5" stroke="currentColor" stroke-opacity="0.5" />
    </svg>
  );
}
