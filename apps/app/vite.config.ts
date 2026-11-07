import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * The backend's origin when the website is hosted apart from it (e.g. the
 * website on Vercel, the backend on Railway): VITE_IGRIS_API_URL, fixed at
 * build time. Empty = same origin (the backend serves the website, or the
 * dev server proxies /api). Anything but a bare http(s) origin fails the
 * build, so a typo can never send visitors' requests somewhere unexpected.
 */
export function apiOrigin(raw: string | undefined): string {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  if (value === '') return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`VITE_IGRIS_API_URL is not a URL: "${value}"`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    throw new Error('VITE_IGRIS_API_URL must use https:// (http:// only for localhost)');
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error(
      'VITE_IGRIS_API_URL must be an origin only, e.g. https://igris-api.up.railway.app',
    );
  return url.origin;
}

/**
 * Production builds carry a Content-Security-Policy that allows only this
 * site and its own backend: no third-party script, style, font, image or
 * connection can ever load, even by mistake.
 */
function csp(api: string): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self' data:",
    "img-src 'self' data:",
    `connect-src 'self'${api ? ` ${api}` : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
  return {
    name: 'igris-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
        injectTo: 'head-prepend',
      },
    ],
  };
}

/**
 * Publishes the wallet-requests test page (fixtures/wallet-requests) at
 * /demo/wallet-requests/ so a deployed IGRIS can scan a public page that
 * asks a wallet for risky signatures. Its token and spender are synthetic,
 * keyless addresses (see the page's header); it is not part of the app and
 * does not get the app's CSP (it needs its inline script).
 */
function demoPage(): Plugin {
  return {
    name: 'igris-demo-page',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'demo/wallet-requests/index.html',
        source: readFileSync(
          new URL('../../fixtures/wallet-requests/index.html', import.meta.url),
          'utf8',
        ),
      });
    },
  };
}

// Preact JSX via the automatic runtime (tsconfig: jsx react-jsx,
// jsxImportSource preact) — no Babel preset needed.
export default defineConfig(({ mode }) => {
  const api = apiOrigin(loadEnv(mode, process.cwd(), 'VITE_').VITE_IGRIS_API_URL);
  return {
    plugins: [csp(api), demoPage()],
    // The app (src/api.ts) reads exactly the origin validated above.
    define: { 'import.meta.env.VITE_IGRIS_API_URL': JSON.stringify(api) },
    server: {
      port: 5180,
      strictPort: true,
      proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
    },
    preview: { port: 5180, proxy: { '/api': { target: 'http://127.0.0.1:3001' } } },
  };
});
