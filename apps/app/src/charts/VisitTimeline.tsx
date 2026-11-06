/**
 * (a) Timeline of the visit: x = seconds since navigation start; scan
 * milestones as vertical lines; one row per recipient grouped by the
 * backend's verdict, a dot at its first contact and a diamond at the first
 * request that carried the address. Rows are buttons: focus or click one to
 * read its details. All values come from report.timeline / report.recipients.
 */
import { useState } from 'preact/hooks';
import type { Recipient, ReportV3, Timeline } from '@igris/core/contracts';
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

interface Row {
  r: Recipient;
  contact: number | null;
  address: number | null;
}

const key = (x: { registrableDomain: string; class: string }) =>
  `${x.registrableDomain}|${x.class}`;

export function VisitTimeline({ report, timeline }: { report: ReportV3; timeline: Timeline }) {
  const [sel, setSel] = useState<string | null>(null);
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
  );
  const span = maxT * 1.03;
  const pct = (t: number) => `${((t / span) * 100).toFixed(3)}%`;
  const tks = ticks(maxT);
  const groups = VERDICT_ORDER.map((v) => ({ v, rows: rows.filter((x) => x.r.verdict === v) }));
  const selected = rows.find((x) => key(x.r) === sel) ?? null;
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
        {selected ? (
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
    </>
  );
}

function TimelineDetail({ row, timeline }: { row: Row; timeline: Timeline }) {
  // Which recorded milestone the first contact followed (ordering of given times).
  const before = (t: number) =>
    [...timeline.milestones].reverse().find((m) => m.t <= t)?.event ?? null;
  const when = (t: number) => {
    const m = before(t);
    return m
      ? `${secs(t)} · after “${MILESTONE_LABEL[m] ?? m}”`
      : `${secs(t)} · before any milestone`;
  };
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
