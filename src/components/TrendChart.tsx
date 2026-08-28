import { useCallback, useRef, useState } from 'react';
import { formatTimestamp, formatTimeShort } from '../lib/format';
import type { TrendPoint } from '../api/metrics';
import './TrendChart.css';

/** One or more named trend series on a shared time axis and Y scale. Every series is always shown
 *  split out with its own legend entry — even a lone one — so a single-source trend still reads as
 *  "this named series," consistent with the multi-series case; hovering (or focusing, for keyboard
 *  parity) a legend entry highlights that one series' own line/dot, dimming every other one. */
export interface TrendSeries {
  id: string;
  label: string;
  points: TrendPoint[];
}

const MARGIN = { top: 12, right: 12, bottom: 24, left: 48 };
const HEIGHT = 180;

const SERIES_CLASSES = [
  'trend-chart-series-0',
  'trend-chart-series-1',
  'trend-chart-series-2',
  'trend-chart-series-3',
  'trend-chart-series-4',
  'trend-chart-series-5',
  'trend-chart-series-6',
  'trend-chart-series-7',
  'trend-chart-series-8',
  'trend-chart-series-9',
];

function seriesClassFor(index: number): string {
  return SERIES_CLASSES[index % SERIES_CLASSES.length];
}

function niceTicks(min: number, max: number, count: number): number[] {
  if (max <= min) return [min];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => min + step * i);
}

export function TrendChart({
  series,
  formatValue = (v: number) => v.toLocaleString(),
}: {
  series: TrendSeries[];
  formatValue?: (v: number) => string;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | undefined>(undefined);
  const [hoveredSeriesId, setHoveredSeriesId] = useState<string | undefined>(undefined);
  const [width, setWidth] = useState(480);
  const resizeObserverRef = useRef<ResizeObserver | undefined>(undefined);

  // Callback ref, not `useRef` + an empty-deps `useEffect` — a plain effect tied to first mount can
  // permanently miss the real container: the empty-data branch below renders an un-ref'd
  // placeholder on first commit, so `containerRef.current` would still be `null` when that effect
  // ran, and with no dependency ever changing, it never gets a second chance once the real, ref'd
  // chart container swaps in. A callback ref fires whenever React actually attaches/detaches a node,
  // independent of which render that happens on.
  const containerRef = useCallback((el: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = undefined;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth || 480);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    resizeObserverRef.current = observer;
  }, []);

  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;

  const sharedTimes = (() => {
    const times = new Set<number>();
    for (const s of series) for (const p of s.points) times.add(p.t);
    return [...times].sort((a, b) => a - b);
  })();

  if (sharedTimes.length < 2) {
    return (
      <div className="trend-chart trend-chart--empty" style={{ height: HEIGHT }}>
        Not enough data yet in the selected time range.
      </div>
    );
  }

  const seriesValues = series.map((s) => {
    const byTime = new Map(s.points.map((p) => [p.t, p.v]));
    return sharedTimes.map((t) => byTime.get(t) ?? 0);
  });

  const maxV = Math.max(...seriesValues.flat(), 1);
  const minV = 0;
  const rangeV = maxV - minV || 1;

  const xFor = (i: number) => MARGIN.left + (i / (sharedTimes.length - 1)) * plotWidth;
  const yFor = (v: number) => MARGIN.top + plotHeight - ((v - minV) / rangeV) * plotHeight;

  const pathFor = (values: number[]) => values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)},${yFor(v)}`).join(' ');
  // Same line, closed down to the plot's own baseline (the bottom of the chart, since this is a
  // zero-anchored scale — `minV` is always 0) and back to the start, so it can be filled as a
  // translucent area sitting underneath that series' own line.
  const baselineY = MARGIN.top + plotHeight;
  const areaPathFor = (values: number[]) => `${pathFor(values)} L ${xFor(values.length - 1)},${baselineY} L ${xFor(0)},${baselineY} Z`;

  const yTicks = niceTicks(minV, maxV, 4);
  const xTickCount = Math.min(5, sharedTimes.length);
  const xTickIndices = Array.from({ length: xTickCount }, (_, i) => Math.round((i / (xTickCount - 1)) * (sharedTimes.length - 1)));

  // A dimmed/emphasized state only kicks in once a legend entry is actually hovered/focused — with
  // nothing hovered, every series renders at its own normal, undimmed weight.
  const isDimmed = (id: string) => hoveredSeriesId !== undefined && hoveredSeriesId !== id;
  const isEmphasized = (id: string) => hoveredSeriesId === id;

  return (
    <div className="trend-chart" ref={containerRef}>
      <svg
        width="100%"
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label="Trend over the selected time range, split by series"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const relX = ((e.clientX - rect.left) / rect.width) * width;
          const idx = Math.round(((relX - MARGIN.left) / plotWidth) * (sharedTimes.length - 1));
          setHoverIndex(Math.min(sharedTimes.length - 1, Math.max(0, idx)));
        }}
        onMouseLeave={() => setHoverIndex(undefined)}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={MARGIN.left} x2={width - MARGIN.right} y1={yFor(t)} y2={yFor(t)} className="trend-chart-gridline" />
            <text x={MARGIN.left - 8} y={yFor(t)} textAnchor="end" dominantBaseline="middle" className="trend-chart-axis-label">
              {formatValue(t)}
            </text>
          </g>
        ))}

        {xTickIndices.map((i) => (
          <text key={i} x={xFor(i)} y={HEIGHT - 6} textAnchor="middle" className="trend-chart-axis-label">
            {formatTimeShort(sharedTimes[i])}
          </text>
        ))}

        {seriesValues.map((values, i) => (
          <path
            key={series[i].id}
            d={areaPathFor(values)}
            className={[
              'trend-chart-area',
              seriesClassFor(i),
              isDimmed(series[i].id) && 'trend-chart-item-dimmed',
              isEmphasized(series[i].id) && 'trend-chart-item-emphasized',
            ]
              .filter(Boolean)
              .join(' ')}
          />
        ))}

        {seriesValues.map((values, i) => (
          <path
            key={series[i].id}
            d={pathFor(values)}
            className={[
              'trend-chart-line',
              seriesClassFor(i),
              isDimmed(series[i].id) && 'trend-chart-item-dimmed',
              isEmphasized(series[i].id) && 'trend-chart-item-emphasized',
            ]
              .filter(Boolean)
              .join(' ')}
          />
        ))}

        {hoverIndex !== undefined && (
          <>
            <line x1={xFor(hoverIndex)} x2={xFor(hoverIndex)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} className="trend-chart-crosshair" />
            {seriesValues.map((values, i) => (
              <circle
                key={series[i].id}
                cx={xFor(hoverIndex)}
                cy={yFor(values[hoverIndex])}
                r={3.5}
                className={['trend-chart-dot', seriesClassFor(i), isDimmed(series[i].id) && 'trend-chart-item-dimmed'].filter(Boolean).join(' ')}
              />
            ))}
          </>
        )}
      </svg>

      {hoverIndex !== undefined && (
        <div className="trend-chart-tooltip" style={{ left: `${(xFor(hoverIndex) / width) * 100}%` }}>
          <span className="trend-chart-tooltip-time">{formatTimestamp(sharedTimes[hoverIndex])}</span>
          {series.map((s, i) => (
            <span key={s.id} className="trend-chart-tooltip-row">
              <span className={`trend-chart-tooltip-swatch ${seriesClassFor(i)}`} aria-hidden="true" />
              <span className="trend-chart-tooltip-label">{s.label}</span>
              <span className="trend-chart-tooltip-value">{formatValue(seriesValues[i][hoverIndex])}</span>
            </span>
          ))}
        </div>
      )}

      <div className="trend-chart-legend trend-chart-legend--centered">
        {series.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className={`trend-chart-legend-item trend-chart-legend-item--interactive${isDimmed(s.id) ? ' trend-chart-item-dimmed' : ''}`}
            onMouseEnter={() => setHoveredSeriesId(s.id)}
            onMouseLeave={() => setHoveredSeriesId(undefined)}
            onFocus={() => setHoveredSeriesId(s.id)}
            onBlur={() => setHoveredSeriesId(undefined)}
          >
            <span className={`trend-chart-legend-swatch ${seriesClassFor(i)}`} aria-hidden="true" />
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
