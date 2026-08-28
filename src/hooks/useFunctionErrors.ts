import { useEffect, useState } from 'react';
import { fetchPipelineFunctionErrors, type FunctionErrorLogEntry } from '../api/logs';
import { realRawIdOf } from '../lib/topologyConfigOnlyMerge';
import type { GraphNode } from '../lib/types';
import type { SignalPathMetrics } from '../lib/topologyConfigOnlyMetrics';

/**
 * Eager, once-per-graph-load fetch of real per-Pipeline function-processing errors — skips the
 * log-search entirely for a pipeline with a real zero `pipe.err_events`, rather than querying every
 * pipeline unconditionally. Reads each pipeline-role node's own real `workerGroupId` directly
 * (never a single page-level group) — correct under "All Worker Groups" too, since a merged node
 * still carries its own real, unscoped originating group; `realRawIdOf`
 * (`lib/topologyConfigOnlyMerge.ts`) recovers the real pipeline id regardless of whether the node's
 * own `id` is scoped by a merge or not.
 */
export function useFunctionErrors(
  pipelineNodes: GraphNode[],
  metrics: SignalPathMetrics | undefined,
  earliest: number,
  latest: number,
): Map<string, FunctionErrorLogEntry[]> {
  const [byNodeId, setByNodeId] = useState<Map<string, FunctionErrorLogEntry[]>>(new Map());

  const withErrors = pipelineNodes.filter((n) => (metrics?.byNodeId.get(n.id)?.errEvents ?? 0) > 0);
  const idsKey = withErrors.map((n) => `${n.id}:${n.workerGroupId}`).join(',');

  useEffect(() => {
    if (withErrors.length === 0) {
      setByNodeId(new Map());
      return;
    }
    let cancelled = false;
    Promise.all(
      withErrors.map(async (node) => {
        const rawId = realRawIdOf(node.id);
        const entries = await fetchPipelineFunctionErrors({ groupId: node.workerGroupId, pipelineId: rawId, earliest, latest }).catch(
          () => [] as FunctionErrorLogEntry[],
        );
        return [node.id, entries] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setByNodeId(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `idsKey` stands in for `withErrors`.
  }, [idsKey, earliest, latest]);

  return byNodeId;
}
