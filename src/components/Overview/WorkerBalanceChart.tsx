import { useMemo, useState } from 'react';
import type { WorkerFleetRow } from '../../lib/workerHealth';
import type { GroupProductFilter, VolumeUnit } from '../../lib/types';
import { formatMetric } from '../../lib/format';
import { WORKER_NOUN } from '../../lib/productTerms';
import './WorkerBalanceChart.css';

interface WorkerBalanceChartProps {
  rows: WorkerFleetRow[];
  /** For the "Volume" metric only — CPU/Mem/Disk are always percentages and Blocks is always a
   *  bare count, neither has an Events/Bytes duality. Threaded through from the shared top-bar
   *  toggle rather than assumed, since a bare-events reading here previously silently ignored it. */
  unit: VolumeUnit;
  /** The top-left toggle's own current product — every row already belongs to this same product
   *  (see `FleetRoster`'s identical prop), so it's what decides the panel title/aria-label's own
   *  "Worker"/"Node" wording. Defaults to `'stream'` when omitted, this component's own prior
   *  always-"Worker" behavior. */
  groupProductFilter?: GroupProductFilter;
}

type Metric = 'cpu' | 'mem' | 'disk' | 'volume' | 'blocks';

// A real large Edge Fleet (see Phase 0) can mean hundreds of bars — worst-first sorting already
// answers "which ones need attention," so capping the chart itself to the top 20 keeps it a real
// leaderboard rather than an unwieldy, mostly-scrolled-past bar-per-node chart; the panel's own
// note below says how many more exist rather than silently dropping them.
const MAX_BARS = 20;

const METRIC_LABEL: Record<Metric, string> = { cpu: 'CPU', mem: 'Mem', disk: 'Disk', volume: 'Volume', blocks: 'Blocks' };

function pct(used: number | undefined, total: number | undefined): number {
  if (used === undefined || total === undefined || total <= 0) return 0;
  return (used / total) * 100;
}

function shortHostname(hostname: string): string {
  // Real hostnames in this app's own confirmed shape run long (e.g.
  // `ip-10-247-1-226-main-infallible-jackson-x3zlthz`) — truncate to the first meaningful
  // segment or two so the chart's own x-axis labels stay legible at this width.
  const parts = hostname.split('-');
  return parts.length > 4 ? parts.slice(0, 4).join('-') + '…' : hostname;
}

function valueFor(w: WorkerFleetRow, metric: Metric): number {
  switch (metric) {
    case 'cpu':
      return w.loadPct ?? 0;
    case 'mem':
      return pct(w.memUsedBytes, w.memTotalBytes);
    case 'disk':
      return pct(w.diskUsedBytes, w.diskTotalBytes);
    case 'volume':
      return w.volumeIn;
    case 'blocks':
      return w.blockedCount;
  }
}

function formatValue(v: number, metric: Metric, unit: 'events' | 'bytes'): string {
  if (metric === 'cpu' || metric === 'mem' || metric === 'disk') return `${Math.round(v)}%`;
  if (metric === 'blocks') return String(Math.round(v));
  return formatMetric(v, unit);
}

/**
 * Compares one metric across every worker currently in scope — a local segmented control (not the
 * shared top-bar one) switches which metric, since this is the one place in the app comparing
 * *workers* against each other rather than components/flows. The worst outlier (>1.6x the group's
 * own median, matching the same threshold this app's worker-alert-severity code already uses
 * elsewhere) gets a danger-tinted bar so an imbalance reads at a glance, not just from the numbers.
 *
 * Bars render worst-first (descending by the selected metric's own value) — this is genuinely a
 * ranked leaderboard, not an unordered comparison: with the Edge scope widened to potentially
 * hundreds of nodes (see Phase 0), scanning left-to-right for "which one is worst" stops working
 * long before a sorted, worst-first order does.
 */
export function WorkerBalanceChart({ rows, unit, groupProductFilter = 'stream' }: WorkerBalanceChartProps) {
  const [metric, setMetric] = useState<Metric>('cpu');
  const nodeNoun = WORKER_NOUN[groupProductFilter];

  const { bars, note } = useMemo(() => {
    const values = rows.map((w) => valueFor(w, metric));
    const max = Math.max(1, ...values);
    const sortedValues = [...values].sort((a, b) => a - b);
    const median = sortedValues[Math.floor(sortedValues.length / 2)] || 1;

    const ranked = rows
      .map((w) => {
        const v = valueFor(w, metric);
        const isOutlier = v > median * 1.6 && v > 0;
        return { id: w.id, hostname: w.hostname, value: v, pct: Math.max(2, (v / max) * 100), isOutlier };
      })
      .sort((a, b) => b.value - a.value);
    const bars = ranked.slice(0, MAX_BARS);
    const hiddenCount = ranked.length - bars.length;

    const worst = bars[0];
    const metricNoun = { cpu: 'CPU load', mem: 'memory', disk: 'disk', volume: 'inbound volume', blocks: 'blocked events' }[metric];
    const note =
      worst && worst.value > 0
        ? bars.filter((b) => b.isOutlier).length > 0
          ? `${worst.hostname} is carrying disproportionately more ${metricNoun} than its peers.`
          : `${metricNoun[0].toUpperCase() + metricNoun.slice(1)} is reasonably balanced across this scope.`
        : `No ${metricNoun} observed in this scope yet.`;

    return { bars, note: hiddenCount > 0 ? `${note} (+${hiddenCount} more not shown)` : note };
  }, [rows, metric]);

  return (
    <div className="ov-panel">
      <div className="ov-panel-head">
        <span className="ov-panel-title">{nodeNoun} Comparison</span>
      </div>
      <div className="ov-balance-toggle" role="group" aria-label={`${nodeNoun} balance metric`}>
        {(['cpu', 'mem', 'disk', 'volume', 'blocks'] as const).map((m) => (
          <button key={m} type="button" className={m === metric ? 'active' : ''} aria-pressed={m === metric} onClick={() => setMetric(m)}>
            {METRIC_LABEL[m]}
          </button>
        ))}
      </div>
      <div className="ov-panel-body ov-balance-chart">
        {bars.map((b) => (
          <div className="ov-bcol" key={b.id} title={`${b.hostname}: ${formatValue(b.value, metric, unit)}`}>
            <span className="ov-bcol-val">{formatValue(b.value, metric, unit)}</span>
            <div className={`ov-bcol-bar${b.isOutlier ? ' outlier' : ''}`} style={{ height: `${b.pct}%` }} />
            <span className="ov-bcol-label">{shortHostname(b.hostname)}</span>
          </div>
        ))}
      </div>
      <div className="ov-balance-note">{note}</div>
    </div>
  );
}
