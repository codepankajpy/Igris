/**
 * Entry point for the optional hosted scanner node. Local/Docker use only
 * until every P0 acceptance criterion passes (docs/ROADMAP.md).
 *
 * Production start: `node --conditions=igris-dist apps/api/dist/index.js`
 * (workspace packages resolve to their compiled dist/ under that condition).
 */
import { scan, isPublicAddress } from '@igris/scanner';
import { fix } from '@igris/patcher';
import { recordFromReport } from '@igris/registry';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { JobQueue } from './limits.js';
import { ScanService } from './scans.js';

const config = loadConfig();
// Scan history lives on the operator's machine only (see docs/ENGINEERING_LOG.md).
const dataDir = resolve(process.env.IGRIS_DATA_DIR ?? '.igris-data');
const scans = new ScanService({
  dataDir,
  queue: new JobQueue(config.concurrency, config.maxQueued, config.jobTimeoutMs),
  scan,
  // Not configurable by requests: hosted scans are public-only.
  scanDefaults: { egress: { mode: 'public-only', allowedPorts: config.allowedPorts } },
  log: (m) => console.log(`[igris-api] ${m}`),
});
const app = createApp(config, { scan, fix, recordFromReport, isPublicAddress, scans });

app.listen(config.port, () => {
  console.log(
    `[igris-api] listening on :${config.port} (egress public-only, concurrency ${config.concurrency}, ` +
      `origins ${config.allowedOrigins.join(' ')})`,
  );
});
