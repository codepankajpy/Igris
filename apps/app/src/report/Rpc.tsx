/**
 * (d) RPC calls: every JSON-RPC endpoint the page called (report.rpc) with
 * its methods and call counts, the reads the dApp routed through the wallet,
 * and whether Anon-RPC was used. Bars are proportional to the counts given.
 */
import type { ReportV3, RpcEndpoint } from '@igris/core/contracts';
import { NotRecorded, Section, classLabel, plural } from '../ui.js';
import { phases } from './lookup.js';

function Bars({
  rows,
  caption,
  unit = 'calls',
}: {
  rows: Array<{ method: string; count: number }>;
  caption: string;
  unit?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <table class="bars-table">
      <caption class="sr-only">{caption}</caption>
      <thead class="sr-only">
        <tr>
          <th scope="col">Method</th>
          <th scope="col">{unit}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.method}>
            <th scope="row" class="mono">
              {r.method}
            </th>
            <td>
              <span class="hbar" aria-hidden="true">
                <span style={{ width: `${(r.count / max) * 100}%` }} />
              </span>
              <span class="num mono">{r.count}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Endpoint({ e }: { e: RpcEndpoint }) {
  const total = e.calls.reduce((a, c) => a + c.count, 0);
  return (
    <div class={`panel rpc-endpoint ${e.addressSeen ? 'seen' : ''}`}>
      <div class="spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <b class="mono rpc-host">{e.host}</b>
          <div class="muted small">
            {classLabel(e.class)} · {phases(e.phases)} · {plural(e.requests, 'request')} ·{' '}
            {plural(total, 'call')}
          </div>
        </div>
        <span class={`chip ${e.addressSeen ? 'solid' : ''}`}>
          {e.addressSeen ? 'wallet address in calls' : 'no address in calls'}
        </span>
      </div>
      <Bars rows={e.calls} caption={`Methods called on ${e.host}`} />
    </div>
  );
}

export function RpcSection({ report }: { report: ReportV3 }) {
  const rpc = report.rpc;
  const reads = report.wallet.readsViaWallet;
  return (
    <Section
      id="rpc"
      title="RPC calls"
      aside={rpc ? `${plural(rpc.length, 'endpoint')}` : undefined}
      lede="Which blockchain endpoints the page called, which JSON-RPC methods and how often, and whether the wallet address travelled with the calls."
    >
      <div class="grid g-2" style={{ marginBottom: 16 }}>
        <div class="panel">
          <div class="eyebrow">Anon-RPC</div>
          <div class="big-statement">
            {report.wallet.usesAnonRpc ? 'Reads routed through Anon-RPC' : 'Anon-RPC not used'}
          </div>
          <p class="muted small" style={{ margin: 0 }}>
            Anon-RPC relays reads without revealing the visitor’s IP to the RPC provider.
          </p>
        </div>
        <div class="panel">
          <div class="eyebrow">Reads routed through the wallet</div>
          {reads.length === 0 ? (
            <>
              <div class="big-statement">None</div>
              <p class="muted small" style={{ margin: 0 }}>
                The dApp sent no reads through the injected wallet.
              </p>
            </>
          ) : (
            <Bars rows={reads} caption="Reads the dApp sent through the wallet" />
          )}
        </div>
      </div>
      {rpc === null ? (
        <NotRecorded what="This version’s report predates the RPC inventory, so per-endpoint calls were not recorded." />
      ) : rpc.length === 0 ? (
        <p class="muted">The page made no JSON-RPC calls over HTTP or WebSocket.</p>
      ) : (
        <div class="grid g-2">
          {rpc.map((e) => (
            <Endpoint e={e} key={e.host} />
          ))}
        </div>
      )}
    </Section>
  );
}
