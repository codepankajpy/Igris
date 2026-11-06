import { useState } from 'preact/hooks';
import { normaliseHostname } from './api.js';
import { go, paths } from './router.js';

/** Site search: a URL or a host → #/site/:hostname. Nothing is sent until the site page loads. */
export function SearchBox({ autofocus, compact }: { autofocus?: boolean; compact?: boolean }) {
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(e: Event) {
    e.preventDefault();
    const host = normaliseHostname(q);
    if (!host) {
      setError('Enter a site like app.uniswap.org, or paste its URL.');
      return;
    }
    setError(null);
    go(paths.site(host));
  }

  return (
    <form onSubmit={submit} role="search" class={compact ? 'search compact' : 'search'}>
      <label class="urlbar">
        <svg class="search-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" />
          <path d="M11 11l3.5 3.5" stroke="currentColor" />
        </svg>
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          spellcheck={false}
          placeholder="Search a site or paste a URL"
          aria-label="Search a site or paste a URL"
          value={q}
          autoFocus={autofocus}
          onInput={(e) => {
            setQ((e.target as HTMLInputElement).value);
            if (error) setError(null);
          }}
        />
        <button class="btn primary" type="submit" disabled={!q.trim()}>
          {compact ? 'Go' : 'Search'}
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
