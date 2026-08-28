import { useEffect, useState } from 'react';
import { fetchWorkerStatusesForOutputs, type WorkerStatusRow } from '../api/workers';
import { realRawIdOf } from '../lib/topology';
import { worseOf } from '../lib/health';
import type { GraphNode, HealthStatus } from '../lib/types';

export interface UseDestinationWorkerAlertsResult {
  /** Keyed by Destination node id (e.g. `destination:local_splunk`), not the bare Cribl id. */
  workerStatusByDestination: Map<string, WorkerStatusRow[]>;
  status: 'idle' | 'loading' | 'ready' | 'error';
}

/**
 * How badly a Destination is blocked, by real per-worker status — `'all'` when every Worker
 * process reports `Red` for it, `'partial'` when some (not all) do, `'none'` otherwise. The
 * distinction matters because a Destination genuinely down on every worker is a different
 * severity of problem than one that's degraded on some workers but still getting through on
 * others — see CLAUDE.md's Thirtieth round for how this real, per-worker signal (as opposed to
 * the group-scoped status this app uses everywhere else, which rolls every worker into one
 * aggregate and can miss this entirely) was found and confirmed.
 */
export type WorkerAlertSeverity = 'none' | 'partial' | 'all';

export function workerAlertSeverity(rows: WorkerStatusRow[] | undefined): WorkerAlertSeverity {
  const list = rows ?? [];
  if (list.length === 0) return 'none';
  const blockedCount = list.filter((r) => r.health === 'Red').length;
  if (blockedCount === 0) return 'none';
  return blockedCount === list.length ? 'all' : 'partial';
}

/**
 * Folds a worker-alert severity into a base `HealthStatus` for display — `'all'` escalates to at
 * least `blocked` (red), `'partial'` to at least `degraded` (orange), `'none'` leaves the base
 * status untouched. Uses `worseOf` (never *downgrades* an already-worse base status), so e.g. a
 * flow that's already `blocked` by volume stays `blocked` rather than being pulled down to
 * `degraded` by a merely-partial worker alert.
 */
export function withWorkerAlert(baseHealth: HealthStatus, severity: WorkerAlertSeverity): HealthStatus {
  if (severity === 'all') return worseOf(baseHealth, 'blocked');
  if (severity === 'partial') return worseOf(baseHealth, 'degraded');
  return baseHealth;
}

/**
 * Real per-worker Destination status for every Destination in the graph, fetched once per graph
 * load — not per row, and not on hover. Flow Explorer's blocked-worker badge needs to know
 * *up front* whether to show itself at all (unlike the Signal Path drawer, which only fetches
 * this on-demand when a user opens one specific node), so unlike that on-demand pattern, this is
 * eager: one call per unique Destination x Worker in the group, in parallel, mirroring
 * `useFlowSummaryTrends`'s "fetch once per graph load, keyed by stable ids" shape rather than
 * `NodeDetailPanel`'s "fetch only while this one thing is open" shape.
 *
 * Groups `destinationNodes` by each node's own real `workerGroupId` — not a single shared group
 * param — since the "All Worker Groups" view can hand this a `mergeFlowGraphs` merge spanning
 * several real groups at once; every node still knows which real group it actually belongs to
 * (`realRawIdOf`/`workerGroupId`, both unaffected by that merge's own id-scoping), so this reduces
 * to exactly the old single-call behavior whenever all nodes happen to share one group.
 */
export function useDestinationWorkerAlerts(destinationNodes: GraphNode[]): UseDestinationWorkerAlertsResult {
  const [workerStatusByDestination, setWorkerStatusByDestination] = useState<Map<string, WorkerStatusRow[]>>(new Map());
  const [status, setStatus] = useState<UseDestinationWorkerAlertsResult['status']>('idle');

  // Keyed on the destination ids themselves, not the array reference — `destinationNodes` is
  // typically a fresh array every graph refresh even when its contents are unchanged, the same
  // reasoning `useFlowSummaryTrends`'s `summaryIdsKey` already relies on.
  const destinationIdsKey = destinationNodes.map((n) => n.id).join(',');

  useEffect(() => {
    if (destinationNodes.length === 0) {
      setStatus('idle');
      setWorkerStatusByDestination(new Map());
      return;
    }

    let cancelled = false;
    setStatus('loading');

    const nodesByGroup = new Map<string, GraphNode[]>();
    for (const node of destinationNodes) {
      const list = nodesByGroup.get(node.workerGroupId);
      if (list) list.push(node);
      else nodesByGroup.set(node.workerGroupId, [node]);
    }

    Promise.all(
      [...nodesByGroup.entries()].map(async ([groupId, nodes]) => {
        const nodeIdByOutputId = new Map(nodes.map((n) => [realRawIdOf(n), n.id]));
        const byOutputId = await fetchWorkerStatusesForOutputs(groupId, [...nodeIdByOutputId.keys()]);
        const entries: [string, WorkerStatusRow[]][] = [];
        for (const [outputId, rows] of byOutputId) {
          const nodeId = nodeIdByOutputId.get(outputId);
          if (nodeId) entries.push([nodeId, rows]);
        }
        return entries;
      }),
    )
      .then((perGroupEntries) => {
        if (cancelled) return;
        setWorkerStatusByDestination(new Map(perGroupEntries.flat()));
        setStatus('ready');
      })
      .catch(() => {
        // Most likely: this app's org hasn't granted the /master/workers policy at install time
        // (an older install, before this capability existed) — degrade to no breakdown rather
        // than an error, since the existing group-scoped headline status still renders regardless.
        if (!cancelled) {
          setWorkerStatusByDestination(new Map());
          setStatus('error');
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `destinationIdsKey` stands in for `destinationNodes`.
  }, [destinationIdsKey]);

  return { workerStatusByDestination, status };
}
