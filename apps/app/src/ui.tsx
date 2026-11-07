/**
 * Shared presentational components and wording. No data decisions live here:
 * verdicts, states and reasons come from the backend; this file only names
 * them for people.
 */
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { Recipient, Verdict } from '@igris/core/contracts';
import type { SummaryState } from './api.js';

// --------------------------------------------------------------- wording

/** Display order (worst first) — the order the backend sorts recipients in. */
export const VERDICT_ORDER: readonly Verdict[] = [
  'unidentified',
  'tracking',
  'avoidable',
  'expected',
];

export const VERDICT: Record<Verdict, { label: string; meaning: string }> = {
  expected: { label: 'Expected', meaning: 'Needed for the app to work as built.' },
  avoidable: { label: 'Avoidable', meaning: 'The app works without this exposure.' },
  tracking: { label: 'Tracking', meaning: 'Not needed; profiles visitors.' },
  unidentified: {
    label: 'Unidentified',
    meaning: 'Nobody can say what it does with what it receives.',
  },
};

export const STATE: Record<SummaryState, string> = {
  // The state covers tracking AND unidentified recipients (core assessment.ts).
  'address-to-trackers': 'Address reached tracking or unidentified parties',
  'address-to-services': 'Address reached services only',
  'no-address-observed': 'No address leak observed',
  'not-observed': 'Not observed',
};

export const CLASS_LABEL: Record<string, string> = {
  'first-party': 'First party',
  'rpc-provider': 'RPC provider',
  analytics: 'Analytics',
  'error-monitoring': 'Error monitoring',
  'support-chat': 'Support chat',
  'walletconnect-relay': 'WalletConnect relay',
  'wallet-sdk': 'Wallet / login SDK',
  'ipfs-gateway': 'IPFS gateway',
  cdn: 'CDN',
  'anon-rpc': 'Anon-RPC',
  'unknown-third-party': 'Unidentified third party',
};
export const classLabel = (c: string) => CLASS_LABEL[c] ?? c;

export const ADDRESS_LABEL: Record<Recipient['learned']['address'], string> = {
  exact: 'Full address',
  hashed: 'Hashed address',
  possible: 'Truncated form (possible match)',
  none: 'No address',
};

export const MILESTONE_LABEL: Record<string, string> = {
  'page-loaded': 'Page loaded',
  'connect-started': 'Connect started',
  'accounts-requested': 'Accounts requested',
  'connect-finished': 'Connect finished',
  'observation-ended': 'Observation ended',
};

/**
 * The one case drawn in red: the address (full or hashed) reached a recipient
 * the backend judged tracking or unidentified. Reads two backend fields; it
 * judges nothing itself.
 */
export function addressToTracker(r: Pick<Recipient, 'verdict' | 'learned'>): boolean {
  return (
    (r.verdict === 'tracking' || r.verdict === 'unidentified') &&
    (r.learned.address === 'exact' || r.learned.address === 'hashed')
  );
}

// --------------------------------------------------------------- chips

export function StateChip({ state }: { state: SummaryState }) {
  return (
    <span class={`chip state-${state} ${state === 'address-to-trackers' ? 'signal' : ''}`}>
      <span class="state-mark" />
      {STATE[state]}
    </span>
  );
}

export function VerdictChip({ verdict }: { verdict: Verdict }) {
  return (
    <span class={`chip verdict v-${verdict}`} title={VERDICT[verdict].meaning}>
      <span class="v-mark" />
      {VERDICT[verdict].label}
    </span>
  );
}

// --------------------------------------------------------------- layout

export function Section({
  title,
  aside,
  children,
  id,
  lede,
}: {
  title: string;
  aside?: ComponentChildren;
  children: ComponentChildren;
  id?: string;
  lede?: ComponentChildren;
}) {
  return (
    <section class="section" id={id} aria-labelledby={id ? `${id}-h` : undefined}>
      <div class="section-head">
        <h2 class="h2" id={id ? `${id}-h` : undefined}>
          {title}
        </h2>
        {aside && <div class="muted small">{aside}</div>}
      </div>
      {lede && <p class="lede">{lede}</p>}
      {children}
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div class="panel empty">
      <h2 class="h1">{title}</h2>
      <div style={{ marginTop: 12 }}>{children}</div>
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div class="row muted" style={{ padding: '48px 0', justifyContent: 'center' }} role="status">
      <span class="spinner" />
      {label}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <div class="panel">
      <div class="form-error" style={{ marginTop: 0 }} role="alert">
        {error instanceof Error ? error.message : String(error)}
      </div>
    </div>
  );
}

export function NotRecorded({ what }: { what: string }) {
  return (
    <div class="panel not-recorded">
      <span class="eyebrow">Not recorded</span>
      <p class="muted small" style={{ margin: '8px 0 0' }}>
        {what}
      </p>
    </div>
  );
}

export function Hash({ value, n = 12 }: { value: string; n?: number }) {
  return (
    <code class="mono" title={value}>
      {value.length > n ? `${value.slice(0, n)}…` : value}
    </code>
  );
}

export function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      class="btn sm"
      type="button"
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

export function Check({ ok, label }: { ok: boolean; label: ComponentChildren }) {
  return (
    <div class={`check ${ok ? 'ok' : 'bad'}`}>
      <span class="check-mark" aria-hidden="true">
        {ok ? '✓' : '×'}
      </span>
      <span class="sr-only">{ok ? 'Passed: ' : 'Failed: '}</span>
      {label}
    </div>
  );
}

// --------------------------------------------------------------- time

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function ago(when: string | number, now = Date.now()): string {
  const ms = typeof when === 'number' ? when * 1000 : new Date(when).getTime();
  const s = Math.round((ms - now) / 1000);
  const a = Math.abs(s);
  if (a < 60) return rtf.format(s, 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
/** ISO string or unix seconds → local date and time. */
export function stamp(when: string | number): string {
  return new Date(typeof when === 'number' ? when * 1000 : when).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
export function day(when: number): string {
  return new Date(when * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' });
}
export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} m ${Math.round(s % 60)} s`;
}
export const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const short = (s: string, head = 6, tail = 4) =>
  s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;

// --------------------------------------------------------------- kits

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
