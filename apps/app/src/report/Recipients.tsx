/**
 * (e) Who learned what: report.recipients grouped by the backend's verdict,
 * each with what it learned, the backend's reason, evidence links (strongest
 * first) and — fetched lazily — the other scanned sites that send it data.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Recipient, ReportV3 } from '@igris/core/contracts';
import { api, type FlowEntity } from '../api.js';
import { paths } from '../router.js';
import {
  ADDRESS_LABEL,
  Section,
  VERDICT,
  VERDICT_ORDER,
  VerdictChip,
  addressToTracker,
  classLabel,
} from '../ui.js';
import { ipText } from '../wording.js';
import { EVIDENCE_TYPE_LABEL, phases, type Lookup } from './lookup.js';

const flowsCache = new Map<string, Promise<FlowEntity[]>>();
function flowsTo(domain: string): Promise<FlowEntity[]> {
  let p = flowsCache.get(domain);
  if (!p) {
    p = api.flowsTo(domain);
    p.catch(() => flowsCache.delete(domain));
    flowsCache.set(domain, p);
  }
  return p;
}

/** Fetch when the card scrolls near the viewport (or at once without IntersectionObserver). */
function useOtherSites(domain: string, hostname: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [sites, setSites] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      flowsTo(domain).then(
        (fs) => {
          if (!live) return;
          setSites([...new Set(fs.map((f) => f.hostname))].filter((h) => h !== hostname).sort());
        },
        () => live && setFailed(true),
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
  }, [domain, hostname]);
  return { ref, sites, failed };
}

function OtherSites({ domain, hostname }: { domain: string; hostname: string }) {
  const { ref, sites, failed } = useOtherSites(domain, hostname);
  return (
    <div ref={ref} class="other-sites small">
      {failed ? (
        <span class="muted">Other scanned sites: unavailable.</span>
      ) : sites === null ? (
        <span class="muted">Checking other scanned sites…</span>
      ) : sites.length === 0 ? (
        <span class="muted">Not seen on any other scanned site.</span>
      ) : (
        <span>
          Also on <b class="num">{sites.length}</b> other scanned site
          {sites.length === 1 ? '' : 's'}:{' '}
          {sites.slice(0, 6).map((h, i) => (
            <span key={h}>
              {i > 0 && ', '}
              <a class="link" href={`#${paths.site(h)}`}>
                {h}
              </a>
            </span>
          ))}
          {sites.length > 6 && ` and ${sites.length - 6} more`}
        </span>
      )}
    </div>
  );
}

function RecipientCard({
  r,
  hostname,
  evidenceHref,
  lookup,
}: {
  r: Recipient;
  hostname: string;
  evidenceHref: (id: string) => string;
  lookup: Lookup;
}) {
  const evidence = lookup.evidenceFor(r);
  const alarm = addressToTracker(r);
  return (
    <article class={`panel recipient v-${r.verdict} ${alarm ? 'signal' : ''}`}>
      <div class="spread" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <h3 class="recipient-domain mono">{r.registrableDomain}</h3>
          <div class="muted small">{classLabel(r.class)}</div>
        </div>
        <VerdictChip verdict={r.verdict} />
      </div>
      <div class="hosts">
        {r.hosts.map((h) => (
          <code key={h}>{h}</code>
        ))}
      </div>
      <dl class="learned">
        <div class={alarm ? 'signal-text' : ''}>
          <dt>Address</dt>
          <dd>
            {ADDRESS_LABEL[r.learned.address]}
            {r.learned.addressPhases.length > 0 && ` · ${phases(r.learned.addressPhases)}`}
          </dd>
        </div>
        <div>
          <dt>IP</dt>
          <dd>{ipText(r)}</dd>
        </div>
      </dl>
      <p class="reason">
        {r.reason} <span class="mono muted rule">{r.rule}</span>
      </p>
      {evidence.length > 0 && (
        <div class="ev-links">
          {evidence.slice(0, 5).map(({ id, item }) => (
            <a key={id} class="chip evidence-link" href={evidenceHref(id)} title={id}>
              {EVIDENCE_TYPE_LABEL[item.type]}
              {item.type === 'canary-match' ? ` · ${item.category}` : ''} →
            </a>
          ))}
          {evidence.length > 5 && <span class="muted small">+{evidence.length - 5} more</span>}
        </div>
      )}
      <OtherSites domain={r.registrableDomain} hostname={hostname} />
    </article>
  );
}

export function RecipientsSection({
  report,
  hostname,
  evidenceHref,
  lookup,
}: {
  report: ReportV3;
  hostname: string;
  evidenceHref: (id: string) => string;
  lookup: Lookup;
}) {
  const groups = VERDICT_ORDER.map((v) => ({
    v,
    rs: report.recipients.filter((r) => r.verdict === v),
  }));
  return (
    <Section
      id="recipients"
      title="Who learned what"
      aside={`${report.recipients.length} third parties`}
      lede="Every third party the page contacted, what it learned about the visitor, and why IGRIS put it in its group."
    >
      {report.recipients.length === 0 ? (
        <p class="muted">The page contacted no third party.</p>
      ) : (
        groups
          .filter((g) => g.rs.length)
          .map((g) => (
            <div class="verdict-group" key={g.v}>
              <div class={`verdict-group-head v-${g.v}`}>
                <span class="v-mark" aria-hidden="true" />
                <h3 class="h2">{VERDICT[g.v].label}</h3>
                <span class="muted small">
                  {g.rs.length} · {VERDICT[g.v].meaning}
                </span>
              </div>
              <div class="grid g-2">
                {g.rs.map((r) => (
                  <RecipientCard
                    key={`${r.registrableDomain}|${r.class}`}
                    r={r}
                    hostname={hostname}
                    evidenceHref={evidenceHref}
                    lookup={lookup}
                  />
                ))}
              </div>
            </div>
          ))
      )}
    </Section>
  );
}
