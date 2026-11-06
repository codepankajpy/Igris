/**
 * One report: a published version, or a completed scan not published yet
 * (served from the server's cache). Every number, verdict and sentence comes
 * from the backend (the report, its evidence, summarise(), the registry
 * entity and its verification). The browser only draws them and re-checks
 * the hashes of what it received.
 */
import { ExplorerLink, networkLabel } from '../explorer.js';
import { useMemo } from 'preact/hooks';
import type { Verdict } from '@igris/core/contracts';
import type { RegistryInfo } from '../api.js';
import type { ReportData } from '../report/data.js';
import { onArkiv, proofStatus, provenance } from '../wording.js';
import { paths } from '../router.js';
import { AddressFlow } from '../charts/AddressFlow.js';
import { TrafficChart } from '../charts/TrafficChart.js';
import { VisitTimeline } from '../charts/VisitTimeline.js';
import {
  NotRecorded,
  Section,
  StateChip,
  VERDICT,
  VERDICT_ORDER,
  plural,
  short,
  stamp,
} from '../ui.js';
import { buildLookup } from '../report/lookup.js';
import { RecipientsSection } from '../report/Recipients.js';
import { RpcSection } from '../report/Rpc.js';
import {
  ChangesSection,
  FindingsSection,
  IntegritySection,
  NetworkSection,
  ScanRunSection,
  SecuritySection,
  WalletSection,
} from '../report/Details.js';

const NAV: Array<[string, string]> = [
  ['timeline', 'Timeline'],
  ['traffic', 'Traffic'],
  ['address', 'Address'],
  ['rpc', 'RPC'],
  ['recipients', 'Who learned what'],
  ['changes', 'Changes'],
  ['findings', 'Findings'],
  ['wallet', 'Wallet'],
  ['network', 'Network'],
  ['security', 'Security'],
  ['integrity', 'Integrity'],
  ['run', 'Scan run'],
];

/** Scroll to a section without touching the hash (the hash is the route). */
function jump(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  const h = el.querySelector<HTMLElement>('h2');
  if (h) {
    h.tabIndex = -1;
    h.focus({ preventScroll: true });
  }
}

export function ReportView({
  data,
  registry,
}: {
  data: ReportData;
  registry: RegistryInfo | null;
}) {
  const { report, summary, scan } = data;
  const lookup = useMemo(() => buildLookup(report, data.evidence), [report, data.evidence]);
  const counts = useMemo(() => {
    const c: Record<Verdict, number> = { unidentified: 0, tracking: 0, avoidable: 0, expected: 0 };
    for (const r of report.recipients) c[r.verdict] += 1;
    return c;
  }, [report]);
  const evidenceHref = (id: string) => `#${paths.evidenceOf(data.ref, id)}`;
  const timeline = report.timeline;
  const alarm = summary.state === 'address-to-trackers';

  return (
    <article class="report">
      {/* ---------------------------------------------------------- hero */}
      <header class={`panel report-hero rise ${alarm ? 'alarm' : ''}`}>
        <div class="report-hero-light" aria-hidden="true" />
        <div class="report-hero-text">
          <div class="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <StateChip state={summary.state} />
            <span class="chip">{scan ? `v${scan.version}` : 'not published'}</span>
            <span class="chip">{stamp(scan ? scan.scannedAt : report.scan.scannedAt)}</span>
            {report.privacy.coverage === 'pre-connect-only' && (
              <span class="chip">before connecting only</span>
            )}
          </div>
          <h2 class="display report-headline">{summary.headline}</h2>
          <ul class="points">
            {summary.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {summary.caveats.length > 0 && (
            <ul class="points caveats small">
              {summary.caveats.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
        <div class="counters" role="list" aria-label="Third parties by verdict">
          {VERDICT_ORDER.slice()
            .reverse()
            .map((v) => (
              <div class={`counter v-${v}`} role="listitem" key={v}>
                <div class="counter-k num">{counts[v]}</div>
                <div class="counter-l">
                  <span class="v-mark" aria-hidden="true" />
                  {VERDICT[v].label}
                </div>
                <div class="counter-s">{VERDICT[v].meaning}</div>
              </div>
            ))}
        </div>
        <ProofChip data={data} registry={registry} />
      </header>

      <nav class="report-nav" aria-label="Report sections">
        {NAV.map(([id, label]) => (
          <button type="button" key={id} onClick={() => jump(id)}>
            {label}
          </button>
        ))}
      </nav>

      {/* ---------------------------------------------------------- charts */}
      <Section
        id="timeline"
        title="Timeline of the visit"
        aside={timeline ? `${plural(timeline.milestones.length, 'milestone')}` : undefined}
        lede="When each third party was first contacted, and when it first received the wallet address, from the moment the page started loading."
      >
        {timeline ? (
          <VisitTimeline report={report} timeline={timeline} />
        ) : (
          <NotRecorded what="This version’s report has no timing data (it was produced before the timeline was recorded), so the visit cannot be drawn over time." />
        )}
      </Section>

      <Section
        id="traffic"
        title="Traffic"
        lede="Requests per second to the site itself and to third parties, with the moments the wallet was connected."
      >
        {timeline ? (
          <TrafficChart timeline={timeline} />
        ) : (
          <NotRecorded what="Requests per second were not recorded for this version." />
        )}
      </Section>

      <Section
        id="address"
        title="Where the address went"
        aside={plural(
          report.recipients.filter(
            (r) => r.learned.address === 'exact' || r.learned.address === 'hashed',
          ).length,
          'recipient',
        )}
      >
        <AddressFlow report={report} hostname={data.hostname} lookup={lookup} />
      </Section>

      <RpcSection report={report} />
      <RecipientsSection
        report={report}
        hostname={data.hostname}
        evidenceHref={evidenceHref}
        lookup={lookup}
      />
      <ChangesSection changes={data.changes} version={scan ? scan.version : null} />
      <FindingsSection
        findings={report.privacy.findings}
        evidenceHref={evidenceHref}
        title="Privacy findings"
      />
      <WalletSection data={data} />
      <NetworkSection data={data} />
      <SecuritySection data={data} evidenceHref={evidenceHref} />
      <IntegritySection data={data} />
      <ScanRunSection data={data} />
    </article>
  );
}

/**
 * Where the report came from and whether the backend verified it. Problems
 * are always counted and listed — never folded into a check mark.
 */
function ProofChip({ data, registry }: { data: ReportData; registry: RegistryInfo | null }) {
  const { scan, problems } = data;
  const where = provenance(data, registry?.mode);
  const status = proofStatus(data);
  const entity = scan
    ? `entity ${short(scan.key, 8, 6)} · v${scan.version}`
    : 'no registry entity yet';
  return (
    <>
      <button
        type="button"
        class={`proof ${status.ok ? 'ok' : 'bad'}`}
        onClick={() => jump('integrity')}
        aria-label={`${where}. ${
          scan ? `Version ${scan.version}, entity ${scan.key}.` : 'Not a published version.'
        } ${status.text}. Show integrity details.`}
      >
        <span class="proof-mark" aria-hidden="true">
          {status.ok ? '✓' : '×'}
        </span>
        <span class="proof-text">
          <b>{where}</b>
          {onArkiv(data, registry?.mode) && registry?.network ? (
            <span class="muted"> · {networkLabel(registry.network)}</span>
          ) : null}
          <span class="proof-meta mono">
            {entity} · {status.text}
          </span>
        </span>
      </button>
      {scan && onArkiv(data, registry?.mode) && (
        <div class="proof-links small">
          <ExplorerLink kind="entity" value={scan.key}>
            See this version on the Arkiv explorer
          </ExplorerLink>
        </div>
      )}
      {problems.length > 0 && (
        <ul class="points small proof-problems" aria-label="Verification problems">
          {problems.map((p) => (
            <li key={p} class="mono">
              {p}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
