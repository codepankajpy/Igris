/**
 * Agreement panel: for a round with two or more scans (one request fulfilled
 * by several scanner nodes), the API's per-recipient comparison — GET
 * /api/sites/:hostname/rounds/:requestKey, fetched only when the panel comes
 * near the viewport. Status, verdicts and addresses are the API's; nodes are
 * shown by their labels, never addresses; each scan links to its entity.
 * Once the request entity has expired the API sends request: null — the
 * scans and the comparison still come back, and the panel says so.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type Agreement, type RoundResponse } from '../api.js';
import { ExplorerLink } from '../explorer.js';
import { paths } from '../router.js';
import {
  ADDRESS_LABEL,
  ErrorNote,
  VerdictChip,
  addressReachedTracker,
  classLabel,
  plural,
  short,
  stamp,
} from '../ui.js';
import { AGREEMENT_EXPLAINED, REQUEST_EXPIRED, nodeLabel, statusText } from '../rounds.js';

/** Rounds are immutable once loaded for this page view: cache per (hostname, request). */
const roundCache = new Map<string, Promise<RoundResponse>>();
function loadRound(hostname: string, key: string): Promise<RoundResponse> {
  const k = `${hostname}|${key}`;
  let p = roundCache.get(k);
  if (!p) {
    p = api.round(hostname, key);
    p.catch(() => roundCache.delete(k));
    roundCache.set(k, p);
  }
  return p;
}

/** Fetch when the panel scrolls near the viewport (at once without IntersectionObserver). */
function useLazyRound(hostname: string, requestKey: string) {
  const ref = useRef<HTMLElement>(null);
  const [data, setData] = useState<RoundResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    const load = () =>
      loadRound(hostname, requestKey).then(
        (d) => live && setData(d),
        (e) => live && setError(e),
      );
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      void load();
      return () => {
        live = false;
      };
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect();
          void load();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [hostname, requestKey]);
  return { ref, data, error };
}

const STATUS_CLASS: Record<Agreement['rows'][number]['status'], string> = {
  agree: 'st-agree',
  differ: 'st-differ',
  partial: 'st-partial',
};

export function AgreementPanel({
  hostname,
  requestKey,
  scanners,
}: {
  hostname: string;
  requestKey: string;
  /** How many scans the round lists (from GET /api/sites/:hostname). */
  scanners: number;
}) {
  const { ref, data, error } = useLazyRound(hostname, requestKey);
  return (
    <section class="panel agreement rise d1" ref={ref} aria-labelledby="agreement-h">
      <div class="panel-head" style={{ flexWrap: 'wrap' }}>
        <h2 class="h2" id="agreement-h">
          Agreement · {plural(scanners, 'scan')} of one request
        </h2>
        <span class="muted small">compared by the API, per third party</span>
      </div>
      <p class="muted small agreement-why">{AGREEMENT_EXPLAINED}</p>
      {error ? (
        <ErrorNote error={error} />
      ) : !data ? (
        <div class="row muted small" role="status" style={{ padding: '12px 0' }}>
          <span class="spinner" /> Loading the comparison
        </div>
      ) : (
        <RoundBody hostname={hostname} data={data} />
      )}
    </section>
  );
}

function RoundBody({ hostname, data }: { hostname: string; data: RoundResponse }) {
  const { request, scans, agreement } = data;
  return (
    <>
      <dl class="kv agreement-request">
        <dt>Request</dt>
        {request === null ? (
          <dd class="muted agreement-expired">{REQUEST_EXPIRED}</dd>
        ) : (
          <dd>
            <span class="mono">{request.url}</span> · asked {stamp(request.requestedAt)}{' '}
            <ExplorerLink kind="entity" value={request.key}>
              request entity
            </ExplorerLink>
          </dd>
        )}
      </dl>
      <ul class="agreement-scans" aria-label="Scans of this request">
        {scans.map((s) => (
          <li key={s.scan.key}>
            <span class="chip node-chip">{nodeLabel(s.node)}</span>
            <a class="link mono" href={`#${paths.version(hostname, s.scan.version)}`}>
              v{s.scan.version}
            </a>
            <span class="muted small">{stamp(s.scan.scannedAt)}</span>
            <span class={`small ${s.verified ? '' : 'agreement-unverified'}`}>
              {s.verified ? 'verified ✓' : '× not verified'}
            </span>
            <ExplorerLink kind="entity" value={s.scan.key}>
              <span class="mono">entity {short(s.scan.key, 8, 6)}</span>
            </ExplorerLink>
          </li>
        ))}
      </ul>
      {agreement === null ? (
        <p class="muted small">
          The API returned no comparison for this request, so none is shown.
        </p>
      ) : (
        <AgreementTable agreement={agreement} />
      )}
    </>
  );
}

function AgreementTable({ agreement }: { agreement: Agreement }) {
  const { nodes, rows, summary } = agreement;
  return (
    <>
      <div class="agreement-summary" role="list" aria-label="Comparison summary">
        <span role="listitem" class="chip st-agree">
          <b class="num">{summary.agree}</b> agree
        </span>
        <span role="listitem" class="chip st-differ">
          <b class="num">{summary.differ}</b> differ
        </span>
        <span role="listitem" class="chip st-partial">
          <b class="num">{summary.partial}</b> seen by only some scanners
        </span>
      </div>
      {rows.length === 0 ? (
        <p class="muted small">No third party was seen by any of these scans.</p>
      ) : (
        <div
          class="table-wrap agreement-table"
          tabIndex={0}
          role="region"
          aria-label="Agreement per third party (scrollable)"
        >
          <table class="table">
            <caption class="sr-only">
              Third parties seen by each scanner node, with each node’s verdict and what it saw of
              the address
            </caption>
            <thead>
              <tr>
                <th scope="col">Third party</th>
                <th scope="col">Status</th>
                {nodes.map((n) => (
                  <th scope="col" key={n}>
                    {nodeLabel(n)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.registrableDomain}|${r.class}`}>
                  <td>
                    <b class="mono">{r.registrableDomain}</b>
                    <div class="muted small">{classLabel(r.class)}</div>
                  </td>
                  <td>
                    <span class={`chip ${STATUS_CLASS[r.status]}`}>{statusText(r, nodes)}</span>
                  </td>
                  {nodes.map((n) => {
                    const v = r.byNode[n] ?? null;
                    return (
                      <td key={n}>
                        {v === null ? (
                          <span class="muted small">not seen</span>
                        ) : (
                          <div class="agreement-cell">
                            <VerdictChip verdict={v.verdict} />
                            <span
                              class={`small ${
                                addressReachedTracker(v.verdict, v.address) ? 'signal-text' : 'dim'
                              }`}
                            >
                              {ADDRESS_LABEL[v.address]}
                            </span>
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
