import { useEffect, useState } from 'react';
import { fetchWorkerStatusesForInputs, type WorkerStatusRow } from '../api/workers';
import { realRawIdOf } from '../lib/topology';
import type { GraphNode } from '../lib/types';

export interface UseSourceWorkerAlertsResult {
  /** Keyed by Source node id (e.g. `source:apache_error`), not the bare Cribl id. */
  workerStatusBySource: Map<string, WorkerStatusRow[]>;
  status: 'idle' | 'loading' | 'ready' | 'error';
}

/**
 * The Source-side mirror of `useDestinationWorkerAlerts` — same real per-worker signal
 * (`/w/:workerId/system/status/inputs/:id`, confirmed live alongside the Destination endpoint this
 * app already used — see CLAUDE.md's Thirtieth/PQ rounds), same "fetch eagerly once per graph load,
 * not on hover" shape, same one-`listWorkers()`-call-total efficiency. Routes and Pipelines have no
 * equivalent per-worker connector status endpoint in Cribl's documented API (they aren't
 * connectors — no `/w/:workerId/system/status/{routes,pipelines}` exists in this project's own
 * `openapi.json`), so Source is the only other component kind this signal genuinely extends to.
 */
export function useSourceWorkerAlerts(sourceNodes: GraphNode[]): UseSourceWorkerAlertsResult {
  const [workerStatusBySource, setWorkerStatusBySource] = useState<Map<string, WorkerStatusRow[]>>(new Map());
  const [status, setStatus] = useState<UseSourceWorkerAlertsResult['status']>('idle');

  const sourceIdsKey = sourceNodes.map((n) => n.id).join(',');

  useEffect(() => {
    if (sourceNodes.length === 0) {
      setStatus('idle');
      setWorkerStatusBySource(new Map());
      return;
    }

    let cancelled = false;
    setStatus('loading');

    const nodesByGroup = new Map<string, GraphNode[]>();
    for (const node of sourceNodes) {
      const list = nodesByGroup.get(node.workerGroupId);
      if (list) list.push(node);
      else nodesByGroup.set(node.workerGroupId, [node]);
    }

    Promise.all(
      [...nodesByGroup.entries()].map(async ([groupId, nodes]) => {
        const nodeIdByInputId = new Map(nodes.map((n) => [realRawIdOf(n), n.id]));
        const byInputId = await fetchWorkerStatusesForInputs(groupId, [...nodeIdByInputId.keys()]);
        const entries: [string, WorkerStatusRow[]][] = [];
        for (const [inputId, rows] of byInputId) {
          const nodeId = nodeIdByInputId.get(inputId);
          if (nodeId) entries.push([nodeId, rows]);
        }
        return entries;
      }),
    )
      .then((perGroupEntries) => {
        if (cancelled) return;
        setWorkerStatusBySource(new Map(perGroupEntries.flat()));
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) {
          setWorkerStatusBySource(new Map());
          setStatus('error');
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sourceIdsKey` stands in for `sourceNodes`.
  }, [sourceIdsKey]);

  return { workerStatusBySource, status };
}
