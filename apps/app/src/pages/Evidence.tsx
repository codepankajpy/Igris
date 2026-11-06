/**
 * Evidence explorer for one report (a published version, or a completed scan
 * not published yet): every item of the
 * content-addressed bundle, the findings and recipients that cite it, and an
 * in-browser check that its id is the hash of its content.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  evidenceId,
  type EvidenceItem,
  type EvidenceType,
  type FindingV3,
  type Recipient,
  type WalletRequestEvidence,
} from '@igris/core/contracts';
import { go, paths, type ReportRef } from '../router.js';
import { loadReport, type ReportData } from '../report/data.js';
import { Check, ErrorNote, Loading, VerdictChip, classLabel, stamp } from '../ui.js';
import { EVIDENCE_TYPE_LABEL, evidenceTitle, locationLabel } from '../report/lookup.js';
import { Sev } from '../report/Details.js';
import {
  KIND_LABEL,
  OUTCOME_LABEL,
  PHASE_TEXT,
  amountText,
  chainName,
  deadlineText,
  flags,
  recipientRole,
} from '../report/wallet-requests.js';

export function EvidencePage({
  reportRef,
  item,
}: {
  reportRef: ReportRef;
  item?: string | undefined;
}) {
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [type, setType] = useState<EvidenceType | 'all'>('all');
  const [q, setQ] = useState('');

  useEffect(() => {
    loadReport(reportRef).then(setData, setError);
  }, [paths.report(reportRef)]);

  const cited = useMemo(() => {
    const findings = new Map<string, FindingV3[]>();
    const recipients = new Map<string, Recipient[]>();
    if (!data) return { findings, recipients };
    const all = [...data.report.privacy.findings, ...data.report.security.observations];
    const byFinding = new Map(all.map((f) => [f.id, f]));
    for (const f of all)
      for (const ref of f.evidence) findings.set(ref.id, [...(findings.get(ref.id) ?? []), f]);
    for (const r of data.report.recipients)
      for (const fid of r.findingIds)
        for (const ref of byFinding.get(fid)?.evidence ?? []) {
          const rs = recipients.get(ref.id) ?? [];
          if (!rs.includes(r)) recipients.set(ref.id, [...rs, r]);
        }
    return { findings, recipients };
  }, [data]);

  if (error)
    return (
      <div class="page" style={{ paddingTop: 56 }}>
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
        Number(cited.findings.has(b)) - Number(cited.findings.has(a)) ||
        x.type.localeCompare(y.type) ||
        evidenceTitle(x).localeCompare(evidenceTitle(y)) ||
        a.localeCompare(b),
    );
  const selectedId = item && data.evidence.items[item] ? item : shown[0]?.[0];
  const selected = selectedId ? data.evidence.items[selectedId] : undefined;
  const report = `#${paths.report(reportRef)}`;
  const { hostname } = data;

  return (
    <div class="page" style={{ paddingTop: 40 }}>
      <div class="spread rise" style={{ flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div class="crumbs mono muted small">
            <a href="#/">IGRIS</a> / <a href={`#${paths.site(hostname)}`}>{hostname}</a> /{' '}
            <a href={report}>
              {reportRef.kind === 'version' ? `v${reportRef.version}` : 'unpublished scan'}
            </a>{' '}
            / evidence
          </div>
          <h1 class="h1" style={{ marginTop: 10 }}>
            Evidence
          </h1>
        </div>
        <div class="mono muted small" style={{ textAlign: 'right', overflowWrap: 'anywhere' }}>
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
                type="button"
                class={`chip filter ${type === 'all' ? 'solid' : ''}`}
                aria-pressed={type === 'all'}
                onClick={() => setType('all')}
              >
                all {entries.length}
              </button>
              {(Object.keys(EVIDENCE_TYPE_LABEL) as EvidenceType[])
                .filter((t) => counts.has(t))
                .map((t) => (
                  <button
                    type="button"
                    key={t}
                    class={`chip filter ${type === t ? 'solid' : ''}`}
                    aria-pressed={type === t}
                    onClick={() => setType(t)}
                  >
                    {EVIDENCE_TYPE_LABEL[t].toLowerCase()} {counts.get(t)}
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
                type="button"
                key={k}
                class={`evidence-item ${k === selectedId ? 'on' : ''}`}
                aria-current={k === selectedId ? 'true' : undefined}
                onClick={() => go(paths.evidenceOf(reportRef, k), true)}
              >
                <div class="spread">
                  <span class="eyebrow">{EVIDENCE_TYPE_LABEL[i.type]}</span>
                  {cited.findings.has(k) && (
                    <span class="mono muted" style={{ fontSize: '0.68rem' }}>
                      cited ×{cited.findings.get(k)!.length}
                    </span>
                  )}
                </div>
                <div class="evidence-item-title">{evidenceTitle(i)}</div>
                <div class="mono muted" style={{ fontSize: '0.68rem' }}>
                  {k}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section class="evidence-detail" aria-label="Selected evidence item">
          {selected && selectedId ? (
            <Detail
              key={selectedId}
              id={selectedId}
              item={selected}
              findings={cited.findings.get(selectedId) ?? []}
              recipients={cited.recipients.get(selectedId) ?? []}
              data={data}
              reportHref={report}
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
  recipients,
  data,
  reportHref,
}: {
  id: string;
  item: EvidenceItem;
  findings: FindingV3[];
  recipients: Recipient[];
  data: ReportData;
  reportHref: string;
}) {
  const recomputed = useMemo(() => evidenceId(item), [item]);
  const ok = recomputed === id;
  return (
    <div class="stack" style={{ '--gap': '16px' }}>
      <div class="panel">
        <div class="eyebrow">{EVIDENCE_TYPE_LABEL[item.type]}</div>
        <h2
          class="display"
          style={{ fontSize: '1.7rem', margin: '8px 0 0', overflowWrap: 'anywhere' }}
        >
          {evidenceTitle(item)}
        </h2>
        <div style={{ marginTop: 14 }}>
          <Check
            ok={ok}
            label={
              ok
                ? 'Content id recomputed in this browser: sha256 of the canonical item matches its id'
                : `Content id mismatch: recomputed ${recomputed}`
            }
          />
        </div>
        <dl class="kv" style={{ marginTop: 18 }}>
          <Fields item={item} />
        </dl>
      </div>

      <div class="panel">
        <div class="eyebrow" style={{ marginBottom: 12 }}>
          Cited by
        </div>
        {findings.length === 0 && recipients.length === 0 ? (
          <p class="muted small" style={{ margin: 0 }}>
            No finding cites this item directly. It is part of the sealed bundle as supporting
            context (for example, a contact or how a host was classified).
          </p>
        ) : (
          <>
            {recipients.map((r) => (
              <a class="cited" key={`${r.registrableDomain}|${r.class}`} href={reportHref}>
                <VerdictChip verdict={r.verdict} />
                <span class="mono">{r.registrableDomain}</span>
                <span class="muted small">{classLabel(r.class)}</span>
              </a>
            ))}
            {findings.map((f) => (
              <a class="cited" key={f.id} href={reportHref}>
                <Sev s={f.severity} />
                <span>{f.title}</span>
                <span class="mono muted" style={{ marginLeft: 'auto', fontSize: '0.72rem' }}>
                  {f.id}
                </span>
              </a>
            ))}
          </>
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
          <dt>Published</dt>
          <dd>
            {data.scan ? (
              <>
                {data.source === 'arkiv' ? 'Arkiv' : 'this server’s store'} · v{data.scan.version} ·
                entity <span class="mono">{data.scan.key}</span>
              </>
            ) : (
              'not published yet · served from this server’s cache'
            )}
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
            {item.host} ({item.registrableDomain}) · {classLabel(item.recipientClass)}
          </dd>
          <dt>Phase</dt>
          <dd>{item.phase}</dd>
          <dt>Where</dt>
          <dd>
            {locationLabel(item.location)}
            {item.method !== '-' ? ` of a ${item.method} request` : ''}
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
          <dd>{classLabel(item.recipientClass)}</dd>
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
          {Object.entries(item.headers).flatMap(([k, v]) => [
            <dt class="mono small" key={`${k}-k`}>
              {k}
            </dt>,
            <dd class="mono small" key={`${k}-v`}>
              {v ?? <span class="muted">absent</span>}
            </dd>,
          ])}
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
    case 'wallet-request':
      return <WalletRequestFields item={item} />;
  }
}

/** A decoded wallet request: the backend's fields as recorded (no raw params exist). */
function WalletRequestFields({ item }: { item: WalletRequestEvidence }) {
  const opt = (label: string, value: string | null, mono = true) =>
    value === null
      ? []
      : [
          <dt key={`${label}-k`}>{label}</dt>,
          <dd key={`${label}-v`} class={mono ? 'mono' : ''}>
            {value}
          </dd>,
        ];
  const set = flags(item).map((f) => f.text);
  return (
    <>
      <dt>Request</dt>
      <dd>
        {KIND_LABEL[item.kind]} · <span class="mono">{item.method}</span>
      </dd>
      <dt>Asked by</dt>
      <dd class="mono">
        {item.origin} ({item.frame === 'main' ? 'the page' : 'an embedded frame'})
      </dd>
      <dt>Phase</dt>
      <dd>{PHASE_TEXT[item.phase] ?? item.phase}</dd>
      <dt>Outcome</dt>
      <dd>{OUTCOME_LABEL[item.outcome]}</dd>
      {opt(recipientRole(item.kind), item.spender)}
      {opt('Token', item.token)}
      {opt('Amount', item.amount === null && !item.unlimited ? null : amountText(item))}
      {opt('Deadline', item.deadline === null ? null : deadlineText(item.deadline, stamp), false)}
      {opt('Chain named', item.chainId === null ? null : chainName(item.chainId), false)}
      {opt('Verifying contract', item.verifyingContract)}
      {opt('Sign-in domain', item.siweDomain)}
      <dt>Flags</dt>
      <dd>{set.length ? set.join(' · ') : <span class="muted">none set</span>}</dd>
      <dt>Params digest</dt>
      <dd class="mono small">{item.paramsDigest}</dd>
    </>
  );
}
