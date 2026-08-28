import { useEffect, useState } from 'react';
import { fetchWorkerStatusesForInputs, fetchWorkerStatusesForOutputs, type WorkerStatusRow } from '../api/workers';
import { realRawIdOf } from '../lib/topologyConfigOnlyMerge';
import { formatBytes, formatMetric } from '../lib/format';
import { WORKER_NOUN, WORKER_NOUN_PLURAL } from '../lib/productTerms';
import type { FlowGraph, GraphNode, GroupProductFilter, HealthStatus } from '../lib/types';

/**
 * Signal Path's own eager, once-per-graph-load per-worker status fetch — one batched call per
 * direction, not one per node — built on the pure `api/workers.ts` functions and this page's own
 * `realRawIdOf` (`lib/topologyConfigOnlyMerge.ts`, this page's own id-scoping scheme).
 *
 * Real per-worker status is this page's own "op status": without it, Source/Destination/Output
 * Router cards would have no live health signal at all (every node defaulting to a flat, neutral
 * placeholder) — this is what drives their real border/background color and the blocked/degraded
 * badge.
 *
 * Grouped by each node's own real `workerGroupId` (never the page's own single selected group) so
 * this works correctly under "All Worker Groups" too — a merged graph's own nodes each still know
 * which real group they actually came from (`mergeConfigOnlyGraphs` never touches that field), so
 * one batched call per *real* group is issued regardless of how many real groups are in scope,
 * same "one call, not one per node" efficiency as the single-group case.
 */

/** Output Router has no per-worker status of its own — it's a routing table, not a real endpoint
 *  — so its rows are its own real targets' rows concatenated, tagged with which target they came
 *  from (mirrors the real app's `destWorkerRowsForNode`, reimplemented locally for the same
 *  isolation reason as the hook above). */
export function workerRowsForNode(node: GraphNode, byNodeId: Map<string, WorkerStatusRow[]>): WorkerStatusRow[] | undefined {
  if (node.kind === 'source' || node.kind === 'destination') return byNodeId.get(node.id);
  if (node.kind === 'outputRouter' && node.routerRuleIds) {
    const rows: WorkerStatusRow[] = [];
    for (const targetId of node.routerRuleIds) {
      const targetRows = byNodeId.get(`destination:${targetId}`);
      if (targetRows) rows.push(...targetRows.map((r) => ({ ...r, destinationLabel: targetId })));
    }
    return rows;
  }
  return undefined;
}

/** Worst-of the real per-worker health readings — `blocked` when every real worker reports `Red`,
 *  `degraded` when some (Red or Yellow) do, `good` when every worker's real, `nodata` when there's
 *  simply nothing to report (no rows fetched yet, or none exist). Deliberately simpler than the
 *  real app's own two-part `deriveHealth`/`withWorkerAlert` split (which layers a worker-alert
 *  escalation on top of a separate volume-based health) — a Source/Destination card here has no
 *  other health concept at all to layer onto, so this *is* the whole story. */
export function healthFromWorkerRows(rows: WorkerStatusRow[] | undefined): HealthStatus {
  if (!rows || rows.length === 0) return 'nodata';
  const redCount = rows.filter((r) => r.health === 'Red').length;
  if (redCount === rows.length) return 'blocked';
  if (redCount > 0 || rows.some((r) => r.health === 'Yellow')) return 'degraded';
  if (rows.some((r) => r.health === 'Green')) return 'good';
  return 'nodata';
}

/** The single worst-off real worker row — `Red` preferred over `Yellow`, matching
 *  `explainWorkerRows`' own selection (kept as a separate export so the Why box's "Open in Cribl"
 *  redirect on an Edge node, which needs that one worker's own real id, doesn't have to re-derive
 *  it a second, possibly-drifting way). `undefined` when nothing is actually blocked/degraded. */
export function worstWorkerRow(rows: WorkerStatusRow[] | undefined): WorkerStatusRow | undefined {
  if (!rows || rows.length === 0) return undefined;
  const bad = rows.filter((r) => r.health === 'Red' || r.health === 'Yellow');
  if (bad.length === 0) return undefined;
  return bad.find((r) => r.health === 'Red') ?? bad[0];
}

/** One plain-language sentence explaining *why* a Source/Destination/Output Router reads
 *  blocked/degraded — composed from data this hook already fetches (the real per-worker error
 *  string, buffered backlog), not a second data source. `undefined` whenever there's nothing
 *  wrong to explain (every worker's real, or no rows at all) — a healthy component gets no Why
 *  box, matching this app's own established "don't show a redundant confirming line" convention
 *  (see e.g. the card-level worker-alert badge, which is likewise absent rather than green).
 *  `product` (default `'stream'`, matching every real KV entry saved before this parameter
 *  existed) picks "worker"/"workers" vs. "node"/"nodes" per `lib/productTerms.ts` — this
 *  underlying data is always a real per-worker-*process* status row regardless of product, but an
 *  Edge Fleet's own process is called a Node, not a Worker. */
export function explainWorkerRows(rows: WorkerStatusRow[] | undefined, product: GroupProductFilter = 'stream'): string | undefined {
  if (!rows || rows.length === 0) return undefined;
  const bad = rows.filter((r) => r.health === 'Red' || r.health === 'Yellow');
  if (bad.length === 0) return undefined;
  const worst = bad.find((r) => r.health === 'Red') ?? bad[0];
  const scope =
    bad.length === rows.length
      ? `Every ${WORKER_NOUN[product].toLowerCase()}`
      : `${bad.length} of ${rows.length} ${WORKER_NOUN_PLURAL[product].toLowerCase()}`;
  const cause = worst.error?.message ?? 'is reporting a problem, with no specific error returned';
  const detail = worst.error?.detail ? ` (${worst.error.detail})` : '';
  const hasBacklog = (worst.bufferedEvents ?? 0) > 0;
  const backlog = hasBacklog
    ? ` ${formatMetric(worst.bufferedEvents!, 'events')}${worst.bufferedBytes !== undefined ? ` (${formatBytes(worst.bufferedBytes)})` : ''} is queuing in the buffer.`
    : '';
  return `${scope} report${bad.length === 1 ? 's' : ''} ${cause}${detail}.${backlog}`;
}

export function useWorkerStatus(graph: FlowGraph | undefined): Map<string, WorkerStatusRow[]> {
  const [byNodeId, setByNodeId] = useState<Map<string, WorkerStatusRow[]>>(new Map());
  const sourceNodes = graph?.nodes.filter((n) => n.kind === 'source') ?? [];
  const destNodes = graph?.nodes.filter((n) => n.kind === 'destination') ?? [];
  const idsKey = [...sourceNodes, ...destNodes].map((n) => `${n.id}:${n.workerGroupId}`).join(',');

  useEffect(() => {
    if (sourceNodes.length === 0 && destNodes.length === 0) {
      setByNodeId(new Map());
      return;
    }
    let cancelled = false;
    const realGroupIds = [...new Set([...sourceNodes, ...destNodes].map((n) => n.workerGroupId))];
    Promise.all(
      realGroupIds.map(async (gid) => {
        const srcInGroup = sourceNodes.filter((n) => n.workerGroupId === gid);
        const destInGroup = destNodes.filter((n) => n.workerGroupId === gid);
        const [srcById, destById] = await Promise.all([
          fetchWorkerStatusesForInputs(
            gid,
            srcInGroup.map((n) => realRawIdOf(n.id)),
          ),
          fetchWorkerStatusesForOutputs(
            gid,
            destInGroup.map((n) => realRawIdOf(n.id)),
          ),
        ]);
        const combined = new Map<string, WorkerStatusRow[]>();
        for (const n of srcInGroup) combined.set(n.id, srcById.get(realRawIdOf(n.id)) ?? []);
        for (const n of destInGroup) combined.set(n.id, destById.get(realRawIdOf(n.id)) ?? []);
        return combined;
      }),
    )
      .then((maps) => {
        if (cancelled) return;
        const merged = new Map<string, WorkerStatusRow[]>();
        for (const m of maps) for (const [k, v] of m) merged.set(k, v);
        setByNodeId(merged);
      })
      .catch(() => {
        // Most likely: this org hasn't granted the /master/workers policy — degrade to no
        // breakdown (every card reads 'nodata', i.e. its current neutral default) rather than error.
        if (!cancelled) setByNodeId(new Map());
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `idsKey` stands in for `sourceNodes`/`destNodes`.
  }, [idsKey]);

  return byNodeId;
}
