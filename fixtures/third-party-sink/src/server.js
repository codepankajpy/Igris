/**
 * The third-party sink: one local HTTP server that plays every third-party
 * role in our offline e2e tests. The browser reaches it under different
 * hostnames (rpc.igris-rpc.test, ingest.igris-analytics.test, …) because the
 * scanner launches Chromium with
 *   --host-resolver-rules=MAP *.test 127.0.0.1
 * (.test is reserved by RFC 6761, so this can never shadow a real site), and
 * the role is picked by the Host header. Nothing here ever touches the
 * internet.
 */
import { createServer } from 'node:http';

const JSON_HEADERS = { 'content-type': 'application/json' };

function corsHeaders(req) {
  return {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
    'access-control-allow-credentials': 'true',
  };
}

/** Minimal JSON-RPC answers so dapp libraries don't error out. */
function rpcAnswer(payload) {
  const one = (p) => {
    switch (p.method) {
      case 'eth_chainId':
        return { jsonrpc: '2.0', id: p.id, result: '0x1' };
      case 'eth_blockNumber':
        return { jsonrpc: '2.0', id: p.id, result: '0x1588e85' };
      case 'eth_getBalance':
        return { jsonrpc: '2.0', id: p.id, result: '0xde0b6b3a7640000' }; // 1 ETH
      case 'eth_call':
        return { jsonrpc: '2.0', id: p.id, result: '0x' };
      case 'eth_gasPrice':
        return { jsonrpc: '2.0', id: p.id, result: '0x3b9aca00' };
      default:
        return { jsonrpc: '2.0', id: p.id, result: '0x0' };
    }
  };
  return Array.isArray(payload) ? payload.map(one) : one(payload);
}

/**
 * Start the sink. Returns { server, port, requests } where `requests` records
 * { host, method, path, body } for debugging.
 */
export function startSink(port = 0) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const host = (req.headers.host ?? '').split(':')[0];
      requests.push({ host, method: req.method, path: req.url, body });

      const cors = corsHeaders(req);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }

      // Role by hostname.
      if (host.endsWith('igris-rpc.test')) {
        let payload;
        try {
          payload = JSON.parse(body || '{}');
        } catch {
          payload = { id: null, method: 'unknown' };
        }
        res.writeHead(200, { ...cors, ...JSON_HEADERS });
        res.end(JSON.stringify(rpcAnswer(payload)));
        return;
      }
      if (host.endsWith('igris-analytics.test')) {
        // Set a tracking cookie like real analytics endpoints do.
        res.writeHead(204, { ...cors, 'set-cookie': 'sink_uid=fixture; Path=/; Max-Age=86400' });
        res.end();
        return;
      }
      if (host.endsWith('igris-errors.test')) {
        res.writeHead(200, { ...cors, ...JSON_HEADERS });
        res.end(JSON.stringify({ id: 'evt_fixture' }));
        return;
      }
      if (host.endsWith('igris-chat.test')) {
        res.writeHead(200, { ...cors, 'content-type': 'application/javascript' });
        res.end('/* chat widget stub */');
        return;
      }
      if (host.endsWith('igris-cdn.test')) {
        if (req.url?.startsWith('/pixel')) {
          res.writeHead(200, { ...cors, 'content-type': 'image/gif' });
          // 1x1 transparent GIF
          res.end(
            Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
          );
          return;
        }
        res.writeHead(200, { ...cors, 'content-type': 'application/javascript' });
        res.end('/* cdn asset stub */');
        return;
      }
      res.writeHead(200, { ...cors, ...JSON_HEADERS });
      res.end('{}');
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests });
    });
  });
}

// CLI: node src/server.js [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 38545);
  startSink(port).then(({ port: p }) => {
    console.log(`third-party sink listening on 127.0.0.1:${p} (host-based roles)`);
  });
}
