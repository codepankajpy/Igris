/**
 * Entry point of the IGRIS backend.
 *
 * Development: `pnpm --filter @igris/api dev`; production:
 * `pnpm --filter @igris/api start` (workspace packages resolve to their
 * compiled dist/ under the igris-dist condition). Both pass Node's
 * --env-file-if-exists=../../.env.arkiv so ARKIV_ACCESS_KEY reaches
 * process.env without this code ever reading the file.
 *
 * Logs never carry an address (this node's or a trusted scanner's).
 */
import { scan, isPublicAddress } from '@igris/scanner';
import {
  ArkivSiteRegistry,
  LocalSiteRegistry,
  diffVersions,
  listScanners,
  loadScanner,
} from '@igris/registry';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { JobQueue } from './limits.js';
import { SiteScanService } from './jobs.js';
import { createRegistry } from './registry.js';

const log = (m: string) => console.log(`[igris-api] ${m}`);
const config = loadConfig();

const { registry, info } = createRegistry(process.env, config.dataDir, {
  listScanners: () => listScanners(),
  loadScanner: (o) => loadScanner(o),
  local: (o) => new LocalSiteRegistry(o),
  arkiv: (o) => new ArkivSiteRegistry(o),
});

const jobs = new SiteScanService({
  dataDir: config.dataDir,
  queue: new JobQueue(config.concurrency, config.maxQueued, config.jobTimeoutMs),
  scan,
  registry,
  // Not configurable by requests: every scan is public-only.
  egress: { mode: 'public-only', allowedPorts: config.allowedPorts },
  dwellMs: config.dwellMs,
  chromiumSandbox: config.chromiumSandbox,
  log,
});

const app = createApp(config, {
  registry,
  registryInfo: info,
  jobs,
  isPublicAddress,
  diffVersions,
  log,
});

const server = app.listen(config.port, () => {
  log(
    `listening on :${config.port} — registry ${info.mode} (${info.network}), ` +
      `${info.publisher !== null ? 'publishing' : 'read-only'}, ${info.ready ? 'ready' : `NOT READY: ${info.reason ?? ''}`}; ` +
      `${info.trustedOwners.length} trusted scanner(s); egress public-only; concurrency ${config.concurrency}; ` +
      `chromium sandbox ${config.chromiumSandbox ? 'on' : 'off'}; origins ${config.allowedOrigins.join(' ')}; ` +
      `website ${config.staticDir !== null ? `served from ${config.staticDir}` : 'not served (API only)'}`,
  );
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log(`${signal}: shutting down`);
  const force = setTimeout(() => process.exit(0), 5_000);
  force.unref();
  server.close(() => process.exit(0));
  // Open SSE streams would hold close() forever.
  server.closeAllConnections();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
