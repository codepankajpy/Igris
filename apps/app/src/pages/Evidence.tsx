/**
 * Evidence explorer: every item in the scan's content-addressed evidence
 * bundle, the findings that cite it, and an in-browser check that its id is
 * the hash of its content.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  evidenceId,
  type EvidenceItem,
  type EvidenceType,
  type FindingV2,
} from '@igris/core/contracts';
import { api, type ReportResponse, type ScanMeta } from '../api.js';
import { go } from '../router.js';
import { ErrorNote, Loading, Sev, stamp } from '../ui.js';

const TYPE_LABEL: Record<EvidenceType, string> = {
  'canary-match': 'Canary match',
  'third-party-contact': 'Third-party contact',
  'document-headers': 'Document headers',
  'contact-classification': 'Classification',
};

function headline(i: EvidenceItem): string {
  switch (i.type) {
    case 'canary-match':
      return `${i.host} · ${i.location} · ${i.encoding}`;
    case 'third-party-contact':
      return `${i.host} · ${i.phases.join(' + ')}`;
    case 'document-headers':
      return `${i.documentUrl} · HTTP ${i.status}`;
    case 'contact-classification':
      return `${i.host} → ${i.relationship}`;
  }
}

export function EvidenceExplorer({ id, item }: { id: string; item?: string | undefined }) {
  const [data, setData] = useState<(Omit<ReportResponse, 'scan'> & { scan: ScanMeta }) | null>(
    null,
  );
  const [error, setError] = useState<unknown>(null);
  const [type, setType] = useState<EvidenceType | 'all'>('all');
  const [q, setQ] = useState('');

  useEffect(() => {
    Promise.all([api.get(id), api.report(id)]).then(
      ([scan, r]) => setData({ ...r, scan }),
      setError,
    );
  }, [id]);

  const citedBy = useMemo(() => {
    const m = new Map<string, FindingV2[]>();
    if (!data) return m;
    for (const f of [...data.report.privacy.findings, ...data.report.security.observations])
      for (const ref of f.evidence) m.set(ref.id, [...(m.get(ref.id) ?? []), f]);
    return m;
  }, [data]);

  if (error)
    return (
      <div class="page" style={{ paddingTop: 64 }}>
        <ErrorNote error={error} />
      </div>
    );
  if (!data) return <Loading label="Loading evidence" />;

  const entries = Object.entries(data.evidence.items);
  const counts = new Map<string, number>();
  for (const [, i] of entries) counts.set(i.type, (counts.get(i.type) ?? 0) + 1);
  const needle = q.trim().toLowerCase();
  const shown = entries
    .filter(([, i]) => type === 'all' || i.type === type)
    .filter(
      ([k, i]) => !needle || k.includes(needle) || JSON.stringify(i).toLowerCase().includes(needle),
    )
    .sort(
      ([a, x], [b, y]) =>
        Number(citedBy.has(b)) - Number(citedBy.has(a)) ||
        x.type.localeCompare(y.type) ||
        headline(x).localeCompare(headline(y)) ||
        a.localeCompare(b),
    );
  const selectedId = item && data.evidence.items[item] ? item : shown[0]?.[0];
  const selected = selectedId ? data.evidence.items[selectedId] : undefined;

  return (
    <div class="page" style={{ paddingTop: 40 }}>
      <div class="spread rise" style={{ flexWrap: 'wrap' }}>
        <div>
          <div class="crumbs mono muted">
            <a href="#/history">Scans</a> / <a href={`#/scans/${id}`}>{data.scan.hostname}</a> /
            evidence
          </div>
          <h1 class="h1" style={{ marginTop: 10 }}>
            Evidence explorer
          </h1>
        </div>
        <div class="mono muted small" style={{ textAlign: 'right' }}>
          {data.report.evidence.bundleVersion} · {entries.length} items
          <br />
          sha256 {data.report.evidence.sha256.slice(0, 20)}…
        </div>
      </div>

      <div class="evidence-layout rise d1">
        <aside class="evidence-list panel flush">
          <div class="evidence-filters">
            <input
              class="input"
              placeholder="Search host, id, encoding…"
              value={q}
              onInput={(e) => setQ((e.target as HTMLInputElement).value)}
              aria-label="Search evidence"
            />
            <div class="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              <button
                class={`chip filter ${type === 'all' ? 'solid' : ''}`}
                onClick={() => setType('all')}
              >
                all {entries.length}
              </button>
              {(Object.keys(TYPE_LABEL) as EvidenceType[])
                .filter((t) => counts.has(t))
                .map((t) => (
                  <button
                    key={t}
                    class={`chip filter ${type === t ? 'solid' : ''}`}
                    onClick={() => setType(t)}
                  >
                    {t} {counts.get(t)}
                  </button>
                ))}
            </div>
          </div>
          <div class="evidence-items">
            {shown.length === 0 && (
              <div class="muted small" style={{ padding: 16 }}>
                No items match.
              </div>
            )}
            {shown.map(([k, i]) => (
              <button
                key={k}
                class={`evidence-item ${k === selectedId ? 'on' : ''}`}
                onClick={() => go(`/scans/${id}/evidence/${k}`)}
              >
                <div class="spread">
                  <span class="eyebrow">{TYPE_LABEL[i.type]}</span>
                  {citedBy.has(k) && (
                    <span class="mono muted" style={{ fontSize: '0.68rem' }}>
                      cited ×{citedBy.get(k)!.length}
                    </span>
                  )}
                </div>
                <div class="evidence-item-title">{headline(i)}</div>
                <div class="mono muted" style={{ fontSize: '0.68rem' }}>
                  {k}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section class="evidence-detail">
          {selected && selectedId ? (
            <Detail
              key={selectedId}
              id={selectedId}
              item={selected}
              findings={citedBy.get(selectedId) ?? []}
              data={data}
            />
          ) : (
            <div class="panel muted">Select an item.</div>
          )}
        </section>
      </div>
    </div>
  );
}

function Detail({
  id,
  item,
  findings,
  data,
}: {
  id: string;
  item: EvidenceItem;
  findings: FindingV2[];
  data: Omit<ReportResponse, 'scan'> & { scan: ScanMeta };
}) {
  const recomputed = useMemo(() => evidenceId(item), [item]);
  const ok = recomputed === id;
  return (
    <div class="stack" style={{ '--gap': '16px' }}>
      <div class="panel">
        <div class="spread" style={{ alignItems: 'flex-start' }}>
          <div>
            <div class="eyebrow">{TYPE_LABEL[item.type]}</div>
            <h2
              class="display"
              style={{ fontSize: '1.8rem', margin: '8px 0 0', overflowWrap: 'anywhere' }}
            >
              {headline(item)}
            </h2>
          </div>
        </div>
        <div class={`check ${ok ? 'ok' : 'bad'}`} style={{ marginTop: 16 }}>
          <span class="check-mark">{ok ? '✓' : '×'}</span>
          {ok
            ? 'Content id recomputed in this browser: sha256 of the canonical item matches its id'
            : `Content id mismatch: recomputed ${recomputed}`}
        </div>
        <dl class="kv" style={{ marginTop: 18 }}>
          <Fields item={item} />
        </dl>
      </div>

      <div class="panel">
        <div class="eyebrow" style={{ marginBottom: 12 }}>
          Cited by
        </div>
        {findings.length === 0 ? (
          <p class="muted small" style={{ margin: 0 }}>
            No finding cites this item directly. It is part of the sealed bundle as supporting
            context (for example, a contact that did not change the score).
          </p>
        ) : (
          findings.map((f) => (
            <a class="cited" key={f.id} href={`#/scans/${data.scan.id}`}>
              <Sev s={f.severity} />
              <span>{f.title}</span>
              <span class="mono muted" style={{ marginLeft: 'auto', fontSize: '0.72rem' }}>
                {f.id}
              </span>
            </a>
          ))
        )}
      </div>

      <div class="panel">
        <div class="eyebrow" style={{ marginBottom: 12 }}>
          Provenance
        </div>
        <dl class="kv">
          <dt>Evidence id</dt>
          <dd class="mono">{id}</dd>
          <dt>Bundle</dt>
          <dd class="mono">
            {data.report.evidence.bundleVersion} · sha256 {data.report.evidence.sha256}
          </dd>
          <dt>Captured</dt>
          <dd>
            {stamp(data.report.scan.scannedAt)} by igris-scanner {data.report.scan.scannerVersion}{' '}
            (egress {data.report.scan.egress})
          </dd>
          <dt>Capture</dt>
          <dd class="muted">
            Extracted from the browser capture of this scan. The raw capture is not retained; this
            item is its content-addressed extract.
          </dd>
        </dl>
      </div>

      <div class="panel flush">
        <div class="spread" style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <span class="eyebrow">Item JSON</span>
        </div>
        <pre class="json">{JSON.stringify(item, null, 2)}</pre>
      </div>
    </div>
  );
}

function Fields({ item }: { item: EvidenceItem }) {
  switch (item.type) {
    case 'canary-match':
      return (
        <>
          <dt>Recipient</dt>
          <dd class="mono">
            {item.host} ({item.registrableDomain}) · {item.recipientClass}
          </dd>
          <dt>Phase</dt>
          <dd>{item.phase}</dd>
          <dt>Where</dt>
          <dd>
            {item.location} of a {item.method} request
          </dd>
          <dt>Encoding</dt>
          <dd class="mono">
            {item.encoding} · {item.category}
          </dd>
          <dt>URL</dt>
          <dd class="mono small">{item.url}</dd>
          <dt>Snippet</dt>
          <dd>
            <code class="snippet">{item.snippet}</code>
          </dd>
        </>
      );
    case 'third-party-contact':
      return (
        <>
          <dt>Host</dt>
          <dd class="mono">
            {item.host} ({item.registrableDomain})
          </dd>
          <dt>Class</dt>
          <dd>{item.recipientClass}</dd>
          <dt>Phases</dt>
          <dd>{item.phases.join(', ')}</dd>
          <dt>Methods</dt>
          <dd class="mono">{item.methods.join(', ') || '—'}</dd>
          <dt>Resources</dt>
          <dd class="mono">{item.resourceTypes.join(', ') || '—'}</dd>
        </>
      );
    case 'document-headers':
      return (
        <>
          <dt>Document</dt>
          <dd class="mono small">{item.documentUrl}</dd>
          <dt>Status</dt>
          <dd class="mono">{item.status}</dd>
          {Object.entries(item.headers).map(([k, v]) => (
            <>
              <dt class="mono small">{k}</dt>
              <dd class="mono small">{v ?? <span class="muted">absent</span>}</dd>
            </>
          ))}
        </>
      );
    case 'contact-classification':
      return (
        <>
          <dt>Host</dt>
          <dd class="mono">
            {item.host} ({item.registrableDomain})
          </dd>
          <dt>Relationship</dt>
          <dd>
            {item.relationship} · confidence {item.confidence}
          </dd>
          <dt>Rule</dt>
          <dd class="mono">{item.rule}</dd>
          <dt>Basis</dt>
          <dd>
            {item.basis.map((b, i) => (
              <div key={i}>
                <span class="mono muted">{b.kind}</span> {b.detail}
              </div>
            ))}
          </dd>
        </>
      );
  }
}
