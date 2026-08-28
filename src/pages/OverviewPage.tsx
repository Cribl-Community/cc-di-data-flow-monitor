import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyState, IconButton, Spinner, Tooltip, CustomTooltipTrigger } from '@capra/core';
import { ReloadOutlined } from '@capra/icons';
import { PageHeader } from '../components/PageHeader';
import { KpiRow } from '../components/Overview/KpiRow';
import { FleetRoster } from '../components/Overview/FleetRoster';
import { WorkerNodeDrawer } from '../components/Overview/WorkerNodeDrawer';
import { WorkerBalanceChart } from '../components/Overview/WorkerBalanceChart';
import { TopSourcesByVolumePanel } from '../components/Overview/TopSourcesByVolumePanel';
import { DailyIngestPanel } from '../components/Overview/DailyIngestPanel';
import { AlertFeedPanel } from '../components/Overview/AlertFeedPanel';
import { useAppState } from '../state/AppState';
import { useFlowGraph, useMultiGroupFlowGraph } from '../hooks/useFlowGraph';
import { useWorkerFleet } from '../hooks/useWorkerFleet';
import { useLicenseConsumption } from '../hooks/useLicenseConsumption';
import { useDebouncedCallback } from '../hooks/useAutoRefreshOnFilterChange';
import { isGroupOfProduct, isSupportedGroup } from '../api/groups';
import { ALL_GROUPS_ID, AUTO_REFRESH_OPTIONS, VIEW_PATH, type GroupProductFilter } from '../lib/types';
import { deriveWorkerHealth, type WorkerFleetRow } from '../lib/workerHealth';
import { connectedAndFedDestinationKeys } from '../lib/topology';
import { GROUP_NOUN, WORKER_NOUN_PLURAL } from '../lib/productTerms';
import './OverviewPage.css';

/**
 * Fleet-level infrastructure monitoring — a sibling to Signal Path/Flow Explorer's flow-level
 * monitoring, not a replacement for either. Reuses the same shared top-bar state (Worker Group,
 * time range, metric unit — all from `AppState`) every other page already reads/writes, so
 * switching to Overview and back preserves whatever scope was already selected, same as switching
 * between any other two views today. The one exception is the shared status filter: no panel on
 * this page reads `state.statusFilter` at all (`PageHeader`'s own `showStatusFilter={false}` below
 * omits its control entirely) — Node Inventory already has its own, more specific local search,
 * and a second, disconnected top-bar filter next to it would be redundant at best and confusing at
 * worst (narrowing workers app-wide while every other panel on this same page stayed unfiltered).
 */
export function OverviewPage() {
  const { state, dispatch, refreshWorkerGroups } = useAppState();
  const navigate = useNavigate();
  const isAllGroups = state.selectedGroupId === ALL_GROUPS_ID;
  const groupNoun = GROUP_NOUN[state.groupProductFilter];
  // Scoped to just the top-left Stream/Edge toggle's own current product, matching `PageHeader`'s
  // own Worker Group dropdown — "All Worker Groups" here means "every group of the current
  // product," not every group this org has.
  const supportedGroups = useMemo(
    () => state.workerGroups.filter(isSupportedGroup).filter((g) => isGroupOfProduct(g, state.groupProductFilter)),
    [state.workerGroups, state.groupProductFilter],
  );
  const scopedGroupIds = useMemo(
    () => (isAllGroups ? supportedGroups.map((g) => g.id) : state.selectedGroupId ? [state.selectedGroupId] : []),
    [isAllGroups, supportedGroups, state.selectedGroupId],
  );
  // Real group name *and* product (Stream/Edge) per real group id — the one lookup every panel
  // below needs to attribute its own rows/summaries by product, built once here rather than each
  // panel re-deriving it from `state.workerGroups` its own way.
  const groupInfoById = useMemo(
    () => new Map(supportedGroups.map((g) => [g.id, { name: g.name, type: g.type }] as const)),
    [supportedGroups],
  );
  // Each group's own real, currently-deployed config version — the per-node detail drawer's own
  // config-drift check compares a specific node's `conf.confVersion` against its group's entry
  // here to flag a node that hasn't picked up the latest push yet.
  const groupConfigVersionById = useMemo(() => new Map(supportedGroups.map((g) => [g.id, g.configVersion] as const)), [supportedGroups]);

  // Active Flows / Volume In / Volume Out / Reduction reuse the exact same topology-graph fetch
  // (and its own "All Worker Groups" merge shape) every other page already pays for — no second,
  // lighter-weight aggregation exists that also gives a real per-flow count, and duplicating that
  // cost with a bespoke query wasn't worth the inconsistency risk. Computed *before* `fleet` below
  // since the roster's own real "Blocked" count now depends on this same graph too (see
  // `connectedAndFedOutputKeys`) — `useWorkerFleet` itself never re-fetches from Cribl when this
  // changes, only re-derives already-fetched data, so there's no ordering cost to this beyond
  // keeping the two hooks' own real data dependency honest.
  const singleFlow = useFlowGraph(isAllGroups ? undefined : state.selectedGroupId, state.metric, state.timeRangeId);
  const multiFlow = useMultiGroupFlowGraph(isAllGroups ? supportedGroups : [], state.metric, state.timeRangeId);
  const { graph: flowGraph, status: flowStatus, refresh: refreshFlows } = isAllGroups ? multiFlow : singleFlow;

  // Real Destinations that are both actually reachable (a live Route rule or QuickConnect wires
  // into them) and actually fed (their own upstream node shows real observed volume) — see
  // `lib/topology.ts`'s own doc comment for the live-confirmed finding this exists to correct:
  // Cribl's `blocked.outputs` metric can be genuinely nonzero for a Destination with no live
  // wiring and zero real data, purely from periodic failed reconnect attempts (connector-type-
  // specific, confirmed live for `tcpjson`). `undefined` while the flow graph hasn't loaded yet.
  const connectedAndFedOutputKeys = useMemo(() => connectedAndFedDestinationKeys(flowGraph), [flowGraph]);

  const fleet = useWorkerFleet(scopedGroupIds, state.metric, state.timeRangeId, connectedAndFedOutputKeys);

  // The Node Inventory row currently open in the detail drawer — a plain id, not the row object
  // itself, so the drawer always reflects the *latest* fetched data for that worker across a
  // refresh (matching this app's own "selection drives open state, re-derived from current data"
  // pattern elsewhere, e.g. Signal Path's own drawer selection).
  const [openWorkerId, setOpenWorkerId] = useState<string | undefined>(undefined);
  const openWorkerRow = useMemo(() => fleet.rows.find((r) => r.id === openWorkerId), [fleet.rows, openWorkerId]);

  // Feeds the KPI row's own License card and the Daily Ingest panel below — always a fixed 30-day
  // window (per explicit direction), independent of the top bar's Worker Group/time-range scoping,
  // since the license API family is org-wide with no such scoping to begin with.
  const license = useLicenseConsumption(30);

  // Memoized so the auto-refresh interval below (keyed on this same reference) doesn't tear down
  // and recreate itself on every render — depends on `fleet.refresh` specifically (itself stable),
  // not the whole `fleet`/`license` object, which is a new reference every render regardless.
  const refresh = useCallback(() => {
    fleet.refresh();
    refreshFlows();
    license.refresh();
    void refreshWorkerGroups();
  }, [fleet.refresh, refreshFlows, license.refresh, refreshWorkerGroups]);

  // Same auto-refresh mechanism Signal Path already uses — one shared `state.autoRefreshId`
  // preference driving every page, not a page-specific reimplementation.
  useEffect(() => {
    if (fleet.status !== 'ready' || state.autoRefreshId === 'off') return;
    const ms = AUTO_REFRESH_OPTIONS.find((o) => o.id === state.autoRefreshId)?.ms ?? 60_000;
    const interval = setInterval(refresh, ms);
    return () => clearInterval(interval);
  }, [fleet.status, state.autoRefreshId, refresh]);

  // Debounced so Node Inventory's own free-text search box triggers one background refresh
  // shortly after typing stops, not one per keystroke — see `FleetRoster`'s own `onFilterChange`
  // prop. Worker Group/Product/Time Range/Metric switches already trigger a real refetch on their
  // own (real inputs to `useWorkerFleet`/`useFlowGraph` above); this page shows no shared status
  // filter (`showStatusFilter={false}`), so there's no separate dimension to wire for that.
  const debouncedRefreshOnTextFilter = useDebouncedCallback(refresh, 600);

  // Every worker's escalated status, computed once and shared by the KPI row's counts, the roster
  // table's own filter/pills, and the balance chart's outlier detection — one definition of "is
  // this worker OK" for the whole page, not three.
  const healthByWorkerId = useMemo(() => {
    const map = new Map<string, ReturnType<typeof deriveWorkerHealth>>();
    for (const w of fleet.rows) {
      const product = (groupInfoById.get(w.group)?.type as GroupProductFilter | undefined) ?? 'stream';
      map.set(w.id, deriveWorkerHealth(w, product));
    }
    return map;
  }, [fleet.rows, groupInfoById]);

  // --- Pivot points: Overview -> Flow Explorer ---
  // Both just set the same shared `AppState` fields every other page already reads (status
  // filter) and navigate — no page-specific query params, no second source of truth. This is the
  // same `dispatch` + `navigate` shape the Sidebar's own nav already uses.

  /** From the "Active Flows"/"Reduction" KPIs: both are counted/summed from `graph.flowSummaries`,
   *  which — unlike Flow Explorer's own client-side "no data" synthetic rows — never includes a
   *  flow with zero observed volume. Landing with the status filter set to "Active" (not "All")
   *  is what actually keeps the list a user sees matching what the KPI just counted; "All" would
   *  include Flow Explorer's own synthetic no-data rows that were never part of either KPI's
   *  number in the first place, which read as a mismatch. */
  const viewFlowsInExplorer = () => {
    dispatch({ type: 'statusFilter/set', statusFilter: 'active' });
    navigate(VIEW_PATH.flowExplorer);
  };

  /** From a Volume Matrix cell: pivot to Flow Explorer pinned to exactly that Source ->
   *  Destination pair (`flowExplorer/setPendingFilter`, a one-shot payload consumed once by
   *  `FlowExplorerPage`/`FlowExplorerTable` — see `AppState.tsx`'s own doc comment). Status filter
   *  resets to "All" — unlike the KPI pivots above, a Matrix cell's own volume is already scoped
   *  to what's actually being shown (a real observed pair), not conditioned on "Active" the same
   *  way a KPI count is, and a narrower filter could otherwise hide the very row being drilled
   *  into if that flow doesn't currently match it (e.g. its own display health degraded from a
   *  worker-alert escalation the Overview panel doesn't itself show). */
  const viewFlowInExplorer = (sourceLabel: string, destinationLabel: string) => {
    dispatch({ type: 'flowExplorer/setPendingFilter', sourceLabel, destinationLabel });
    dispatch({ type: 'statusFilter/set', statusFilter: 'all' });
    navigate(VIEW_PATH.flowExplorer);
  };

  return (
    <div className="view-page">
      <PageHeader title="Overview" showStatusFilter={false}>
        <Tooltip title="Refresh" placement="bottom">
          <CustomTooltipTrigger>
            <IconButton
              icon={ReloadOutlined}
              aria-label="Refresh fleet data"
              variant="secondary"
              pending={fleet.status === 'loading'}
              disabled={fleet.status !== 'ready'}
              onClick={refresh}
            />
          </CustomTooltipTrigger>
        </Tooltip>
      </PageHeader>

      <div className="view-body overview-body">
        {fleet.status === 'loading' && fleet.rows.length === 0 && (
          <div className="overview-status">
            <Spinner size="lg" title="Loading fleet data…" />
          </div>
        )}

        {fleet.status === 'error' && fleet.rows.length === 0 && (
          <div className="overview-status">
            <EmptyState
              size="lg"
              title={fleet.isPermissionError ? 'Insufficient permissions' : 'Could not load fleet data'}
              description={fleet.error ?? 'An unexpected error occurred.'}
            />
          </div>
        )}

        {fleet.status === 'idle' && (
          <div className="overview-status">
            <EmptyState size="lg" title={`Select a ${groupNoun}`} description={`Choose a ${groupNoun} above to see its fleet.`} />
          </div>
        )}

        {fleet.status === 'ready' && fleet.rows.length === 0 && (
          <div className="overview-status">
            <EmptyState
              size="lg"
              title={`No ${WORKER_NOUN_PLURAL[state.groupProductFilter].toLowerCase()} found`}
              description={`The selected ${groupNoun.toLowerCase()} scope has no reporting ${WORKER_NOUN_PLURAL[state.groupProductFilter].toLowerCase()}.`}
            />
          </div>
        )}

        {fleet.rows.length > 0 && (
          <>
            <KpiRow
              rows={fleet.rows}
              healthByWorkerId={healthByWorkerId}
              groupCount={scopedGroupIds.length}
              groupIds={scopedGroupIds}
              groupInfoById={groupInfoById}
              groupProductFilter={state.groupProductFilter}
              unit={state.metric}
              flowGraph={flowGraph}
              flowStatus={flowStatus}
              timeRangeId={state.timeRangeId}
              onViewFlows={viewFlowsInExplorer}
              license={license.license}
              licenseDaysOverQuota={license.daysOverQuota}
              licenseLoading={license.status === 'loading' && !license.license}
            />

            {/* One shared grid (not two independent ones) so the bottom row's columns land on the
                exact same pixel widths as the top row's — see `.overview-grid`'s own doc comment
                in OverviewPage.css for why two separate `display: grid` rows couldn't guarantee
                that (different gap counts per row silently produce different column widths even
                at identical `fr` ratios). */}
            <div className="overview-grid">
              <AlertFeedPanel
                rows={fleet.rows}
                timeRangeId={state.timeRangeId}
                groupInfoById={groupInfoById}
                groupProductFilter={state.groupProductFilter}
              />
              <TopSourcesByVolumePanel flowGraph={flowGraph} unit={state.metric} onCellDrilldown={viewFlowInExplorer} />
              <DailyIngestPanel
                status={license.status}
                license={license.license}
                days={license.days}
                topSourceKeys={license.topSourceKeys}
                hasOtherSources={license.hasOtherSources}
                sourceLabel={license.sourceLabel}
              />

              <FleetRoster
                rows={fleet.rows}
                totalCount={fleet.rows.length}
                healthByWorkerId={healthByWorkerId}
                unit={state.metric}
                onSelectRow={(row: WorkerFleetRow) => setOpenWorkerId(row.id)}
                groupProductFilter={state.groupProductFilter}
                onFilterChange={debouncedRefreshOnTextFilter}
                cpuWarnAt={state.groupProductFilter === 'edge' ? state.cpuPressureWarnPctEdge : state.cpuPressureWarnPctStream}
                memWarnAt={state.groupProductFilter === 'edge' ? state.memPressureWarnPctEdge : state.memPressureWarnPctStream}
                diskWarnAt={state.groupProductFilter === 'edge' ? state.diskPressureWarnPctEdge : state.diskPressureWarnPctStream}
              />
              <WorkerBalanceChart rows={fleet.rows} unit={state.metric} groupProductFilter={state.groupProductFilter} />
            </div>
          </>
        )}
      </div>

      <WorkerNodeDrawer
        row={openWorkerRow}
        groupConfigVersion={openWorkerRow ? groupConfigVersionById.get(openWorkerRow.group) : undefined}
        unit={state.metric}
        onClose={() => setOpenWorkerId(undefined)}
        // `supportedGroups` (feeding `groupInfoById`) is already filtered to just Stream/Edge
        // groups via `isGroupOfProduct`, so this real `ProductType` is always 'stream'/'edge' here
        // — the same cast `FlowExplorerPage.tsx`'s own `groupProductById` already establishes.
        product={openWorkerRow ? (groupInfoById.get(openWorkerRow.group)?.type as GroupProductFilter | undefined) : undefined}
        connectedAndFedOutputKeys={connectedAndFedOutputKeys}
      />
    </div>
  );
}
