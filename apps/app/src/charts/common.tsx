/**
 * Chart plumbing shared by the hand-written SVG charts: a time scale, tick
 * choice, and an accessible frame (role=img picture + visually-hidden data
 * table + its own horizontal scroll container on narrow screens).
 *
 * Charts draw backend data as given; nothing here derives a judgement.
 */
import type { ComponentChildren, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

/** Rendered width (px) of an element, kept current on resize. */
export function useWidth<T extends Element>(fallback: number): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(el.getBoundingClientRect().width || fallback);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * Place point labels (at fraction x of the width) on as few rows as possible
 * without overlap; returns each label's row and text anchor.
 */
export function labelRows(
  xs: Array<{ x: number; text: string }>,
  widthPx: number,
  charPx = 6.4,
): Array<{ row: number; anchor: 'start' | 'middle' | 'end' }> {
  const ends: number[] = [];
  return xs.map(({ x, text }) => {
    const w = text.length * charPx + 10;
    const px = x * widthPx;
    const anchor = px + w / 2 > widthPx ? 'end' : px - w / 2 < 0 ? 'start' : 'middle';
    const left = anchor === 'start' ? px : anchor === 'end' ? px - w : px - w / 2;
    let row = ends.findIndex((e) => e <= left);
    if (row === -1) row = ends.length;
    ends[row] = left + w;
    return { row, anchor };
  });
}

/** "Nice" tick step (ms) for a time span, at most ~8 ticks. */
export function tickStep(spanMs: number): number {
  const steps = [500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000];
  return steps.find((s) => spanMs / s <= 8) ?? 600_000;
}

export function ticks(maxMs: number): number[] {
  const step = tickStep(maxMs);
  const out: number[] = [];
  for (let t = 0; t <= maxMs + 1; t += step) out.push(t);
  return out;
}

export const tickLabel = (ms: number) =>
  ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000}m` : `${ms / 1000}s`;

/** Data table for assistive technology; the SVG above it is the same data drawn. */
export function SrTable({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: string[];
  rows: Array<Array<string | number>>;
}) {
  return (
    <table class="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A chart's frame: the picture scrolls inside its own container; legend and caption below. */
export function ChartFrame({
  children,
  legend,
  caption,
  minWidth,
  label,
}: {
  children: ComponentChildren;
  legend?: ComponentChildren;
  caption?: ComponentChildren;
  /** Below this width the chart scrolls horizontally inside its frame. */
  minWidth: number;
  /** Region label for the scroll container (keyboard users can scroll it). */
  label: string;
}) {
  return (
    <figure class="chart panel">
      <div class="chart-scroll" tabIndex={0} role="region" aria-label={`${label} (scrollable)`}>
        <div style={{ minWidth }}>{children}</div>
      </div>
      {legend && <div class="legend">{legend}</div>}
      {caption && <figcaption class="muted small chart-caption">{caption}</figcaption>}
    </figure>
  );
}

export function LegendItem({ kind, children }: { kind: string; children: ComponentChildren }) {
  return (
    <span class="legend-item">
      <i class={`key key-${kind}`} aria-hidden="true" />
      {children}
    </span>
  );
}
