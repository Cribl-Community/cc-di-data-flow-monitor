import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTopologyBundle, type RawOutput } from '../api/topology';
import {
  fetchEndpointVolumeTotals,
  fetchPipelineVolumeTotals,
  fetchRouteSourceBreakdown,
  fetchRouteVolumeTotals,
} from '../api/metrics';
import { fetchWorkerStatusesForOutputs } from '../api/workers';
import { isDestinationStuck } from '../lib/blockedOutput';
import { buildFlowGraph, mergeFlowGraphs } from '../lib/topology';
import { TIME_RANGE_OPTIONS, type FlowGraph, type TimeRangeOption, type VolumeUnit } from '../lib/types';
import { PermissionError } from '../api/client';

/** Real per-worker status for every real Destination in `outputs`, reduced down to just the bare
 *  ids that are genuinely stuck (see `lib/blockedOutput.ts`'s `isDestinationStuck`) — the one
 *  signal `buildFlowGraph` needs to correct `outEvents`/`outBytes` at the source, for every
 *  consumer of a node's own metrics or a `FlowSummary`/`IndividualFlow` at once. Degrades to an
 *  empty set (no correction, not an error) if this org hasn't granted the `/master/workers`
 *  policy — matches every other on-demand worker-status consumer's own established fallback in
 *  this app; the graph itself still loads and renders with its previous, uncorrected behavior. */
async function fetchStuckDestinationIds(groupId: string, outputs: RawOutput[]): Promise<Set<string>> {
  if (outputs.length === 0) return new Set();
  try {
    const byDestination = await fetchWorkerStatusesForOutputs(
      groupId,
      outputs.map((o) => o.id),
    );
    const stuck = new Set<string>();
    for (const [destId, rows] of byDestination) {
      if (isDestinationStuck(rows)) stuck.add(destId);
    }
    return stuck;
  } catch {
    return new Set();
  }
}

export interface UseFlowGraphResult {
  graph: FlowGraph | undefined;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | undefined;
  isPermissionError: boolean;
  refresh: () => void;
}

export function timeRangeToWindow(timeRangeId: TimeRangeOption['id']): { earliest: number; latest: number } {
  const option = TIME_RANGE_OPTIONS.find((t) => t.id === timeRangeId) ?? TIME_RANGE_OPTIONS[1];
  const latest = Date.now();
  return { earliest: latest - option.ms, latest };
}

/** The actual fetch-everything-and-build-a-graph work for one Worker Group — shared by
 *  `useFlowGraph` (single group) and `useMultiGroupFlowGraph` ("All Worker Groups", one call per
 *  group in parallel, then merged) so the two hooks can't silently drift apart on what a graph
 *  fetch actually involves. */
async function fetchOneGroupFlowGraph(groupId: string, unit: VolumeUnit, timeRangeId: TimeRangeOption['id']): Promise<FlowGraph> {
  const { earliest, latest } = timeRangeToWindow(timeRangeId);
  const otherUnit: VolumeUnit = unit === 'bytes' ? 'events' : 'bytes';

  const bundle = await fetchTopologyBundle(groupId);
  // Source/Destination/Route totals are all fetched for *both* units every time, not just
  // the one selected at the top — the drawer shows Events and Bytes side by side regardless
  // of that toggle, and only fetching the selected unit was why Bytes always read "n/a"
  // there. Route bytes additionally feed a derived Pipeline byte figure (see the
  // `pipelineByteVolume` accumulation in buildFlowGraph — Cribl has no `pipe.*_bytes` counter
  // at all, but Route -> Pipeline is a 1:1 structural link, so summing each contributing
  // rule's real `route.in_bytes`/`route.out_bytes` is an exact, not estimated, figure). The
  // top toggle still controls which unit drives headline card values/trends.
  const [
    sourceTotals,
    destTotals,
    sourceTotalsOther,
    destTotalsOther,
    routeTotals,
    routeTotalsOther,
    pipelineTotals,
    routeSourceBreakdown,
    routeSourceBreakdownOther,
    stuckDestinationIds,
  ] = await Promise.all([
    fetchEndpointVolumeTotals({ groupId, splitBy: 'input', unit, earliest, latest }),
    fetchEndpointVolumeTotals({ groupId, splitBy: 'output', unit, earliest, latest }),
    fetchEndpointVolumeTotals({ groupId, splitBy: 'input', unit: otherUnit, earliest, latest }),
    fetchEndpointVolumeTotals({ groupId, splitBy: 'output', unit: otherUnit, earliest, latest }),
    fetchRouteVolumeTotals({ groupId, unit, earliest, latest }),
    fetchRouteVolumeTotals({ groupId, unit: otherUnit, earliest, latest }),
    fetchPipelineVolumeTotals({ groupId, earliest, latest }),
    fetchRouteSourceBreakdown({ groupId, unit, earliest, latest }),
    fetchRouteSourceBreakdown({ groupId, unit: otherUnit, earliest, latest }),
    fetchStuckDestinationIds(groupId, bundle.outputs),
  ]);

  return buildFlowGraph(
    bundle,
    {
      unit,
      sourceTotals,
      destTotals,
      sourceTotalsOther,
      destTotalsOther,
      routeTotals,
      routeTotalsOther,
      pipelineTotals,
      routeSourceBreakdown,
      routeSourceBreakdownOther,
    },
    stuckDestinationIds,
  );
}

/**
 * Fetches everything needed for the Signal Path (and anything else that wants a full graph) and
 * assembles it via lib/topology.ts. Refetches whenever the group, metric unit, or time range
 * changes; `refresh()` re-runs the same query set on demand (e.g. the Refresh button).
 */
export function useFlowGraph(groupId: string | undefined, unit: VolumeUnit, timeRangeId: TimeRangeOption['id']): UseFlowGraphResult {
  const [graph, setGraph] = useState<FlowGraph | undefined>(undefined);
  const [status, setStatus] = useState<UseFlowGraphResult['status']>('idle');
  const [error, setError] = useState<string | undefined>(undefined);
  const [isPermissionError, setIsPermissionError] = useState(false);
  const [nonce, setNonce] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    if (!groupId) {
      setStatus('idle');
      setGraph(undefined);
      return;
    }

    const myRequestId = ++requestId.current;
    setStatus('loading');
    setError(undefined);
    setIsPermissionError(false);

    fetchOneGroupFlowGraph(groupId, unit, timeRangeId)
      .then((nextGraph) => {
        if (myRequestId !== requestId.current) return; // A newer request superseded this one.
        setGraph(nextGraph);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (myRequestId !== requestId.current) return;
        setStatus('error');
        setIsPermissionError(err instanceof PermissionError);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [groupId, unit, timeRangeId, nonce]);

  // Stable identity — auto-refresh (SignalPathPage) depends on this not changing every render to
  // safely include it in a useEffect dependency array without the interval getting reset.
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { graph, status, error, isPermissionError, refresh };
}

/**
 * The "All Worker Groups" version of `useFlowGraph` — fetches every given group's own graph in
 * parallel (each exactly as `useFlowGraph` would) and merges them via `mergeFlowGraphs`. A single
 * group failing to load fails the whole merge (rather than silently omitting it) so a user doesn't
 * mistake a partial view for the complete picture — matches `useFlowGraph`'s own all-or-nothing
 * error handling for a single group.
 */
export function useMultiGroupFlowGraph(
  groups: { id: string; name: string }[],
  unit: VolumeUnit,
  timeRangeId: TimeRangeOption['id'],
): UseFlowGraphResult {
  const [graph, setGraph] = useState<FlowGraph | undefined>(undefined);
  const [status, setStatus] = useState<UseFlowGraphResult['status']>('idle');
  const [error, setError] = useState<string | undefined>(undefined);
  const [isPermissionError, setIsPermissionError] = useState(false);
  const [nonce, setNonce] = useState(0);
  const requestId = useRef(0);

  // Keyed on the group ids themselves, not the array reference — `groups` is a new array
  // reference on every render regardless of whether its contents actually changed.
  const groupIdsKey = groups.map((g) => g.id).join(',');

  useEffect(() => {
    if (groups.length === 0) {
      setStatus('idle');
      setGraph(undefined);
      return;
    }

    const myRequestId = ++requestId.current;
    setStatus('loading');
    setError(undefined);
    setIsPermissionError(false);

    Promise.all(groups.map(async (g) => ({ graph: await fetchOneGroupFlowGraph(g.id, unit, timeRangeId), groupName: g.name })))
      .then((entries) => {
        if (myRequestId !== requestId.current) return;
        setGraph(mergeFlowGraphs(entries));
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (myRequestId !== requestId.current) return;
        setStatus('error');
        setIsPermissionError(err instanceof PermissionError);
        setError(err instanceof Error ? err.message : String(err));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `groupIdsKey` stands in for `groups`.
  }, [groupIdsKey, unit, timeRangeId, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { graph, status, error, isPermissionError, refresh };
}
