/**
 * (b) Traffic: requests per second (1 s buckets from navigation start),
 * first party and third party stacked, with the scan milestones as lines.
 * Straight from report.timeline.requestsPerSecond / milestones.
 */
import type { Timeline } from '@igris/core/contracts';
import { MILESTONE_LABEL, secs } from '../ui.js';
import {
  ChartFrame,
  LegendItem,
  SrTable,
  labelRows,
  tickLabel,
  ticks,
  useWidth,
} from './common.js';

const PLOT = 190;
const AXIS = 24;

function niceMax(v: number): number {
  if (v <= 4) return Math.max(1, v);
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function TrafficChart({ timeline }: { timeline: Timeline }) {
  const rps = timeline.requestsPerSecond;
  const n = Math.max(1, rps.length);
  const peak = Math.max(0, ...rps.map((b) => b.firstParty + b.thirdParty));
  const yMax = niceMax(peak);
  const [svgRef, svgW] = useWidth<SVGSVGElement>(600);
  const span0 = Math.max(n * 1000, ...timeline.milestones.map((m) => m.t + 500));
  const placed = labelRows(
    timeline.milestones.map((m) => ({ x: m.t / span0, text: MILESTONE_LABEL[m.event] ?? m.event })),
    svgW,
  );
  const TOP = Math.max(1, ...placed.map((p) => p.row + 1)) * 16 + 12;
  const H = TOP + PLOT + AXIS;
  const y = (v: number) => TOP + PLOT - (v / yMax) * PLOT;
  const span = span0;
  const pct = (t: number) => `${Math.min(100, (t / span) * 100).toFixed(3)}%`;
  const slot = (1000 / span) * 100;
  const bw = slot * (n > 120 ? 0.9 : 0.72);
  const barW = `${bw.toFixed(3)}%`;
  const yTicks = [0, yMax / 2, yMax].filter((v, i, a) => a.indexOf(v) === i);
  const total = rps.reduce((a, b) => ({ fp: a.fp + b.firstParty, tp: a.tp + b.thirdParty }), {
    fp: 0,
    tp: 0,
  });
  const label =
    rps.length === 0
      ? 'No requests were timed.'
      : `Requests per second over ${rps.length} seconds: ${total.fp} first-party and ${total.tp} third-party requests in total; peak ${peak} per second.`;

  return (
    <>
      <ChartFrame
        minWidth={Math.min(1600, Math.max(560, n * 6))}
        label="Requests per second"
        legend={
          <>
            <LegendItem kind="first-party">first party</LegendItem>
            <LegendItem kind="third-party">third party</LegendItem>
            <LegendItem kind="milestone">scan milestone</LegendItem>
          </>
        }
        caption={`${total.fp + total.tp} timed requests · peak ${peak}/s · 1-second buckets from navigation start`}
      >
        <div class="traffic">
          <div class="traffic-y" style={{ height: H }} aria-hidden="true">
            {yTicks.map((v) => (
              <span key={v} style={{ top: y(v) - 8 }} class="axis-label">
                {Number.isInteger(v) ? v : v.toFixed(1)}
              </span>
            ))}
          </div>
          <svg
            ref={svgRef}
            width="100%"
            height={H}
            role="img"
            aria-label={label}
            class="traffic-svg"
          >
            {yTicks.map((v) => (
              <line key={v} x1="0" x2="100%" y1={y(v)} y2={y(v)} class="grid-line" />
            ))}
            {rps.map((b) => {
              const x = `${((b.t / 1000) * slot + (slot - bw) / 2).toFixed(3)}%`;
              const fpTop = y(b.firstParty);
              const tpTop = y(b.firstParty + b.thirdParty);
              return (
                <g key={b.t}>
                  {b.firstParty > 0 && (
                    <rect x={x} width={barW} y={fpTop} height={TOP + PLOT - fpTop} class="bar-fp" />
                  )}
                  {b.thirdParty > 0 && (
                    <rect x={x} width={barW} y={tpTop} height={fpTop - tpTop} class="bar-tp" />
                  )}
                </g>
              );
            })}
            {timeline.milestones.map((m, i) => (
              <g key={`${m.event}-${i}`}>
                <line x1={pct(m.t)} x2={pct(m.t)} y1={TOP - 4} y2={TOP + PLOT} class="tl-ms-line" />
                <text
                  x={pct(m.t)}
                  y={12 + placed[i]!.row * 16}
                  text-anchor={placed[i]!.anchor}
                  class="tl-ms-label"
                >
                  {MILESTONE_LABEL[m.event] ?? m.event}
                </text>
              </g>
            ))}
            {ticks(span).map((t) => (
              <text
                key={t}
                x={pct(t)}
                y={H - 6}
                text-anchor={t === 0 ? 'start' : t >= span ? 'end' : 'middle'}
                class="axis-label"
              >
                {tickLabel(t)}
              </text>
            ))}
          </svg>
        </div>
      </ChartFrame>
      <SrTable
        caption={`${label} Milestones: ${timeline.milestones
          .map((m) => `${MILESTONE_LABEL[m.event] ?? m.event} at ${secs(m.t)}`)
          .join(', ')}.`}
        head={['Second', 'First-party requests', 'Third-party requests']}
        rows={rps
          .filter((b) => b.firstParty + b.thirdParty > 0)
          .map((b) => [`${b.t / 1000}–${b.t / 1000 + 1} s`, b.firstParty, b.thirdParty])}
      />
    </>
  );
}
