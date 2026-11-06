/** Hash router: no server routes, works from any static host or file. */
import { useEffect, useState } from 'preact/hooks';

export type Route =
  | { name: 'landing' }
  | { name: 'dashboard' }
  | { name: 'new' }
  | { name: 'history' }
  | { name: 'scan'; id: string }
  | { name: 'evidence'; id: string; item?: string }
  | { name: 'not-found' };

const UUID = '[0-9a-f-]{36}';

export function parse(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/';
  if (path === '/') return { name: 'landing' };
  if (path === '/dashboard') return { name: 'dashboard' };
  if (path === '/scan' || path === '/scan/new') return { name: 'new' };
  if (path === '/history') return { name: 'history' };
  let m = new RegExp(`^/scans/(${UUID})$`).exec(path);
  if (m) return { name: 'scan', id: m[1]! };
  m = new RegExp(`^/scans/(${UUID})/evidence(?:/(ev_[0-9a-f]{24}))?$`).exec(path);
  if (m)
    return m[2] ? { name: 'evidence', id: m[1]!, item: m[2] } : { name: 'evidence', id: m[1]! };
  return { name: 'not-found' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parse(location.hash));
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function go(path: string): void {
  location.hash = path;
}
