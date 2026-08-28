import { Fragment, useMemo, useState } from 'react';
import { Text } from '@capra/core';
import { Search, ChevronDown, ChevronRight, CloseOutlined } from '@capra/icons';
import type { FlowGraph, FlowSummary, GraphNode, GroupProductFilter, HealthStatus, StatusFilter, TimeRangeOption, VolumeUnit } from '../../lib/types';
import { HEALTH_APPEARANCE, HEALTH_LABEL, HEALTH_RANK, matchesStatusFilter } from '../../lib/health';
import { formatMetric } from '../../lib/format';
import { useFlowSummaryTrends } from '../../hooks/useFlowSummaryTrends';
import { useDestinationWorkerAlerts, workerAlertSeverity, withWorkerAlert } from '../../hooks/useDestinationWorkerAlerts';
import { useSourceWorkerAlerts } from '../../hooks/useSourceWorkerAlerts';
import { applyBlockedTrendCorrection } from '../../lib/blockedOutput';
import { sumUniqueSourceIn, END_ROUTE_ID } from '../../lib/topology';
import type { WorkerStatusRow } from '../../api/workers';
import { ExpandedPath } from './ExpandedPath';
import { PathGlyph } from './PathGlyph';
import { Sparkline } from './Sparkline';
import { ReductionValue } from '../ReductionValue';
import { computeReduction } from '../../lib/reduction';
import './FlowExplorerTable.css';

interface FlowExplorerTableProps {
  graph: FlowGraph;
  unit: VolumeUnit;
  statusFilter: StatusFilter;
  timeRangeId: TimeRangeOption['id'];
  /** A one-shot pivot from the Overview page's Volume Matrix cell click — see `FlowExplorerPage`'s
   *  own ref-capture-and-clear effect. Seeds the local `search` state exactly once, at mount, via
   *  a lazy `useState` initializer (the same pattern `FlowCanvas`'s own `initialLaneFilter` prop
   *  already established for Signal Path's pivot) — reuses the existing free-text search box
   *  itself rather than a second, separate filter mechanism. */
  initialSearchFilter?: { sourceLabel: string; destinationLabel: string };
  /** Fired on every change to the free-text search box — the page wires this to a debounced
   *  background refresh, so a text filter always reflects fresh data shortly after typing stops
   *  rather than whatever was loaded when the page first opened. */
  onFilterChange?: () => void;
  /** Real product ('stream'/'edge') per real, unscoped Worker Group id — resolved by
   *  `FlowExplorerPage.tsx` from `state.workerGroups`. Each row resolves its own product via its
   *  own `workerGroupId` and passes it to `ExpandedPath` so its own worker-alert badges/captions
   *  say "Worker"/"Node" correctly regardless of which product that row's flow actually belongs to. */
  groupProductById?: Map<string, GroupProductFilter>;
  /** The Top Sources filter's own on/off state (`state.topSourcesEnabled`, `PageHeader.tsx`) — when
   *  on, only rows whose Source is one of the top `topSourcesCount` real Sources by volume (each
   *  Source's own canonical `GraphNode.metrics`, the same de-duplicated figure `sumUniqueSourceIn`
   *  already uses for the "Total in" chicklet — not summed across this Source's own possibly-several
   *  rows, which would double-count it) are shown. */
  topSourcesEnabled?: boolean;
  /** How many Sources the filter above narrows down to when on — `state.topSourcesCount`. */
  topSourcesCount?: number;
}

type SortKey = 'flow' | 'in' | 'out' | 'reduction';
type SortDir = 'asc' | 'desc';

function valueFor(summary: FlowSummary, unit: VolumeUnit, key: 'in' | 'out'): number {
  if (key === 'in') return unit === 'events' ? summary.inEvents : summary.inBytes;
  return unit === 'events' ? summary.outEvents : summary.outBytes;
}

/**
 * `graph.flowSummaries` (built once in `buildFlowGraph`) only ever contains a row for a Source
 * *once it's actually been observed* dispatching somewhere — either a real `route.in_events`
 * breakdown entry for at least one rule, or a structurally-wired QuickConnect connection. A Source
 * that's enabled and wired to Routes but has sent zero events in the selected time range never
 * appears in that breakdown at all, so it never got a row — not filtered out, never created in the
 * first place. That's invisible under every status filter, including "All". Flow Explorer's
 * row-per-*pair* model has no natural "empty cell" to fall back on, so this fills the gap by
 * synthesizing one row per Source that doesn't already have a real entry, entirely client-side and
 * *not* written back into `graph.flowSummaries` itself — every other consumer of the shared graph
 * keeps reading the exact same data, unaffected.
 *
 * A real inconsistency this closes: `routesNode.endRoute` (see `topology.ts`'s own doc comment on
 * that field) is Signal Path's own accurate model of "events that matched no rule fall through to
 * the group's configured default Destination" — a Source with no real `flowSummaries` entry that's
 * *only* reachable via that implicit fallthrough (`routesNode.routeRuleSourceIds[END_ROUTE_ID]`,
 * the same real, cascading-aware candidate list Signal Path's own endRoute row/edges use) genuinely
 * does have a destination, just not one attributed to a specific rule — showing "No destination
 * observed" for it would flatly contradict what Signal Path's own canvas shows for the identical
 * Source. Resolved the same way Signal Path resolves it (real destination id/label/health, an
 * optional Post-Processing Pipeline), just without a real per-source volume split — Cribl reports
 * no live attribution for unmatched events at all, the same reason `topology.ts` itself never
 * fabricates one either. */
function buildNoDataRow(source: GraphNode, routesNode: GraphNode | undefined): FlowSummary {
  const rawInput = source.raw as { pipeline?: string } | undefined;
  const reachesEndRoute = routesNode?.endRoute && routesNode.routeRuleSourceIds?.[END_ROUTE_ID]?.includes(source.id);
  return {
    id: `nodata:${source.id}`,
    sourceId: source.id,
    sourceLabel: source.label,
    destinationId: reachesEndRoute ? routesNode!.endRoute!.destinationId : '',
    destinationLabel: reachesEndRoute ? routesNode!.endRoute!.destinationLabel : 'No destination observed',
    workerGroupId: source.workerGroupId,
    // Always 'nodata', even when `reachesEndRoute` resolves a real destination to *show* — that
    // resolved destination's own health is an aggregate across *every* Source that could
    // plausibly reach it via the fallthrough (endRoute has no live per-source attribution at
    // all), not a real, confirmed signal about *this* specific Source, which by construction
    // (this function only runs for a Source absent from `graph.flowSummaries` entirely) has never
    // been observed sending anything in the selected window. Borrowing the aggregate's own health
    // here was a real bug: a genuinely idle Source could read as "Healthy" purely because some
    // *other* Source's real fallthrough traffic happened to keep the shared catch-all destination
    // busy, which incorrectly passed the "Active" (not-nodata) status filter.
    health: 'nodata',
    disabled: source.disabled,
    inEvents: 0,
    outEvents: 0,
    inBytes: 0,
    outBytes: 0,
    ratio: 0,
    routeIds: reachesEndRoute ? [END_ROUTE_ID] : [],
    pipelineIds: [],
    prePipelineId: rawInput?.pipeline,
    postPipelineId: reachesEndRoute ? routesNode!.endRoute!.postPipelineId : undefined,
    flows: [],
  };
}

/**
 * One row per observed Source -> Destination pair (`graph.flowSummaries` — the same aggregation
 * Flow Matrix's cells use, built once inside `buildFlowGraph` and shared by both views). A dense,
 * sortable, searchable table first, with the real resolved chain folded into each row on demand
 * instead of a separate topology view — matches the reference mockup's own "Flow Explorer"
 * concept: filtering/sorting/searching as first-class, the diagram as a per-row detail rather
 * than the default view.
 */
export function FlowExplorerTable({
  graph,
  unit,
  statusFilter,
  timeRangeId,
  initialSearchFilter,
  onFilterChange,
  groupProductById,
  topSourcesEnabled = false,
  topSourcesCount = 10,
}: FlowExplorerTableProps) {
  const [search, setSearch] = useState(() => (initialSearchFilter ? `${initialSearchFilter.sourceLabel} ${initialSearchFilter.destinationLabel}` : ''));
  const setSearchAndRefresh = (value: string) => {
    setSearch(value);
    onFilterChange?.();
  };
  const [sortKey, setSortKey] = useState<SortKey>('flow');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const nodesById = useMemo(() => new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  // Keyed by Worker Group id, not singular — the "All Worker Groups" view's `graph` can be a
  // `mergeFlowGraphs` merge spanning several real groups, each with its own Routes node (there is
  // exactly one per group, never zero or two within the same group). Every `FlowSummary` already
  // carries its own real `workerGroupId`, so each row resolves its own Routes node via that below,
  // rather than assuming a single graph-wide one.
  const routesNodesByGroupId = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const n of graph.nodes) if (n.kind === 'routes') map.set(n.workerGroupId, n);
    return map;
  }, [graph.nodes]);
  const { trends } = useFlowSummaryTrends(graph.flowSummaries, nodesById, unit, timeRangeId);
  const destinationNodes = useMemo(() => graph.nodes.filter((n) => n.kind === 'destination'), [graph.nodes]);
  const { workerStatusByDestination } = useDestinationWorkerAlerts(destinationNodes);
  // Same real per-worker signal, Source side — see `useSourceWorkerAlerts`'s own doc comment for
  // why Source is the only other component kind this extends to (Routes/Pipelines have no
  // equivalent per-worker connector status endpoint in Cribl's API).
  const sourceNodes = useMemo(() => graph.nodes.filter((n) => n.kind === 'source'), [graph.nodes]);
  const { workerStatusBySource } = useSourceWorkerAlerts(sourceNodes);

  // See `buildNoDataRow` — fills in a synthetic row for every Source that has no real
  // `flowSummaries` entry at all yet, so an idle-but-enabled Source is visible under "All"/"No
  // data" instead of silently having no row anywhere in the table.
  const allSummaries = useMemo(() => {
    const observedSourceIds = new Set(graph.flowSummaries.map((s) => s.sourceId));
    const noDataRows = graph.nodes
      .filter((n) => n.kind === 'source' && !observedSourceIds.has(n.id))
      .map((n) => buildNoDataRow(n, routesNodesByGroupId.get(n.workerGroupId)));
    return noDataRows.length > 0 ? [...graph.flowSummaries, ...noDataRows] : graph.flowSummaries;
  }, [graph.flowSummaries, graph.nodes, routesNodesByGroupId]);

  // The row's true effective status, folding in the real per-worker blocked signal — Destination
  // *and* Source, either of which can independently escalate it — on top of its own volume-based
  // health. `withWorkerAlert` uses `worseOf` internally, so applying it twice (once per side) never
  // lets a Source-side `partial` pull a Destination-side `all` back down, or vice versa — the worse
  // of the two always wins. `withWorkerAlert` never produces `degraded` for any *other* reason on a
  // `FlowSummary` (`flowHealthFromVolume` itself never returns it), so a `degraded` result here
  // always specifically means "some, but not all, workers are blocked on one side." Precomputed
  // once per `allSummaries`/worker-status change rather than inline in the filter/sort/render
  // below, so all three agree on the same value instead of three separate derivations.
  const displayHealthById = useMemo(() => {
    const map = new Map<string, HealthStatus>();
    for (const s of allSummaries) {
      const withDest = withWorkerAlert(s.health, workerAlertSeverity(workerStatusByDestination.get(s.destinationId)));
      const withSrc = withWorkerAlert(withDest, workerAlertSeverity(workerStatusBySource.get(s.sourceId)));
      map.set(s.id, withSrc);
    }
    return map;
  }, [allSummaries, workerStatusByDestination, workerStatusBySource]);

  // "Top N Active" filter — the real ids of the top `topSourcesCount` *active* Source nodes by
  // volume, ranked by each Source's own canonical `GraphNode.metrics.inEvents`/`inBytes` (the
  // real, de-duplicated ingest figure `sumUniqueSourceIn` already relies on below — never summed
  // across this Source's own possibly-several `flowSummaries` rows, which would double-count the
  // same physical ingest; see the "IN-volume double-counting" fix this app already made once for
  // exactly this reason). Ranked only among Sources with real, non-zero volume — a Source with no
  // observed traffic never fills a slot just because fewer than `topSourcesCount` real Sources
  // exist, so a genuinely quiet graph can show fewer than N, never padded out with idle ones.
  // `undefined` when the filter is off, meaning "no restriction." Mutually exclusive with the
  // status filter (see `PageHeader.tsx`/`AppState.tsx`'s own reducer) — `matchesStatusFilter`
  // below is skipped entirely while this is on, so the only restriction is this real set itself.
  const topSourceIds = useMemo(() => {
    if (!topSourcesEnabled) return undefined;
    const sourceNodes = graph.nodes.filter((n) => n.kind === 'source');
    const ranked = sourceNodes
      .map((n) => ({ id: n.id, volume: unit === 'events' ? (n.metrics.inEvents ?? 0) : (n.metrics.inBytes ?? 0) }))
      .filter((r) => r.volume > 0)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, topSourcesCount);
    return new Set(ranked.map((r) => r.id));
  }, [graph.nodes, unit, topSourcesEnabled, topSourcesCount]);

  // Token-based AND matching, not one literal whole-string `.includes()` — a real, reported bug:
  // the Volume Matrix drilldown seeds this box with `"{sourceLabel} {destinationLabel}"` (e.g.
  // "apache_error shared_dest"), which only ever matched as one contiguous substring. Under "All
  // Worker Groups"/"All Fleets," a label can pick up a real `(Group Name)` qualifier suffix (see
  // `mergeConfigOnlyGraphs`/`mergeFlowGraphs`'s own "qualify on merge" convention) — e.g.
  // "shared_dest (default)" — which breaks that contiguous substring even though both words are
  // still genuinely present, just no longer adjacent. Splitting the query into independent tokens
  // and requiring each one to match *somewhere* in the row's own combined text (order- and
  // adjacency-independent) fixes this for the seeded-filter case and matches the same convention
  // already established for Signal Path's own per-lane search.
  const queryTokens = useMemo(() => search.trim().toLowerCase().split(/\s+/).filter(Boolean), [search]);
  const rows = useMemo(() => {
    const filtered = allSummaries.filter((s) => {
      if (topSourceIds && !topSourceIds.has(s.sourceId)) return false;
      const displayHealth = displayHealthById.get(s.id) ?? s.health;
      // `matchesStatusFilter` itself folds a `degraded` result into "Unhealthy" now (see its own
      // doc comment) — this used to be a local special case here before that became the shared,
      // app-wide rule. Skipped entirely while "Top N Active" is on (`topSourceIds` defined) — the
      // two are mutually exclusive, not combinable, so the ordinary status filter never also
      // narrows the set this filter already picked.
      if (!topSourceIds && !matchesStatusFilter(displayHealth, statusFilter, s.disabled)) return false;
      if (queryTokens.length === 0) return true;
      const haystack = `${s.sourceLabel} ${s.destinationLabel}`.toLowerCase();
      return queryTokens.every((t) => haystack.includes(t));
    });

    const sign = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'in':
          return sign * (valueFor(a, unit, 'in') - valueFor(b, unit, 'in'));
        case 'out':
          return sign * (valueFor(a, unit, 'out') - valueFor(b, unit, 'out'));
        case 'reduction': {
          const signedA = computeReduction(valueFor(a, unit, 'in'), valueFor(a, unit, 'out')).pct;
          const signedB = computeReduction(valueFor(b, unit, 'in'), valueFor(b, unit, 'out')).pct;
          return sign * (signedA - signedB);
        }
        case 'flow':
        default: {
          // The default "flow" sort is worst-health-first regardless of direction toggle — a
          // literal alphabetical flip on flow name isn't a distinction worth a second sort mode,
          // but worst-vs-best-first is, so the toggle controls *that* instead when this key is
          // active. Uses the same display health as the dot/filter, so a partially-blocked flow
          // sorts as the more severe issue it now visually reads as.
          const healthA = displayHealthById.get(a.id) ?? a.health;
          const healthB = displayHealthById.get(b.id) ?? b.health;
          const rankDiff = sign * (HEALTH_RANK[healthA] - HEALTH_RANK[healthB]);
          if (rankDiff !== 0) return rankDiff;
          return a.sourceLabel.localeCompare(b.sourceLabel) || a.destinationLabel.localeCompare(b.destinationLabel);
        }
      }
    });
  }, [allSummaries, displayHealthById, statusFilter, queryTokens, sortKey, sortDir, unit, topSourceIds]);

  // Aggregated across exactly what's currently visible in `rows` — so it tracks the search/status/
  // Top-10 filters live, rather than always summarizing the whole unfiltered graph. `flowCount`
  // sums each row's own `flows.length` (the same number the Flows column shows per row) rather
  // than `rows.length` (the number of Source->Destination *pairs* shown) — those are genuinely
  // different numbers whenever any row has more than one contributing rule, and showing `rows
  // .length` under a "Flows" label directly contradicted what a user would get by manually adding
  // up the table's own Flows column beneath it.
  const totals = useMemo(() => {
    // IN is summed once per distinct Source (`sumUniqueSourceIn`), not once per visible row — a
    // Source fanning out to more than one Destination shows as several rows, and naively summing
    // `inEvents`/`inBytes` across them double-counts the same physical ingest. OUT has no
    // equivalent concern: each row's own `outEvents`/`outBytes` is a distinct, real delivery.
    const inSum = sumUniqueSourceIn(rows, nodesById, unit);
    let flowCount = 0;
    let outSum = 0;
    for (const r of rows) {
      flowCount += r.flows.length;
      outSum += valueFor(r, unit, 'out');
    }
    return { flowCount, inSum, outSum };
  }, [rows, nodesById, unit]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allExpanded = rows.length > 0 && rows.every((r) => expanded.has(r.id));
  const toggleExpandAll = () => setExpanded(allExpanded ? new Set() : new Set(rows.map((r) => r.id)));

  const sortIndicator = (key: SortKey) => (key === sortKey ? (sortDir === 'asc' ? '▲' : '▼') : '');

  return (
    <div className="flow-explorer">
      <div className="flow-explorer-toolbar">
        <div className="flow-explorer-search">
          <Search />
          <input type="text" placeholder="Filter by Source or Destination…" value={search} onChange={(e) => setSearchAndRefresh(e.target.value)} />
          {/* Only shown once there's actually something to clear — matching Signal Path's own
              lane search boxes. */}
          {search !== '' && (
            <button type="button" className="flow-explorer-search-clear" aria-label="Clear search filter" onClick={() => setSearchAndRefresh('')}>
              <CloseOutlined />
            </button>
          )}
        </div>
        <button type="button" className="flow-explorer-expand-all-btn" onClick={toggleExpandAll} disabled={rows.length === 0}>
          {allExpanded ? 'Collapse all' : 'Expand all'}
        </button>

        {/* Aggregated across exactly what `rows` currently shows — tracks the search/status
            filters live. Pushed to the far right of the same toolbar row as Expand All
            (`margin-left: auto` on this group) rather than a separate bar underneath. */}
        <div className="flow-explorer-chicklets">
          <div className="flow-explorer-chicklet">
            <Text as="span" variant="body-xs-semibold" color="subtle" FORCE__className="flow-explorer-chicklet-label">
              Flows
            </Text>
            <Text as="span" variant="metric-sm" FORCE__className="flow-explorer-mono">
              {totals.flowCount}
            </Text>
          </div>
          <div className="flow-explorer-chicklet">
            <Text as="span" variant="body-xs-semibold" color="subtle" FORCE__className="flow-explorer-chicklet-label">
              Total in
            </Text>
            <Text as="span" variant="metric-sm" FORCE__className="flow-explorer-mono">
              {formatMetric(totals.inSum, unit)}
            </Text>
          </div>
          <div className="flow-explorer-chicklet">
            <Text as="span" variant="body-xs-semibold" color="subtle" FORCE__className="flow-explorer-chicklet-label">
              Total out
            </Text>
            <Text as="span" variant="metric-sm" FORCE__className="flow-explorer-mono">
              {formatMetric(totals.outSum, unit)}
            </Text>
          </div>
          <div className="flow-explorer-chicklet">
            <Text as="span" variant="body-xs-semibold" color="subtle" FORCE__className="flow-explorer-chicklet-label">
              Reduction
            </Text>
            <ReductionValue inValue={totals.inSum} outValue={totals.outSum} size="lg" />
          </div>
        </div>
      </div>

      <div className="flow-explorer-scroll">
        <table className="flow-explorer-table">
          <thead>
            <tr>
              <th className="flow-explorer-col-status" aria-label="Status" />
              <th className="flow-explorer-col-flow">
                <button type="button" className="flow-explorer-sort-btn" onClick={() => toggleSort('flow')}>
                  Flow <span className="flow-explorer-sort-indicator">{sortIndicator('flow')}</span>
                </button>
              </th>
              <th className="flow-explorer-col-count" title="Number of Route rules / connections contributing to this Source → Destination pair">
                Flows
              </th>
              <th className="flow-explorer-col-path">Path</th>
              <th className="flow-explorer-col-trend">Trend</th>
              <th className="flow-explorer-col-num">
                <button type="button" className="flow-explorer-sort-btn" onClick={() => toggleSort('in')}>
                  In <span className="flow-explorer-sort-indicator">{sortIndicator('in')}</span>
                </button>
              </th>
              <th className="flow-explorer-col-num">
                <button type="button" className="flow-explorer-sort-btn" onClick={() => toggleSort('out')}>
                  Out <span className="flow-explorer-sort-indicator">{sortIndicator('out')}</span>
                </button>
              </th>
              <th className="flow-explorer-col-num">
                <button type="button" className="flow-explorer-sort-btn" onClick={() => toggleSort('reduction')}>
                  Reduction <span className="flow-explorer-sort-indicator">{sortIndicator('reduction')}</span>
                </button>
              </th>
              <th className="flow-explorer-col-expand" aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {rows.map((summary) => {
              const isExpanded = expanded.has(summary.id);
              const pipelineNames = summary.pipelineIds.join(', ');
              // `destinationId === ''` is `buildNoDataRow`'s own sentinel for "no observed
              // destination" — falling through to the pipelineNames-vs-QuickConnect logic below
              // for one of these would wrongly label a Routes-based idle Source "direct
              // (QuickConnect)" just because it has no pipeline ids either (it has no rule-derived
              // anything, since none was ever observed).
              const isNoDataRow = summary.destinationId === '';
              // Same reasoning, a second real case: a Source only reachable via the implicit
              // endRoute fallthrough (see `buildNoDataRow`'s own doc comment) has empty
              // `pipelineIds` too (no main Pipeline — endRoute dispatches straight to the resolved
              // default Destination, or through its Post-Processing Pipeline only) — without this,
              // it would fall through to the same "direct (QuickConnect)" mislabel even though it's
              // a real Routes-based flow, not a QuickConnect one at all.
              const isEndRouteRow = summary.routeIds[0] === END_ROUTE_ID;
              const destWorkerRows: WorkerStatusRow[] | undefined = workerStatusByDestination.get(summary.destinationId);
              const srcWorkerRows: WorkerStatusRow[] | undefined = workerStatusBySource.get(summary.sourceId);
              // The queried trend is inbound-to-the-rule/received volume (Cribl has no per-source
              // outbound breakdown — see this hook's own doc comment), which still reads as
              // flowing right up to "now" even once the real Destination is genuinely stuck.
              // Corrected with the same real per-worker rows the Path glyph/badge already use.
              const rawTrend = trends.get(summary.id);
              const correctedTrend = rawTrend ? applyBlockedTrendCorrection(rawTrend, destWorkerRows) : rawTrend;
              const displayHealth = displayHealthById.get(summary.id) ?? summary.health;
              const routesNode = routesNodesByGroupId.get(summary.workerGroupId);
              return (
                <Fragment key={summary.id}>
                  <tr className="flow-explorer-row" onClick={() => toggleExpanded(summary.id)} aria-expanded={isExpanded}>
                    <td className="flow-explorer-col-status">
                      <span className="flow-explorer-status-pill" title={HEALTH_LABEL[displayHealth]}>
                        <span
                          className={`flow-explorer-status-dot flow-explorer-status-dot--${HEALTH_APPEARANCE[displayHealth]}`}
                          role="img"
                          aria-label={HEALTH_LABEL[displayHealth]}
                        />
                      </span>
                    </td>
                    <td className="flow-explorer-col-flow">
                      {/* A no-data row has no real destination to name, so the name slot holds only
                          the real entity — every other row's "X → Y" pattern otherwise reads as two
                          names, and here Y was a synthesized sentence ("No destination observed")
                          standing in that slot, restating the subtitle right below it. See the
                          interface review. */}
                      <Text as="span" variant="body-sm-semibold" FORCE__className="flow-explorer-flow-name">
                        {isNoDataRow ? summary.sourceLabel : `${summary.sourceLabel} → ${summary.destinationLabel}`}
                      </Text>
                      <Text as="span" variant="body-xs-normal" color="subtle" FORCE__className="flow-explorer-flow-sub">
                        {isNoDataRow
                          ? 'No destination reached — no traffic in this time range'
                          : pipelineNames
                            ? `via ${pipelineNames}`
                            : isEndRouteRow
                              ? 'via endRoute (unrouted events)'
                              : 'direct (QuickConnect)'}
                      </Text>
                    </td>
                    <td className="flow-explorer-col-count">
                      <Text as="span" variant="body-sm-normal" FORCE__className="flow-explorer-mono">
                        {summary.flows.length}
                      </Text>
                    </td>
                    <td className="flow-explorer-col-path">
                      <PathGlyph summary={summary} nodesById={nodesById} routesNode={routesNode} destWorkerRows={destWorkerRows} srcWorkerRows={srcWorkerRows} />
                    </td>
                    <td className="flow-explorer-col-trend">
                      <Sparkline points={correctedTrend} health={summary.health} />
                    </td>
                    <td className="flow-explorer-col-num">
                      <Text as="span" variant="body-sm-normal" FORCE__className="flow-explorer-mono">
                        {formatMetric(valueFor(summary, unit, 'in'), unit)}
                      </Text>
                    </td>
                    <td className="flow-explorer-col-num">
                      <Text as="span" variant="body-sm-normal" FORCE__className="flow-explorer-mono">
                        {formatMetric(valueFor(summary, unit, 'out'), unit)}
                      </Text>
                    </td>
                    <td className="flow-explorer-col-num">
                      <ReductionValue inValue={valueFor(summary, unit, 'in')} outValue={valueFor(summary, unit, 'out')} />
                    </td>
                    <td className="flow-explorer-col-expand">{isExpanded ? <ChevronDown /> : <ChevronRight />}</td>
                  </tr>
                  {/* Always mounted (not conditionally rendered on `isExpanded`) so the
                      grid-template-rows 0fr/1fr transition below has something to animate between —
                      a row that only enters the DOM at the moment it's already "open" has no
                      collapsed state to transition from. Collapsed content is clipped to zero height
                      by the inner wrapper's own `overflow: hidden`, and marked `inert` so its real
                      interactive content (e.g. the worker-alert badge inside `ExpandedPath`) can't be
                      tab-reached or read by assistive tech while visually hidden. */}
                  <tr className={`flow-explorer-expand-row${isExpanded ? ' is-open' : ''}`}>
                    {/* A real empty cell matching the Status column, not just CSS padding — since
                        every row shares one <table>'s column widths, this reliably reproduces the
                        Status column's actual rendered width (auto-fit, so not a fixed number)
                        without needing to measure it in JS. The content `<td>` then starts at
                        exactly the same x-position as the Flow column/row label above it. */}
                    <td className="flow-explorer-col-status" aria-hidden="true" />
                    <td className="flow-explorer-expand-content" colSpan={8}>
                      <div className={`flow-explorer-expand-anim${isExpanded ? ' is-open' : ''}`}>
                        <div className="flow-explorer-expand-anim-inner" inert={!isExpanded} aria-hidden={!isExpanded}>
                          <div className="flow-explorer-expand-anim-content">
                            <ExpandedPath
                              summary={summary}
                              nodesById={nodesById}
                              routesNode={routesNode}
                              unit={unit}
                              destWorkerRows={destWorkerRows}
                              srcWorkerRows={srcWorkerRows}
                              product={groupProductById?.get(summary.workerGroupId)}
                            />
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                </Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr className="flow-explorer-empty-row">
                <td colSpan={9}>
                  <Text as="span" variant="body-sm-normal" color="subtle">
                    {search.trim() ? 'No flows match your search.' : 'No flows match the current status filter.'}
                  </Text>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
