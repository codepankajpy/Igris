import { useState } from 'preact/hooks';
import { api, normaliseUrl } from './api.js';
import { go } from './router.js';

/** URL entry → POST /api/scans → the live scan page. */
export function ScanForm({
  autofocus,
  dwellMs,
  initial = '',
}: {
  autofocus?: boolean;
  dwellMs?: number;
  initial?: string;
}) {
  const [url, setUrl] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    const target = normaliseUrl(url);
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.submit(target, dwellMs);
      go(`/scans/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label class="urlbar">
        <span class="mono muted" aria-hidden="true">
          ⌁
        </span>
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          spellcheck={false}
          placeholder="app.uniswap.org"
          aria-label="dApp URL to scan"
          value={url}
          autoFocus={autofocus}
          onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
        />
        <button class="btn primary" type="submit" disabled={busy || !url.trim()}>
          {busy ? <span class="spinner" style={{ borderTopColor: '#000' }} /> : null}
          {busy ? 'Starting' : 'Scan dApp'}
        </button>
      </label>
      {error && (
        <div class="form-error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}
