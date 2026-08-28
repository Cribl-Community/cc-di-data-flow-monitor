import type { TrendPoint } from '../../api/metrics';
import { HEALTH_APPEARANCE } from '../../lib/health';
import type { HealthStatus } from '../../lib/types';

interface SparklineProps {
  points: TrendPoint[] | undefined;
  health: HealthStatus;
}

const WIDTH = 70;
const HEIGHT = 20;
const PAD = 2;

/** A fixed-size, axis-free version of `TrendChart` for one table cell — real bucketed trend data
 *  (see `useFlowSummaryTrends`), just with none of the drawer chart's interactivity or scale.
 *  Deliberately scaled to its own min-max range rather than anchored at zero the way `TrendChart`
 *  honestly is for its full axis-labeled chart: at this size the only job is to show the *shape*
 *  of the change bucket to bucket, and a zero-anchored line for a flow with high absolute volume
 *  but modest relative swings reads as a flat line — exactly the "not granular enough" gap this
 *  was built to close. This is standard practice for inline sparklines specifically (unlike a
 *  full chart, where zero-anchoring is the honest choice); the real absolute numbers are already
 *  right next to it in the In/Out columns. */
export function Sparkline({ points, health }: SparklineProps) {
  if (!points || points.length < 2) {
    return <span className="flow-explorer-sparkline-empty" title="Not enough data yet in the selected time range">—</span>;
  }

  const values = points.map((p) => p.v);
  const maxV = Math.max(...values);
  const minV = Math.min(...values);
  const range = maxV - minV || Math.max(maxV, 1);
  const plotWidth = WIDTH - PAD * 2;
  const plotHeight = HEIGHT - PAD * 2;

  const xFor = (i: number) => PAD + (i / (points.length - 1)) * plotWidth;
  const yFor = (v: number) => PAD + plotHeight - ((v - minV) / range) * plotHeight;

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)},${yFor(p.v)}`).join(' ');

  return (
    <svg width={WIDTH} height={HEIGHT} className="flow-explorer-sparkline" role="img" aria-label="Trend over the selected time range">
      <path d={linePath} className={`flow-explorer-sparkline-line flow-explorer-sparkline-line--${HEALTH_APPEARANCE[health]}`} fill="none" />
    </svg>
  );
}
