/**
 * (a) Timeline of the visit: x = seconds since navigation start; scan
 * milestones as vertical lines; one row per recipient grouped by the
 * backend's verdict, a dot at its first contact and a diamond at the first
 * request that carried the address. Rows are buttons: focus or click one to
 * read its details. What the page asked the wallet (report.walletRequests)
 * is a row of triangle markers, each a focusable button. All values come
 * from report.timeline / report.recipients / report.walletRequests.
 */
import { useState } from 'preact/hooks';
import type {
  FindingV3,
  Recipient,
  ReportV3,
  Timeline,
  WalletRequestSummary,
} from '@igris/core/contracts';
import {
  MILESTONE_LABEL,
  VERDICT,
  VERDICT_ORDER,
  VerdictChip,
  addressToTracker,
  classLabel,
  secs,
} from '../ui.js';
import {
  ChartFrame,
  LegendItem,
  SrTable,
  labelRows,
  tickLabel,
  ticks,
  useWidth,
} from './common.js';
import {
  KIND_LABEL,
  OUTCOME_LABEL,
  PHASE_TEXT,
  flags,
  findingsOf,
  findingsText,
  hasRisk,
  markerLabel,
  markerLanes,
} from '../report/wallet-requests.js';

interface Row {
  r: Recipient;
  contact: number | null;
  address: number | null;
}

const key = (x: { registrableDomain: string; class: string }) =>
  `${x.registrableDomain}|${x.class}`;

/** Vertical distance between lanes of wallet-request markers that would overlap. */
const LANE_PX = 14;

export function VisitTimeline({
  report,
  timeline,
  findings = new Map(),
}: {
  report: ReportV3;
  timeline: Timeline;
  /** Findings by id (to show a wallet request's findings and mark risky ones). */
  findings?: ReadonlyMap<string, FindingV3>;
}) {
  const [sel, setSel] = useState<string | null>(null);
  const wallet = (report.walletRequests ?? []).map((r, i) => ({ r, i }));
  const timedWallet = wallet.filter((x) => x.r.t !== null);
  const times = new Map(timeline.recipients.map((t) => [key(t), t]));
  const rows: Row[] = report.recipients.map((r) => {
    const t = times.get(key(r));
    return { r, contact: t?.firstContactMs ?? null, address: t?.firstAddressMs ?? null };
  });
  const maxT = Math.max(
    1000,
    timeline.requestsPerSecond.length * 1000,
    ...timeline.milestones.map((m) => m.t),
    ...rows.flatMap((x) => [x.contact ?? 0, x.address ?? 0]),
    ...timedWallet.map((x) => x.r.t ?? 0),
  );
  const span = maxT * 1.03;
  const pct = (t: number) => `${((t / span) * 100).toFixed(3)}%`;
  const tks = ticks(maxT);
  const groups = VERDICT_ORDER.map((v) => ({ v, rows: rows.filter((x) => x.r.verdict === v) }));
  const selected = rows.find((x) => key(x.r) === sel) ?? null;
  const selectedWallet = wallet.find((x) => `wr:${x.i}` === sel) ?? null;
  const lanes = markerLanes(timedWallet.map((x) => (x.r.t ?? 0) / span));
  const laneCount = Math.max(1, ...lanes.map((l) => l + 1));
  const untimedWallet = wallet.length - timedWallet.length;
  const [labelsRef, labelsW] = useWidth<SVGSVGElement>(600);
  const placed = labelRows(
    timeline.milestones.map((m) => ({ x: m.t / span, text: MILESTONE_LABEL[m.event] ?? m.event })),
    labelsW,
  );
  const labelH = Math.max(1, ...placed.map((p) => p.row + 1)) * 16 + 8;
  const milestoneText = timeline.milestones
    .map((m) => `${MILESTONE_LABEL[m.event] ?? m.event} at ${secs(m.t)}`)
    .join(', ');

  return (
    <>
      <ChartFrame
        minWidth={680}
        label="Timeline of the visit"
        legend={
          <>
            <LegendItem kind="dot">first contact</LegendItem>
            <LegendItem kind="diamond">address first sent</LegendItem>
            <LegendItem kind="diamond-signal">
              address sent to a tracking / unidentified party
            </LegendItem>
            <LegendItem kind="milestone">scan milestone</LegendItem>
            {wallet.length > 0 && (
              <>
                <LegendItem kind="wallet">wallet request</LegendItem>
                <LegendItem kind="wallet-risk">wallet request with a risk finding</LegendItem>
              </>
            )}
          </>
        }
        caption="Seconds since navigation started. Times are the scanner's own capture times."
      >
        <div class="tl">
          <div class="tl-head">
            <span />
            <svg
              ref={labelsRef}
              class="tl-milestone-labels"
              height={labelH}
              width="100%"
              role="img"
              aria-label={
                timeline.milestones.length
                  ? `Scan milestones: ${milestoneText}.`
                  : 'No scan milestones were recorded.'
              }
            >
              {timeline.milestones.map((m, i) => (
                <text
                  key={`${m.event}-${i}`}
                  x={pct(m.t)}
                  y={14 + placed[i]!.row * 16}
                  text-anchor={placed[i]!.anchor}
                  class="tl-ms-label"
                >
                  {MILESTONE_LABEL[m.event] ?? m.event}
                </text>
              ))}
            </svg>
          </div>
          <div class="tl-body">
            <svg class="tl-milestones" aria-hidden="true" width="100%" height="100%">
              {tks.map((t) => (
                <line key={`g${t}`} x1={pct(t)} x2={pct(t)} y1="0" y2="100%" class="tl-grid" />
              ))}
              {timeline.milestones.map((m, i) => (
                <line
                  key={`${m.event}-${i}`}
                  x1={pct(m.t)}
                  x2={pct(m.t)}
                  y1="0"
                  y2="100%"
                  class="tl-ms-line"
                />
              ))}
            </svg>
            {wallet.length > 0 && (
              <div class="tl-group" role="group" aria-label="Wallet requests">
                <div class="tl-group-label">
                  <i class="key key-wallet" aria-hidden="true" />
                  Wallet requests
                  <span class="muted"> · {wallet.length}</span>
                </div>
                <div class="tl-row tl-wr-row">
                  <span class="tl-label">
                    <span class="mono">asked the wallet</span>
                    <small>
                      {untimedWallet > 0
                        ? `${untimedWallet} not timed (listed below)`
                        : 'focus a marker for details'}
                    </small>
                  </span>
                  <div
                    class="tl-wr-track"
                    style={{ height: `${30 + (laneCount - 1) * LANE_PX}px` }}
                  >
                    <svg class="tl-track" width="100%" height="100%" aria-hidden="true">
                      <line x1="0" x2="100%" y1="15" y2="15" class="tl-base" />
                    </svg>
                    {timedWallet.map((x, j) => {
                      const k = `wr:${x.i}`;
                      const risk = hasRisk(x.r, findings);
                      return (
                        <button
                          type="button"
                          key={k}
                          class={`tl-wr ${risk ? 'risk' : ''} ${sel === k ? 'on' : ''}`}
                          style={{ left: pct(x.r.t ?? 0), top: `${15 + lanes[j]! * LANE_PX}px` }}
                          aria-pressed={sel === k}
                          aria-label={markerLabel(x.r, x.i, secs, findingsOf(x.r, findings))}
                          onClick={() => setSel(sel === k ? null : k)}
                          onFocus={() => setSel(k)}
                        >
                          <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">
                            <path d="M-6 -5L6 -5L0 6Z" />
                          </svg>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
            {groups
              .filter((g) => g.rows.length)
              .map((g) => (
                <div class="tl-group" key={g.v} role="group" aria-label={VERDICT[g.v].label}>
                  <div class={`tl-group-label v-${g.v}`}>
                    <span class="v-mark" aria-hidden="true" />
                    {VERDICT[g.v].label}
                    <span class="muted"> · {g.rows.length}</span>
                  </div>
                  {g.rows.map((x) => {
                    const k = key(x.r);
                    const alarm = addressToTracker(x.r);
                    return (
                      <button
                        type="button"
                        key={k}
                        class={`tl-row v-${x.r.verdict} ${sel === k ? 'on' : ''}`}
                        aria-pressed={sel === k}
                        aria-label={`${x.r.registrableDomain}, ${classLabel(x.r.class)}, ${VERDICT[x.r.verdict].label}. ${
                          x.contact === null
                            ? 'Contact not timed'
                            : `First contact at ${secs(x.contact)}`
                        }${x.address === null ? '' : `; address first sent at ${secs(x.address)}`}.`}
                        onClick={() => setSel(sel === k ? null : k)}
                        onFocus={() => setSel(k)}
                      >
                        <span class="tl-label">
                          <span class="mono">{x.r.registrableDomain}</span>
                          <small>{classLabel(x.r.class)}</small>
                        </span>
                        <svg class="tl-track" width="100%" height="30" aria-hidden="true">
                          <line x1="0" x2="100%" y1="15" y2="15" class="tl-base" />
                          {x.contact !== null && x.address !== null && x.address > x.contact && (
                            <line
                              x1={pct(x.contact)}
                              x2={pct(x.address)}
                              y1="15"
                              y2="15"
                              class={`tl-gap ${alarm ? 'signal' : ''}`}
                            />
                          )}
                          {x.contact !== null && (
                            <circle
                              cx={pct(x.contact)}
                              cy="15"
                              r="5"
                              class={`tl-dot v-${x.r.verdict}`}
                            />
                          )}
                          {x.address !== null && (
                            <svg x={pct(x.address)} y="15" overflow="visible">
                              <path
                                d="M0 -7L7 0L0 7L-7 0Z"
                                class={`tl-diamond ${alarm ? 'signal' : ''}`}
                              />
                            </svg>
                          )}
                          {x.contact === null && (
                            <text x="8" y="19" class="tl-untimed">
                              not timed
                            </text>
                          )}
                        </svg>
                      </button>
                    );
                  })}
                </div>
              ))}
          </div>
          <div class="tl-head tl-axis">
            <span />
            <svg height="22" width="100%" aria-hidden="true">
              {tks.map((t) => (
                <text
                  key={t}
                  x={pct(t)}
                  y="15"
                  text-anchor={t === 0 ? 'start' : 'middle'}
                  class="axis-label"
                >
                  {tickLabel(t)}
                </text>
              ))}
            </svg>
          </div>
        </div>
      </ChartFrame>
      <div class="tl-detail panel" aria-live="polite">
        {selectedWallet ? (
          <WalletMarkerDetail
            r={selectedWallet.r}
            index={selectedWallet.i}
            timeline={timeline}
            findings={findingsOf(selectedWallet.r, findings)}
          />
        ) : selected ? (
          <TimelineDetail row={selected} timeline={timeline} />
        ) : (
          <span class="muted small">
            Select a row (or tab through them) to see when that party was first contacted and when
            it first received the address.
          </span>
        )}
      </div>
      <SrTable
        caption={`Timeline of the visit. ${milestoneText}`}
        head={['Recipient', 'Class', 'Verdict', 'First contact', 'Address first sent']}
        rows={rows.map((x) => [
          x.r.registrableDomain,
          classLabel(x.r.class),
          VERDICT[x.r.verdict].label,
          x.contact === null ? 'not timed' : secs(x.contact),
          x.address === null ? '—' : secs(x.address),
        ])}
      />
      {wallet.length > 0 && (
        <SrTable
          caption="Wallet requests during the visit, in the order the site made them."
          head={['#', 'Request', 'Method', 'Time', 'When', 'Outcome', 'Findings']}
          rows={wallet.map((x) => [
            x.i + 1,
            KIND_LABEL[x.r.kind],
            x.r.method,
            x.r.t === null ? 'not timed' : secs(x.r.t),
            PHASE_TEXT[x.r.phase] ?? x.r.phase,
            OUTCOME_LABEL[x.r.outcome],
            findingsText(findingsOf(x.r, findings)) ?? 'none',
          ])}
        />
      )}
    </>
  );
}

/** Which recorded milestone a time followed (ordering of given times only). */
function afterMilestone(t: number, timeline: Timeline): string {
  const m = [...timeline.milestones].reverse().find((x) => x.t <= t)?.event ?? null;
  return m
    ? `${secs(t)} · after “${MILESTONE_LABEL[m] ?? m}”`
    : `${secs(t)} · before any milestone`;
}

function WalletMarkerDetail({
  r,
  index,
  timeline,
  findings,
}: {
  r: WalletRequestSummary;
  index: number;
  timeline: Timeline;
  findings: FindingV3[];
}) {
  const fl = flags(r);
  return (
    <div class="tl-detail-grid">
      <div>
        <div class="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <span class="mono muted">#{index + 1}</span>
          <b>{KIND_LABEL[r.kind]}</b>
          <code class="muted small">{r.method}</code>
        </div>
        {fl.length > 0 && (
          <ul class="wr-flags" style={{ marginTop: 8 }}>
            {fl.map((f) => (
              <li class="wr-flag" key={f.key}>
                {f.text}
              </li>
            ))}
          </ul>
        )}
        {findings.length > 0 && (
          <p class="dim small" style={{ margin: '8px 0 0' }}>
            {findings.map((f) => f.title).join(' · ')}
          </p>
        )}
      </div>
      <dl class="kv">
        <dt>Asked</dt>
        <dd class="mono">{r.t === null ? 'not timed' : afterMilestone(r.t, timeline)}</dd>
        <dt>Phase</dt>
        <dd>{PHASE_TEXT[r.phase] ?? r.phase}</dd>
        <dt>Outcome</dt>
        <dd>{OUTCOME_LABEL[r.outcome]}</dd>
      </dl>
    </div>
  );
}

function TimelineDetail({ row, timeline }: { row: Row; timeline: Timeline }) {
  const when = (t: number) => afterMilestone(t, timeline);
  return (
    <div class="tl-detail-grid">
      <div>
        <div class="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <b class="mono">{row.r.registrableDomain}</b>
          <span class="muted small">{classLabel(row.r.class)}</span>
          <VerdictChip verdict={row.r.verdict} />
        </div>
        <p class="dim small" style={{ margin: '8px 0 0' }}>
          {row.r.reason}
        </p>
      </div>
      <dl class="kv">
        <dt>First contact</dt>
        <dd class="mono">{row.contact === null ? 'not timed' : when(row.contact)}</dd>
        <dt>Address first sent</dt>
        <dd class={`mono ${addressToTracker(row.r) ? 'signal-text' : ''}`}>
          {row.address !== null
            ? when(row.address)
            : row.r.learned.address === 'exact' || row.r.learned.address === 'hashed'
              ? 'not timed (seen outside a timed request)'
              : 'never — no full or hashed form observed'}
        </dd>
      </dl>
    </div>
  );
}
