import { useEffect, useState } from 'react';
import { fetchTrend, escapeFilterLiteral, type TrendPoint } from '../api/metrics';
import { metricsKey, realRawIdOf } from '../lib/topology';
import { timeRangeToWindow } from './useFlowGraph';
import type { FlowSummary, GraphNode, TimeRangeOption, VolumeUnit } from '../lib/types';

export interface UseFlowSummaryTrendsResult {
  trends: Map<string, TrendPoint[]>;
  status: 'idle' | 'loading' | 'ready' | 'error';
}

/**
 * One bucketed trend series per `FlowSummary` row, for Flow Explorer's sparkline column. Fetched
 * once per graph load (keyed by the summaries' own ids, not the filtered/sorted table view) so
 * searching or re-sorting never triggers a refetch — only a re-render of already-fetched data.
 *
 * Route-based flows filter `route.in_*` by both the specific contributing rule(s) *and* the
 * source's own input dimension — the same two dimensions the cumulative source-attribution query
 * (`fetchRouteSourceBreakdown`) already splits by, just bucketed over time instead of summed.
 * QuickConnect flows (empty `routeIds` — they never touch Routes at all) fall back to `total.in_*`
 * filtered by just the source, the same "no per-source out breakdown available" limitation already
 * documented on the QuickConnect branch of `buildFlowGraph`.
 */
export function useFlowSummaryTrends(
  flowSummaries: FlowSummary[],
  nodesById: Map<string, GraphNode>,
  unit: VolumeUnit,
  timeRangeId: TimeRangeOption['id'],
): UseFlowSummaryTrendsResult {
  const [trends, setTrends] = useState<Map<string, TrendPoint[]>>(new Map());
  const [status, setStatus] = useState<UseFlowSummaryTrendsResult['status']>('idle');

  // Keyed on the summaries' own ids, not the array reference — `flowSummaries` is a new array
  // reference every time `buildFlowGraph` runs even when its contents are unchanged.
  const summaryIdsKey = flowSummaries.map((s) => s.id).join(',');

  useEffect(() => {
    if (flowSummaries.length === 0) {
      setStatus('idle');
      setTrends(new Map());
      return;
    }

    let cancelled = false;
    setStatus('loading');
    const { earliest, latest } = timeRangeToWindow(timeRangeId);
    const routeMetric = unit === 'bytes' ? 'route.in_bytes' : 'route.in_events';
    const totalMetric = unit === 'bytes' ? 'total.in_bytes' : 'total.in_events';

    Promise.all(
      flowSummaries.map(async (summary) => {
        const sourceNode = nodesById.get(summary.sourceId);
        if (!sourceNode) return [summary.id, [] as TrendPoint[]] as const;
        const sourceKey = metricsKey(sourceNode.refType ?? '', realRawIdOf(sourceNode));

        // Each summary's own real Worker Group — not a single shared param — since in the "All
        // Worker Groups" view `flowSummaries` can span several real groups at once (see
        // `mergeFlowGraphs`); every route/pipeline id referenced below is already scoped to match
        // (`summary.routeIds`, etc.), so this just needs to query the matching real group.
        const groupId = summary.workerGroupId;
        const dimFilter =
          summary.routeIds.length > 0
            ? `(${summary.routeIds.map((id) => `route == '${escapeFilterLiteral(id)}'`).join(' || ')}) && input == '${escapeFilterLiteral(sourceKey)}'`
            : `input == '${escapeFilterLiteral(sourceKey)}'`;
        const metric = summary.routeIds.length > 0 ? routeMetric : totalMetric;

        // More buckets than `useFlowGraph`'s node-detail trend (20) — a sparkline this small only
        // reads as "a trend" at all if bucket-to-bucket movement is visible; 20 buckets often
        // smoothed real variation away entirely for a low-volume flow.
        const points = await fetchTrend({ metric, groupId, dimFilter, earliest, latest, buckets: 40 });
        return [summary.id, points] as const;
      }),
    )
      .then((entries) => {
        if (cancelled) return;
        setTrends(new Map(entries));
        setStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `summaryIdsKey` stands in for `flowSummaries`; `nodesById` is derived from the same graph fetch and changes in lockstep with it.
  }, [summaryIdsKey, unit, timeRangeId]);

  return { trends, status };
}
