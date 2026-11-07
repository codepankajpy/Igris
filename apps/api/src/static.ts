/**
 * The website (apps/app, built to apps/app/dist) served by the API itself, so
 * one container answers both from the same origin and the browser never
 * needs CORS.
 *
 * Rules:
 *  - /api/** is never served from disk: these handlers are mounted after
 *    every API route and skip any /api path, so a file can never shadow a
 *    route (an unknown /api path still gets the JSON 404).
 *  - express.static only: no directory listing, dotfiles ignored, no
 *    trailing-slash redirects; a path that escapes the directory ('..',
 *    encoded or not) is refused by `send` and falls through to the 404.
 *  - Cache: Vite's content-hashed /assets/* are immutable for a year;
 *    index.html is revalidated on every load (no-cache) so a deploy is
 *    picked up at once.
 *  - Website responses carry a same-origin-only Content-Security-Policy:
 *    scripts, styles, fonts and API calls ('self' only; data: for the small
 *    inline SVG/font URIs Vite emits). No third-party origin is allowed.
 */
import { join, resolve, sep } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';

export const WEBSITE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const IMMUTABLE = 'public, max-age=31536000, immutable';

function websiteHeaders(res: Response): void {
  res.setHeader('Content-Security-Policy', WEBSITE_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

/** Middleware serving the built website from `dir`; it never handles /api paths. */
export function websiteHandler(dir: string): express.RequestHandler {
  const root = resolve(dir);
  const assets = join(root, 'assets') + sep;
  const serve = express.static(root, {
    index: 'index.html',
    dotfiles: 'ignore',
    redirect: false,
    fallthrough: true,
    cacheControl: false,
    setHeaders: (res, path) => {
      websiteHeaders(res);
      res.setHeader(
        'Cache-Control',
        path.startsWith(assets)
          ? IMMUTABLE
          : path.endsWith('.html')
            ? 'no-cache'
            : 'public, max-age=3600',
      );
    },
  });
  return (req: Request, res: Response, next: NextFunction) => {
    const path = req.path.toLowerCase();
    if (path === '/api' || path.startsWith('/api/')) {
      next();
      return;
    }
    serve(req, res, next);
  };
}
