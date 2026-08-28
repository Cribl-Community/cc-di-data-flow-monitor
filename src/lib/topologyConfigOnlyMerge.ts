import { mergeFlowGraphs } from './topology';
import type { FlowGraph, GraphNode } from './types';
import type { SignalPathMetrics, ComponentStats } from './topologyConfigOnlyMetrics';
import type { RuleLike } from '../components/FlowCanvas/NodeCard';

/**
 * Signal Path's own "All Worker Groups" support for its config-only graph. Reuses the shared,
 * already-established `mergeFlowGraphs` (`lib/topology.ts`) read-only, unmodified, to combine
 * multiple groups' `FlowGraph`s into one exactly the way the legacy topology builder does — every
 * graph-level id (node ids, `edge.routeIds`, etc.) re-prefixed as `{groupId}::{rawId}`,
 * `GraphNode.workerGroupId` preserved as each node's own *real*, unscoped group (never
 * overwritten), so a real Cribl API call for one specific node/rule can still resolve the right
 * group to call into.
 *
 * One real gap `mergeFlowGraphs` itself leaves open, found while porting this: it re-scopes every
 * *graph-level* field but never touches a Routes node's own `raw` (the original, unscoped Cribl
 * route-table config) — the legacy topology's own rule-row rendering reads a rule's id from
 * graph-level fields (`node.routeRuleHealth`, already re-scoped), but Signal Path's own config-only
 * rule-row rendering (`NodeCard.tsx`, `FlowCanvas.tsx`) reads `node.raw.routes[i].id` directly. Left
 * unaddressed, a merged Routes card's own rule rows would look up `SignalPathMetrics.byRuleId` with
 * the *wrong* (unscoped) key, and two groups sharing an identical rule id would collide.
 * `rescopeRoutesRaw` fixes this the same way `mergeFlowGraphs` fixes everything else: rewriting
 * just the `id` field of each rule inside a shallow-cloned `raw.routes[]` array to the exact same
 * `{groupId}::{ruleId}` scheme `mergeConfigOnlyMetrics` below uses for its own `byRuleId` keys —
 * every existing lookup via `rule.id` across `NodeCard.tsx`/`FlowCanvas.tsx`/
 * `NodeDetailPanel.tsx` then just works, unmodified, since it always reads through this one
 * already-corrected field. `rule.name`/`.filter`/`.final`/`.disabled` are left untouched — display
 * fields, not lookup keys.
 */
function rescopeRoutesRaw(graph: FlowGraph): FlowGraph {
  const nodes = graph.nodes.map((node): GraphNode => {
    if (node.kind !== 'routes') return node;
    const raw = node.raw as { routes: RuleLike[] } | undefined;
    if (!raw?.routes) return node;
    // A merged node's own `id` is `routes:{groupId}::{tableId}` — the real group id sits between
    // the first `:` and the following `::`. A node that was never actually merged (only one real
    // group in scope) has no `::` at all — left alone, nothing to rescope.
    const afterKind = node.id.slice(node.id.indexOf(':') + 1);
    const sep = afterKind.indexOf('::');
    if (sep === -1) return node;
    const groupId = afterKind.slice(0, sep);
    return { ...node, raw: { ...raw, routes: raw.routes.map((r) => ({ ...r, id: `${groupId}::${r.id}` })) } };
  });
  return { ...graph, nodes };
}

export function mergeConfigOnlyGraphs(entries: { graph: FlowGraph; groupName: string }[]): FlowGraph {
  return rescopeRoutesRaw(mergeFlowGraphs(entries));
}

/** Mirrors `mergeConfigOnlyGraphs`'s own id scheme exactly — every `byNodeId` key gets the same
 *  `{kind}:{groupId}::{rawId}` prefix `mergeFlowGraphs` gives the matching graph node, and every
 *  `byRuleId` key gets the same `{groupId}::{ruleId}` prefix `rescopeRoutesRaw` just gave that
 *  rule's own `raw.routes[i].id` — so every lookup in `FlowCanvas.tsx`/`NodeCard.tsx`/
 *  `NodeDetailPanel.tsx` (all of which read through the graph's own, now-rescoped, ids) resolves
 *  correctly with no changes needed in any of those three files. Each `SourceShare
 *  .sourceNodeId` inside `stats.sources[]` is rescoped too, for the identical reason — it's a
 *  node-id reference `FlowCanvas.tsx`'s own hover-highlight matching reads directly. A row's
 *  own optional `attributedSourceIds` (the Output Router "Multiple Sources" case — see that
 *  field's own doc comment in `topologyConfigOnlyMetrics.ts`) gets the identical treatment, one
 *  entry at a time, for the same reason. Not every `sourceNodeId` in this app is shaped
 *  `source:<rawId>` (the router-derived "Multiple Sources" row's own id is a synthetic
 *  `router-multi:...` placeholder, never a real Source reference) — `rescopeSourceId` falls back
 *  to a plain `{groupId}::` prefix for anything that isn't, which is all that's actually required
 *  of it: staying unique once two groups' own ids are combined into one graph, not resolving to a
 *  real node. */
function rescopeSourceId(id: string, groupId: string): string {
  return id.startsWith('source:') ? `source:${groupId}::${id.slice('source:'.length)}` : `${groupId}::${id}`;
}

export function mergeConfigOnlyMetrics(entries: { metrics: SignalPathMetrics; groupId: string }[]): SignalPathMetrics {
  if (entries.length === 1) return entries[0].metrics;

  const byNodeId = new Map<string, ComponentStats>();
  const byRuleId = new Map<string, ComponentStats>();

  const rescopeSources = (sources: ComponentStats['sources'], groupId: string) =>
    sources.map((s) => ({
      ...s,
      sourceNodeId: rescopeSourceId(s.sourceNodeId, groupId),
      attributedSourceIds: s.attributedSourceIds?.map((id) => rescopeSourceId(id, groupId)),
    }));

  for (const { metrics, groupId } of entries) {
    for (const [nodeId, stats] of metrics.byNodeId) {
      const kind = nodeId.slice(0, nodeId.indexOf(':'));
      const rawId = nodeId.slice(kind.length + 1);
      byNodeId.set(`${kind}:${groupId}::${rawId}`, { ...stats, sources: rescopeSources(stats.sources, groupId) });
    }
    for (const [ruleId, stats] of metrics.byRuleId) {
      byRuleId.set(`${groupId}::${ruleId}`, { ...stats, sources: rescopeSources(stats.sources, groupId) });
    }
  }

  return { byNodeId, byRuleId };
}

/** Strips a node id's own `{kind}:` prefix, and — for a node from `mergeConfigOnlyGraphs`'s own
 *  "All Worker Groups" merge — its `{groupId}::` scope prefix too, recovering the real, bare Cribl
 *  id underneath either way. Every Signal Path node id is `{kind}:{rawId}` normally, or
 *  `{kind}:{groupId}::{rawId}` once merged — this is the one place that needs to handle both
 *  shapes uniformly, used anywhere a node id is about to feed a real Cribl API call. */
export function realRawIdOf(nodeId: string): string {
  const afterKind = nodeId.slice(nodeId.indexOf(':') + 1);
  const sep = afterKind.indexOf('::');
  return sep === -1 ? afterKind : afterKind.slice(sep + 2);
}

/** Mirrors `realRawIdOf` for a Route rule id specifically — `{ruleId}` normally, or
 *  `{groupId}::{ruleId}` once rescoped by `rescopeRoutesRaw` above — used anywhere a rule's own
 *  real Cribl id is about to feed a real API call (the drawer's own Trend fetch). */
export function realRuleId(ruleId: string): string {
  const sep = ruleId.indexOf('::');
  return sep === -1 ? ruleId : ruleId.slice(sep + 2);
}

/** The real, unscoped Worker Group id a (possibly rescoped) rule id belongs to — `undefined` for
 *  an unmerged rule id, in which case the caller already knows the real group some other way (the
 *  page's own single selected group). */
export function ruleGroupId(ruleId: string): string | undefined {
  const sep = ruleId.indexOf('::');
  return sep === -1 ? undefined : ruleId.slice(0, sep);
}
