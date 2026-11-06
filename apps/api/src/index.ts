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
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const app = createApp(config, { scan, fix, recordFromReport, isPublicAddress });

app.listen(config.port, () => {
  console.log(
    `[igris-api] listening on :${config.port} (egress public-only, concurrency ${config.concurrency}, ` +
      `origins ${config.allowedOrigins.join(' ')})`,
  );
});
