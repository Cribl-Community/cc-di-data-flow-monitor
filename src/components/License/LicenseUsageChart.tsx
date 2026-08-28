import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { LicenseDayPoint } from '../../hooks/useLicenseConsumption';
import { OTHER_SOURCE_KEY } from '../../hooks/useLicenseConsumption';
import { formatBytes, formatDateShort, formatHourShort } from '../../lib/format';
import './LicenseUsageChart.css';

const WIDTH = 900;
const HEIGHT = 220;
const PAD_L = 4;
const PAD_R = 4;
const PAD_T = 12;
const PAD_B = 22;

/** Fixed qualitative palette for up to 10 distinct Sources — deliberately not the app's semantic
 *  status colors (danger/warning/success are reserved for health elsewhere in this app; reusing
 *  them here for "just which Source this is" would misleadingly imply a health signal). "Other
 *  sources" gets its own quiet neutral swatch, not one of the 10, so it reads as a residual
 *  category rather than an 11th real Source. */
const SWATCH_CLASSES = ['lic-swatch-0', 'lic-swatch-1', 'lic-swatch-2', 'lic-swatch-3', 'lic-swatch-4', 'lic-swatch-5', 'lic-swatch-6', 'lic-swatch-7', 'lic-swatch-8', 'lic-swatch-9'];

function swatchClassFor(key: string, topSourceKeys: string[]): string {
  if (key === OTHER_SOURCE_KEY) return 'lic-swatch-other';
  const i = topSourceKeys.indexOf(key);
  return SWATCH_CLASSES[i % SWATCH_CLASSES.length] ?? 'lic-swatch-other';
}

interface LicenseUsageChartProps {
  dayPoints: LicenseDayPoint[];
  topSourceKeys: string[];
  hasOtherSources: boolean;
  sourceLabel: (key: string) => string;
  /** Picks the axis/tooltip date formatter and the chart's own `aria-label` — `'day'` (default)
   *  for the 30-day view, `'hour'` for the 24h view. Doesn't change how a point is drawn (a bar's
   *  own height/segments/hover behavior are already granularity-agnostic), only how its own
   *  timestamp is read back to the viewer. */
  granularity?: 'day' | 'hour';
}

/**
 * Daily ingest, stacked by Source (top 10 by real volume + an "Other sources" catch-all — see
 * `useLicenseConsumption`'s own doc comment for how that ranking and the redistribution-to-match-
 * the-real-total work) — always, with no separate "Total" mode to switch away from: per explicit
 * direction, this chart pairs with the Top Sources table beside it, so the per-source breakdown is
 * the one view worth showing rather than a toggle between it and a plainer aggregate. No quota
 * reference line either (removed per explicit direction, along with its own show/hide switch) —
 * the y axis always rescales to the data's own real max, and a day that went over quota is still
 * called out via `.lic-bar--over`'s own red fill, driven by each `LicenseDayPoint`'s real
 * `overQuota` flag rather than a line the reader has to cross-reference visually.
 *
 * `width="100%"` + `height="100%"` + `preserveAspectRatio="none"` against a fixed viewBox (the
 * same width technique `SourceVolumeRowChart` already uses, extended to height too so this chart
 * can grow to fill its panel's own available vertical space — see `.lic-chart-svg`'s `flex: 1` in
 * the CSS) rather than a `ResizeObserver` — hover only needs the *fraction* across the rendered
 * element's own bounding box, not an exact pixel mapping, so this is simpler and correct at any
 * size. The hover tooltip is portaled to `document.body` — the same fix already proven necessary
 * for `SourceVolumeRowChart`/`WorkerAlertBadge` once a chart this wide sits inside a panel with
 * `overflow` set.
 */
export function LicenseUsageChart({ dayPoints, topSourceKeys, hasOtherSources, sourceLabel, granularity = 'day' }: LicenseUsageChartProps) {
  const formatTick = granularity === 'hour' ? formatHourShort : formatDateShort;
  const [hoverIndex, setHoverIndex] = useState<number | undefined>(undefined);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | undefined>(undefined);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // The initial `left` is the hovered bar's own center — correct for most bars, but one near the
  // right (or left) edge of a wide chart would otherwise open a tooltip that runs off the panel/
  // viewport, same real bug already found and fixed for `WorkerAlertBadge`'s own hover panel. Only
  // measurable *after* the tooltip has actually rendered (its width depends on how many Sources
  // that day breaks down into), so this clamps `left` in a layout effect rather than predicting the
  // width up front — `getBoundingClientRect()` already reflects the CSS `translate(-50%, -100%)`
  // centering transform, so the same "shift `left` by however much it overflows" math applies
  // unchanged regardless of that transform.
  useLayoutEffect(() => {
    if (!tooltipPos) return;
    const el = tooltipRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rightOverflow = rect.right - window.innerWidth;
    const leftOverflow = 8 - rect.left;
    if (rightOverflow > 0) {
      setTooltipPos((prev) => (prev ? { ...prev, left: prev.left - rightOverflow - 8 } : prev));
    } else if (leftOverflow > 0) {
      setTooltipPos((prev) => (prev ? { ...prev, left: prev.left + leftOverflow } : prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-measure when the hovered bar changes, not on every `tooltipPos` write this effect itself makes.
  }, [hoverIndex]);
  // Hovering a legend entry highlights that one Source's own segments across every bar — set from
  // the legend row below, read by both the per-source segments and the plain (unattributed/over-
  // quota) bars, which fade out along with every other Source's segments since neither belongs to
  // the highlighted Source's own series.
  const [hoveredKey, setHoveredKey] = useState<string | undefined>(undefined);

  if (dayPoints.length === 0) {
    return (
      <div className="lic-chart-empty">No usage history available for this range yet.</div>
    );
  }

  const n = dayPoints.length;
  const plotW = WIDTH - PAD_L - PAD_R;
  const plotH = HEIGHT - PAD_T - PAD_B;
  const maxTotal = Math.max(...dayPoints.map((d) => d.totalBytes), 1);
  const maxV = maxTotal * 1.08 || 1;
  const slot = plotW / n;
  const barW = Math.max(1, slot * (n > 45 ? 0.85 : 0.7));

  const yFor = (v: number) => PAD_T + plotH - (v / maxV) * plotH;
  const xFor = (i: number) => PAD_L + i * slot + (slot - barW) / 2;

  const orderedKeys = [...topSourceKeys, ...(hasOtherSources ? [OTHER_SOURCE_KEY] : [])];

  const handleMove = (e: MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const idx = Math.min(n - 1, Math.max(0, Math.floor(frac * n)));
    setHoverIndex(idx);
    setTooltipPos({ top: rect.top - 8, left: rect.left + (idx + 0.5) * (rect.width / n) });
  };
  const handleLeave = () => {
    setHoverIndex(undefined);
    setTooltipPos(undefined);
  };

  const tickIndices = n <= 1 ? [0] : [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];
  const uniqueTickIndices = [...new Set(tickIndices)];

  const hovered = hoverIndex !== undefined ? dayPoints[hoverIndex] : undefined;

  return (
    <div className="lic-chart-wrap">
      <svg
        className="lic-chart-svg"
        width="100%"
        height="100%"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={granularity === 'hour' ? 'Hourly ingest by Source' : 'Daily ingest by Source'}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      >
        {dayPoints.map((d, i) => {
          const x = xFor(i);
          const highlighted = hoverIndex === i;

          if (!d.segments) {
            const h = (PAD_T + plotH) - yFor(d.totalBytes);
            // Not part of any Source's own series — fades along with every segment that isn't the
            // hovered Source, the same "focus on what's hovered" language this app already uses
            // for Signal Path's own node/edge highlighting.
            const seriesDimmed = hoveredKey !== undefined;
            return (
              <rect
                key={d.date}
                x={x}
                y={yFor(d.totalBytes)}
                width={barW}
                height={h}
                rx={1}
                className={`lic-bar${d.overQuota ? ' lic-bar--over' : ''}${highlighted ? ' lic-bar--hover' : ''}${seriesDimmed ? ' lic-bar--series-dimmed' : ''}`}
              />
            );
          }

          let cursor = 0;
          return (
            <g key={d.date} className={highlighted ? 'lic-bar--hover' : ''}>
              {orderedKeys.map((key) => {
                const seg = d.segments?.find((s) => s.key === key);
                const bytes = seg?.bytes ?? 0;
                if (bytes <= 0) return null;
                const yTop = yFor(cursor + bytes);
                const yBottom = yFor(cursor);
                cursor += bytes;
                const seriesDimmed = hoveredKey !== undefined && hoveredKey !== key;
                return (
                  <rect
                    key={key}
                    x={x}
                    y={yTop}
                    width={barW}
                    height={Math.max(0, yBottom - yTop)}
                    className={`${swatchClassFor(key, topSourceKeys)}${seriesDimmed ? ' lic-bar--series-dimmed' : ''}`}
                  />
                );
              })}
            </g>
          );
        })}

        {uniqueTickIndices.map((i) => (
          <text key={i} x={xFor(i) + barW / 2} y={HEIGHT - 6} textAnchor="middle" className="lic-chart-axis-label">
            {formatTick(dayPoints[i].date)}
          </text>
        ))}
      </svg>

      <div className="lic-chart-legend">
        {orderedKeys.map((key) => (
          // A real `<button>`, not a plain `<span>` — hover *and* focus both highlight the same
          // Source's own series (keyboard parity with mouse hover, matching this app's established
          // convention elsewhere, e.g. `WorkerAlertBadge`), even though nothing happens on click.
          <button
            key={key}
            type="button"
            className="lic-chart-legend-item"
            onMouseEnter={() => setHoveredKey(key)}
            onMouseLeave={() => setHoveredKey(undefined)}
            onFocus={() => setHoveredKey(key)}
            onBlur={() => setHoveredKey(undefined)}
          >
            <span className={`lic-chart-legend-swatch ${swatchClassFor(key, topSourceKeys)}`} />
            {sourceLabel(key)}
          </button>
        ))}
      </div>

      {hovered &&
        tooltipPos &&
        createPortal(
          <div ref={tooltipRef} className="lic-chart-tooltip" style={{ top: tooltipPos.top, left: tooltipPos.left }}>
            <div className="lic-chart-tooltip-date">{formatTick(hovered.date)}</div>
            <div className="lic-chart-tooltip-total">
              {formatBytes(hovered.totalBytes)}
              {hovered.overQuota && <span className="lic-chart-tooltip-over"> — over quota</span>}
            </div>
            {hovered.segments ? (
              [...hovered.segments]
                .filter((s) => s.bytes > 0)
                .sort((a, b) => b.bytes - a.bytes)
                .map((s) => (
                  <div className="lic-chart-tooltip-row" key={s.key}>
                    <span className={`lic-chart-legend-swatch ${swatchClassFor(s.key, topSourceKeys)}`} />
                    <span className="lic-chart-tooltip-row-label">{s.label}</span>
                    <span className="lic-chart-tooltip-row-value">{formatBytes(s.bytes)}</span>
                  </div>
                ))
            ) : (
              <div className="lic-chart-tooltip-note">No per-source breakdown available for this day.</div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
