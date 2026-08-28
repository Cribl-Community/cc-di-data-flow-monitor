import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text, EmptyState, Spinner, Drawer, IconButton, Tooltip, CustomTooltipTrigger } from '@capra/core';
import { ReloadOutlined, PushpinOutlined, PushpinSolid, CloseOutlined } from '@capra/icons';
import { useAppState } from '../state/AppState';
import { isGroupOfProduct, isSupportedGroup } from '../api/groups';
import { fetchTopologyBundle, type RawTopologyBundle } from '../api/topology';
import { escapeFilterLiteral } from '../api/metrics';
import { listWorkers } from '../api/workers';
import { buildWorkerGroupByHostname } from '../lib/crossDeploymentChain';
import { timeRangeToWindow } from '../hooks/useFlowGraph';
import { buildConfigOnlyGraph } from '../lib/topologyConfigOnly';
import { fetchConfigOnlyMetrics, applyBlockedDestinationCorrection, type SignalPathMetrics } from '../lib/topologyConfigOnlyMetrics';
import { mergeConfigOnlyGraphs, mergeConfigOnlyMetrics, realRawIdOf, realRuleId, ruleGroupId } from '../lib/topologyConfigOnlyMerge';
import { useSkipFirstEffect, useDebouncedCallback } from '../hooks/useAutoRefreshOnFilterChange';
import { useFunctionErrors } from '../hooks/useFunctionErrors';
import { useWorkerStatus, workerRowsForNode } from '../hooks/useWorkerStatus';
import { FlowCanvas, type SignalPathCaptureContext } from '../components/FlowCanvas/FlowCanvas';
import type { RuleLike } from '../components/FlowCanvas/NodeCard';
import { NodeDetailPanel } from '../components/NodeDetailPanel';
import { PageHeader } from '../components/PageHeader';
import { CapturePanel } from '../components/CapturePanel';
import { DrawerResizeHandle } from '../components/DrawerResizeHandle';
import { useResizableDrawerWidth } from '../hooks/useResizableDrawerWidth';
import { useClickOutside } from '../lib/useClickOutside';
import { ALL_GROUPS_ID, AUTO_REFRESH_OPTIONS, CAPTURE_LEVEL_LABEL, type FlowGraph, type GraphNode, type GroupProductFilter, type NodeKind } from '../lib/types';
import { GROUP_NOUN } from '../lib/productTerms';
import './SignalPathPage.css';

/** Below the drawer's own title (component name / rule name / capture label), a slightly smaller
 *  line naming the kind of thing that is — e.g. "PIPELINE". Routes never opens this drawer (each
 *  rule row does instead, handled by the `'rule'` case), so it has no entry here. */
const NODE_KIND_SUBTITLE: Partial<Record<NodeKind, string>> = {
  source: 'Source',
  prePipeline: 'Pre-Processing Pipeline',
  pipeline: 'Pipeline',
  postPipeline: 'Post-Processing Pipeline',
  destination: 'Destination',
  outputRouter: 'Output Router',
};

type Selection =
  | { kind: 'node'; node: GraphNode }
  | { kind: 'rule'; rule: RuleLike }
  | { kind: 'capture'; context: SignalPathCaptureContext }
  | undefined;

/** Pre-fills a capture checkpoint's own filter expression from the exact same real per-source
 *  attribution already shown in that node's own Sources table (`SignalPathMetrics.byNodeId`) — no
 *  graph walk needed, since this page's own metrics module already computes genuine per-source
 *  attribution for every node directly. A Source checkpoint has no `sources[]` of its own (it *is*
 *  the source), so it's built directly from that Source's own real connector type/id instead.
 *  Routes gets no default filter at all — every Source in the graph converges there, matching the
 *  established precedent for this one checkpoint ("no single upstream set to attribute it to").
 *  `bundlesByGroup` (not a single bundle) since "All Worker Groups" fetches one real bundle per
 *  real group — `context.groupId` (always a real, unscoped group, set from `node.workerGroupId`
 *  when the icon was built) picks out the right one. */
function captureDefaultFilterFor(
  context: SignalPathCaptureContext,
  metrics: SignalPathMetrics | undefined,
  bundlesByGroup: Map<string, RawTopologyBundle>,
): string | undefined {
  if (context.kind === 'routes') return undefined;
  const bundle = bundlesByGroup.get(context.groupId);
  const inputTypeByRawId = new Map((bundle?.inputs ?? []).map((i) => [i.id, i.type]));
  if (context.kind === 'source') {
    const rawId = realRawIdOf(context.nodeId);
    const type = inputTypeByRawId.get(rawId);
    return type ? `__inputId=='${escapeFilterLiteral(`${type}:${rawId}`)}'` : undefined;
  }
  const sources = metrics?.byNodeId.get(context.nodeId)?.sources ?? [];
  const clauses = sources
    .map((s) => {
      const type = inputTypeByRawId.get(s.label);
      return type ? `__inputId=='${escapeFilterLiteral(`${type}:${s.label}`)}'` : undefined;
    })
    .filter((c): c is string => c !== undefined);
  return clauses.length > 0 ? clauses.join(' || ') : undefined;
}

/** Destination/Output Router drawers have an extra Pipeline column in their own Sources table —
 *  wider than every other kind's drawer needs. Capture reuses the same wider width as a plain
 *  node/rule drawer (raw JSON capture events read better with more room). */
function drawerWidthFor(selection: Selection): number | undefined {
  if (!selection) return undefined;
  if (selection.kind === 'node' && (selection.node.kind === 'destination' || selection.node.kind === 'outputRouter')) return 760;
  return 640;
}

/**
 * Signal Path — the single-pane, end-to-end wiring diagram: Source -> Pre-Processing -> Routes ->
 * Pipeline -> Post-Processing -> Destination. The diagram itself stays config-only (no metrics
 * fetched to draw it — see `buildConfigOnlyGraph`'s own doc comment); real volume/attribution data
 * is fetched separately (`fetchConfigOnlyMetrics`, `lib/topologyConfigOnlyMetrics.ts`) and shown
 * only in the click-to-open detail drawer, driven by the shared top-bar Worker Group/Time
 * Range/Status filter (`AppState`, via `PageHeader`) — the same controls every other dashboard
 * uses. Events is the only unit shown across cards/canvas — no page-level Events/Bytes toggle
 * (`PageHeader`'s `showMetricToggle={false}` below); Bytes only ever appears as a secondary line
 * on Source/Destination cards, an aggregate row in their own drawers, and — for Destination
 * specifically, where a real per-source breakdown exists — the Sources table's own local switcher
 * (`NodeDetailPanel.tsx`).
 */
export function SignalPathPage() {
  const { state, dispatch, refreshWorkerGroups } = useAppState();
  // The top bar's own currently-toggled product's noun — used for this page's own empty states
  // below, which are scoped to that same single toggle (unlike a per-node badge/drawer, which
  // needs the *specific* node's own real product — see `groupProductById` further down).
  const groupNoun = GROUP_NOUN[state.groupProductFilter];
  // Unfiltered across both products — a cross-deployment chain hop (see `crossDeploymentChain.ts`)
  // can legitimately land in a different product than the top-left toggle's current selection
  // (e.g. an Edge Fleet chaining into a Stream Worker Group), so the chain-link target lookup and
  // click handler below deliberately don't go through the product-filtered `supportedGroups`
  // further down — only the page's own real data-fetch scope does.
  const allSupportedGroups = useMemo(() => state.workerGroups.filter(isSupportedGroup), [state.workerGroups]);
  // Real display names for whichever groups a cross-deployment chain hop might resolve to — scoped
  // to `allSupportedGroups`, not every group this org has, so the chain UI only ever offers to
  // pivot somewhere the picker can actually show; a hop resolving to an unsupported group
  // (Search/Outpost) renders as a plain Destination instead of a broken link.
  const groupNameById = useMemo(() => new Map(allSupportedGroups.map((g) => [g.id, g.name] as const)), [allSupportedGroups]);
  // Real product per real, unscoped group id — lets every node card/badge/drawer say "Worker"/
  // "Node" correctly regardless of which product it actually belongs to, unlike the top bar's own
  // single `state.groupProductFilter` (wrong under "All Worker Groups," where Stream and Edge
  // nodes render side by side on the same canvas). `g.type` is always real 'stream'/'edge' here —
  // `allSupportedGroups` is already filtered to just those two via `isSupportedGroup`.
  const groupProductById = useMemo(
    () => new Map(allSupportedGroups.map((g) => [g.id, g.type as GroupProductFilter] as const)),
    [allSupportedGroups],
  );
  const handleChainClick = useCallback(
    (targetGroupId: string) => {
      const target = allSupportedGroups.find((g) => g.id === targetGroupId);
      if (!target) return;
      // Pivoting to a group of a different product than the top-left toggle's current selection
      // needs the toggle switched first — otherwise the Worker Group dropdown wouldn't even list
      // the target we're about to select into `selectedGroupId`.
      if ((target.type === 'stream' || target.type === 'edge') && target.type !== state.groupProductFilter) {
        dispatch({ type: 'groupProductFilter/set', product: target.type });
      }
      dispatch({ type: 'group/select', groupId: targetGroupId });
    },
    [dispatch, allSupportedGroups, state.groupProductFilter],
  );
  // The page's own real data-fetch scope — just the currently toggled product's groups.
  const supportedGroups = useMemo(
    () => allSupportedGroups.filter((g) => isGroupOfProduct(g, state.groupProductFilter)),
    [allSupportedGroups, state.groupProductFilter],
  );
  const groupId = state.selectedGroupId;
  const isAllGroups = groupId === ALL_GROUPS_ID;
  // The real, individual groups actually in scope — every Stream Worker Group and Edge Fleet under
  // "All Worker Groups", or just the one selected group otherwise. Everything below (bundle fetch,
  // graph/metrics build, per-node worker status) fans out per real group in this list, never
  // against the `ALL_GROUPS_ID` sentinel itself, which isn't a real, queryable Worker Group.
  const scopedGroups = useMemo(
    () => (isAllGroups ? supportedGroups : supportedGroups.filter((g) => g.id === groupId)),
    [isAllGroups, supportedGroups, groupId],
  );
  const scopedGroupIdsKey = scopedGroups.map((g) => g.id).join(',');

  const [bundlesByGroup, setBundlesByGroup] = useState<Map<string, RawTopologyBundle>>(new Map());
  // Real `host -> groupId` lookup for resolving a cross-deployment chain hop (see
  // `crossDeploymentChain.ts`), fetched once per load alongside the topology bundles — app-wide,
  // not per-group, since `/master/workers` is unscoped and a chain target can be a *different*
  // group than the one being built. Degrades to an empty map (no chain links shown, not an error)
  // if `/master/workers` isn't granted, the same established fallback every other on-demand
  // worker-status consumer in this app already uses.
  const [workerGroupByHostname, setWorkerGroupByHostname] = useState<Map<string, string>>(new Map());
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>(undefined);
  const [selection, setSelection] = useState<Selection>(undefined);
  const [pinned, setPinned] = useState(false);
  const { earliest, latest } = useMemo(() => timeRangeToWindow(state.timeRangeId), [state.timeRangeId]);

  const loadTopology = useCallback(() => {
    if (scopedGroups.length === 0) {
      setStatus('idle');
      return;
    }
    setStatus('loading');
    Promise.all([
      Promise.all(scopedGroups.map((g) => fetchTopologyBundle(g.id).then((b) => [g.id, b] as const))),
      listWorkers()
        .then(buildWorkerGroupByHostname)
        .catch(() => new Map<string, string>()),
    ])
      .then(([entries, hostnameMap]) => {
        setBundlesByGroup(new Map(entries));
        setWorkerGroupByHostname(hostnameMap);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
        setStatus('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `scopedGroupIdsKey` stands in for `scopedGroups`.
  }, [scopedGroupIdsKey]);

  useEffect(() => {
    loadTopology();
  }, [loadTopology]);

  // The manual Refresh button and the auto-refresh timer both go through this, not `loadTopology`
  // directly, so the top bar's "Pending Commit & Deploy" tag (`PageHeader.tsx`) picks up fresh
  // `pendingCommits`/`pendingDeploy` values on both real refresh triggers — not on every mount/
  // Worker-Group-switch re-run of `loadTopology` itself, which `state.workerGroups` already covers
  // via its own initial load.
  const handleRefresh = useCallback(() => {
    loadTopology();
    void refreshWorkerGroups();
  }, [loadTopology, refreshWorkerGroups]);

  // Worker Group/Product/Time Range switches already trigger a real background refetch on their
  // own (they're real inputs to `loadTopology`/the metrics-fetch effects above) — the shared status
  // filter doesn't (it's a pure client-side narrowing of already-fetched `graph`/`metrics`), so it
  // gets its own explicit trigger here. This is also what keeps the canvas's own edges/rects from
  // ever going stale relative to a filter change: a real background refresh replaces `graph`/
  // `metrics` with fresh object references, forcing a full remeasure regardless of how the filter
  // itself is implemented.
  useSkipFirstEffect(handleRefresh, [state.statusFilter, state.topSourcesEnabled]);
  // Debounced so a lane's own free-text search box triggers one background refresh shortly after
  // typing stops, not one per keystroke — see `FlowCanvas`'s own `onFilterChange` prop.
  const debouncedRefreshOnTextFilter = useDebouncedCallback(handleRefresh, 600);

  // One config-only graph per real group, merged into one (`mergeConfigOnlyGraphs` — reuses the
  // shared `mergeFlowGraphs`, `lib/topology.ts`, plus this page's own rule-id-scoping fix on top;
  // see that function's own doc comment) whenever more than one real group is in scope. A
  // single-group graph is returned unchanged, so this is a no-op wrapper in the common case.
  const perGroupGraphs = useMemo(() => {
    const result = new Map<string, FlowGraph>();
    for (const [gid, bundle] of bundlesByGroup) result.set(gid, buildConfigOnlyGraph(bundle, workerGroupByHostname));
    return result;
  }, [bundlesByGroup, workerGroupByHostname]);

  const graph = useMemo(() => {
    const entries = scopedGroups
      .filter((g) => perGroupGraphs.has(g.id))
      .map((g) => ({ graph: perGroupGraphs.get(g.id)!, groupName: g.name ?? g.id }));
    return entries.length > 0 ? mergeConfigOnlyGraphs(entries) : undefined;
  }, [perGroupGraphs, scopedGroups]);

  // Real events/bytes/attribution — deliberately fetched separately from the diagram itself, and
  // only once every real group's own diagram exists (the Output Router rollup inside
  // `fetchConfigOnlyMetrics` needs its real targets' node ids, which only the built graph has).
  // Not re-fetched on every drawer open — one fetch per Worker Group/time-range covers every
  // component at once, since the drawer can be opened repeatedly without a new round trip each
  // time. Fetched per real group (Cribl's own metrics API has no cross-group query shape) and
  // merged the same way the graph itself is (`mergeConfigOnlyMetrics`).
  const [metricsByGroup, setMetricsByGroup] = useState<Map<string, SignalPathMetrics>>(new Map());
  const [metricsStatus, setMetricsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  useEffect(() => {
    if (bundlesByGroup.size === 0 || perGroupGraphs.size === 0) return;
    let cancelled = false;
    setMetricsStatus('loading');
    const fetches: Promise<readonly [string, SignalPathMetrics]>[] = [];
    for (const [gid, bundle] of bundlesByGroup) {
      const g = perGroupGraphs.get(gid);
      if (!g) continue;
      fetches.push(fetchConfigOnlyMetrics(gid, earliest, latest, bundle, g).then((m) => [gid, m] as const));
    }
    Promise.all(fetches)
      .then((entries) => {
        if (cancelled) return;
        setMetricsByGroup(new Map(entries));
        setMetricsStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setMetricsStatus('error');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundlesByGroup, perGroupGraphs, earliest, latest]);

  const metrics = useMemo(() => {
    if (metricsByGroup.size === 0) return undefined;
    return mergeConfigOnlyMetrics([...metricsByGroup.entries()].map(([gid, m]) => ({ metrics: m, groupId: gid })));
  }, [metricsByGroup]);

  // Real per-function processing-error log entries, pipeline-role nodes only — fetched eagerly
  // (once per graph/metrics load) since the error badge shows on the *card*, not just the drawer.
  const pipelineNodes = useMemo(
    () => graph?.nodes.filter((n) => n.kind === 'pipeline' || n.kind === 'prePipeline' || n.kind === 'postPipeline') ?? [],
    [graph],
  );
  const functionErrorsByNodeId = useFunctionErrors(pipelineNodes, metrics, earliest, latest);

  // Real per-worker connector status — Source/Destination directly, Output Router rolled up from
  // its real targets (see `workerRowsForNode`). Fetched once per graph load, the same shape as
  // `metrics` above, and reused both for card coloring/badges (`FlowCanvas` -> `NodeCard`)
  // and the drawer's own Per-worker status table, rather than fetched again on every drawer open.
  const workerStatusByNodeId = useWorkerStatus(graph);

  // Real per-worker "genuinely stuck" correction (see `applyBlockedDestinationCorrection`'s own
  // doc comment for why this is a pure, cheap render-time derivation and not baked into
  // `fetchConfigOnlyMetrics` itself). `metrics`/`workerStatusByNodeId` resolve on two independent
  // timelines, so this always reflects whichever is current rather than whatever
  // `workerStatusByNodeId` happened to be at the moment the metrics fetch itself started.
  const correctedMetrics = useMemo(
    () => (metrics && graph ? applyBlockedDestinationCorrection(metrics, graph, workerStatusByNodeId) : metrics),
    [metrics, graph, workerStatusByNodeId],
  );

  // Same shared `state.autoRefreshId` preference every other dashboard already reads — re-runs the
  // whole load chain (topology -> graph -> metrics -> worker status -> function errors, each
  // already its own effect keyed off `bundle`/`graph` changing) exactly like the manual Refresh
  // button does.
  useEffect(() => {
    if (status !== 'ready' || state.autoRefreshId === 'off') return;
    const ms = AUTO_REFRESH_OPTIONS.find((o) => o.id === state.autoRefreshId)?.ms ?? 60_000;
    const interval = setInterval(handleRefresh, ms);
    return () => clearInterval(interval);
  }, [status, state.autoRefreshId, handleRefresh]);

  const closeDrawer = () => setSelection(undefined);
  const drawerTitle =
    selection?.kind === 'node'
      ? selection.node.label
      : selection?.kind === 'rule'
        ? selection.rule.name
        : selection?.kind === 'capture'
          ? `Capture — ${CAPTURE_LEVEL_LABEL[selection.context.level]}`
          : '';
  const drawerSubtitle =
    selection?.kind === 'node'
      ? NODE_KIND_SUBTITLE[selection.node.kind]
      : selection?.kind === 'rule'
        ? 'Route Rule'
        : selection?.kind === 'capture'
          ? 'Live Capture'
          : undefined;
  const drawerStats =
    selection?.kind === 'node'
      ? correctedMetrics?.byNodeId.get(selection.node.id)
      : selection?.kind === 'rule'
        ? correctedMetrics?.byRuleId.get(selection.rule.id)
        : undefined;
  const drawerWorkerRows = selection?.kind === 'node' ? workerRowsForNode(selection.node, workerStatusByNodeId) : undefined;

  // The real, unscoped Worker Group the current selection actually belongs to — for a node, its
  // own `workerGroupId` (preserved as-is through `mergeConfigOnlyGraphs`, never rewritten to the
  // `ALL_GROUPS_ID` sentinel the page-level `groupId` reads under "All Worker Groups"); for a rule,
  // recovered from its own (possibly rescoped) id, falling back to the page's own single selected
  // group when that id was never actually scoped (a real, single-group selection). Drives both the
  // drawer's own real Cribl API calls (Trend) and which real `RawTopologyBundle` its own Source-
  // type lookups should read from.
  const selectionGroupId =
    selection?.kind === 'node' ? selection.node.workerGroupId : selection?.kind === 'rule' ? (ruleGroupId(selection.rule.id) ?? groupId) : undefined;
  const selectionBundle = selectionGroupId ? bundlesByGroup.get(selectionGroupId) : undefined;
  const selectionProduct = selectionGroupId ? groupProductById.get(selectionGroupId) : undefined;

  const drawerContentRef = useRef<HTMLDivElement>(null);
  const { width: drawerWidth, onHandleMouseDown, setContentWidth } = useResizableDrawerWidth();
  // The Sources table's own Events/Bytes switcher (NodeDetailPanel.tsx) is now local, drawer-owned
  // state, rendered *inside* `drawerContentRef` — no outside-click exemption needed for it. Pinning
  // the drawer (see the header's own pin button below) suspends this outside-click-to-close
  // behavior — this drawer is always `modal={false}` (never Capra's own scrim/modal), so pinning
  // here means gating this hook's own `active` param, not toggling a `modal` prop the way the real
  // Settings/Help drawer does.
  useClickOutside(drawerContentRef, closeDrawer, selection !== undefined && !pinned, '.drawer-resize-handle');

  useEffect(() => {
    setContentWidth(drawerWidthFor(selection));
  }, [selection, setContentWidth]);

  return (
    <div className="view-page">
      <PageHeader title="Signal Path" showMetricToggle={false} showTopSourcesToggle>
        <Tooltip title="Refresh" placement="bottom">
          <CustomTooltipTrigger>
            <IconButton
              icon={ReloadOutlined}
              aria-label="Refresh flow data"
              variant="secondary"
              pending={status === 'loading'}
              disabled={!groupId}
              onClick={handleRefresh}
            />
          </CustomTooltipTrigger>
        </Tooltip>
      </PageHeader>

      <div className="signal-path-body">
        {status === 'idle' && (
          <div className="signal-path-status">
            <EmptyState size="lg" title={`Select a ${groupNoun}`} description={`Choose a ${groupNoun} above to see its wiring.`} />
          </div>
        )}
        {status === 'loading' && !graph && (
          <div className="signal-path-status">
            <Spinner size="lg" title="Loading config…" />
          </div>
        )}
        {status === 'error' && !graph && (
          <div className="signal-path-status">
            <EmptyState size="lg" title={`Could not load this ${groupNoun}`} description={error ?? 'An unexpected error occurred.'} />
          </div>
        )}
        {graph && graph.nodes.length === 0 && (
          <div className="signal-path-status">
            <EmptyState size="lg" title="Nothing configured yet" description={`This ${groupNoun} has no Sources, Routes, or Destinations configured.`} />
          </div>
        )}
        {graph && graph.nodes.length > 0 && (
          <FlowCanvas
            graph={graph}
            statusFilter={state.statusFilter}
            onSelectNode={(node) => setSelection({ kind: 'node', node })}
            onSelectRule={(rule) => setSelection({ kind: 'rule', rule })}
            onCapture={(context) => setSelection({ kind: 'capture', context })}
            metrics={correctedMetrics}
            functionErrorsByNodeId={functionErrorsByNodeId}
            workerStatusByNodeId={workerStatusByNodeId}
            flowAnimationStyle={state.flowAnimationStyle}
            groupNameById={groupNameById}
            groupProductById={groupProductById}
            onChainClick={handleChainClick}
            onFilterChange={debouncedRefreshOnTextFilter}
            topSourcesEnabled={state.topSourcesEnabled}
            topSourcesCount={state.topSourcesCount}
          />
        )}
      </div>

      {selection !== undefined && <DrawerResizeHandle drawerWidth={drawerWidth} onMouseDown={onHandleMouseDown} />}
      <Drawer
        isOpen={selection !== undefined}
        onClose={closeDrawer}
        modal={false}
        width={drawerWidth}
        closable={false}
        title={
          <div className="signal-path-drawer-header-row">
            <div className="signal-path-drawer-header-titles">
              <Drawer.Heading>{drawerTitle}</Drawer.Heading>
              {drawerSubtitle && (
                <Text as="span" variant="body-xs-normal" color="subtle" FORCE__className="signal-path-drawer-header-subtitle">
                  {drawerSubtitle}
                </Text>
              )}
            </div>
            <div className="signal-path-drawer-header-actions">
              <IconButton
                variant="tertiary"
                appearance="neutral"
                size="sm"
                icon={pinned ? PushpinSolid : PushpinOutlined}
                aria-label={pinned ? 'Unpin drawer' : 'Pin drawer open'}
                aria-pressed={pinned}
                FORCE__className={pinned ? 'signal-path-drawer-pin-btn signal-path-drawer-pin-btn--active' : 'signal-path-drawer-pin-btn'}
                onClick={() => setPinned((p) => !p)}
              />
              <IconButton variant="tertiary" appearance="neutral" size="sm" icon={CloseOutlined} aria-label="Close drawer" onClick={closeDrawer} />
            </div>
          </div>
        }
      >
        <div ref={drawerContentRef}>
          {selection?.kind === 'capture' && (
            <CapturePanel
              groupId={selection.context.groupId}
              level={selection.context.level}
              contextLabel={selection.context.label}
              defaultFilter={captureDefaultFilterFor(selection.context, correctedMetrics, bundlesByGroup)}
              product={groupProductById.get(selection.context.groupId)}
            />
          )}
          {(selection?.kind === 'node' || selection?.kind === 'rule') && (
            <NodeDetailPanel
              loading={metricsStatus === 'loading' || metricsStatus === 'idle'}
              stats={drawerStats}
              node={selection.kind === 'node' ? selection.node : undefined}
              ruleId={selection.kind === 'rule' ? realRuleId(selection.rule.id) : undefined}
              bundle={selectionBundle}
              groupId={selectionGroupId}
              earliest={earliest}
              latest={latest}
              functionErrors={selection.kind === 'node' ? functionErrorsByNodeId.get(selection.node.id) : undefined}
              workerRows={drawerWorkerRows}
              product={selectionProduct}
            />
          )}
        </div>
      </Drawer>
    </div>
  );
}
