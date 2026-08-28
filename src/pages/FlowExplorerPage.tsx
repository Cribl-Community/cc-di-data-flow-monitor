import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, IconButton, Spinner, Tooltip, CustomTooltipTrigger } from '@capra/core';
import { ReloadOutlined } from '@capra/icons';
import { PageHeader } from '../components/PageHeader';
import { FlowExplorerTable } from '../components/FlowExplorer/FlowExplorerTable';
import { useAppState } from '../state/AppState';
import { useFlowGraph, useMultiGroupFlowGraph } from '../hooks/useFlowGraph';
import { useSkipFirstEffect, useDebouncedCallback } from '../hooks/useAutoRefreshOnFilterChange';
import { isGroupOfProduct, isSupportedGroup } from '../api/groups';
import { ALL_GROUPS_ID, AUTO_REFRESH_OPTIONS, type GroupProductFilter } from '../lib/types';
import { GROUP_NOUN } from '../lib/productTerms';
import './FlowExplorerPage.css';

export function FlowExplorerPage() {
  const { state, dispatch, refreshWorkerGroups } = useAppState();
  const isAllGroups = state.selectedGroupId === ALL_GROUPS_ID;
  const groupNoun = GROUP_NOUN[state.groupProductFilter];
  // Scoped to just the top-left Stream/Edge toggle's own current product, matching `PageHeader`'s
  // own Worker Group dropdown.
  const supportedGroups = useMemo(
    () => state.workerGroups.filter(isSupportedGroup).filter((g) => isGroupOfProduct(g, state.groupProductFilter)),
    [state.workerGroups, state.groupProductFilter],
  );
  // Real product per real, unscoped group id, across *both* products (not just the toggle's own
  // current one) — a real `FlowSummary` row under "All Worker Groups" can belong to either, and
  // `ExpandedPath`'s own worker-alert badges/captions need that specific row's own real product,
  // not whichever one the top-left toggle happens to show right now.
  const groupProductById = useMemo(
    () => new Map(state.workerGroups.filter(isSupportedGroup).map((g) => [g.id, g.type as GroupProductFilter] as const)),
    [state.workerGroups],
  );

  // A pivot from the Overview page's Volume Matrix cell click, consumed exactly once — captured
  // in a ref on first render (not read fresh from `state` on every render) so clearing it below
  // doesn't itself wipe out the value `FlowExplorerTable` still needs for its own one-time
  // initial state, matching the identical `signalPathPendingFilter` pattern (`SignalPathPage.tsx`).
  const initialSearchFilterRef = useRef(state.flowExplorerPendingFilter);
  useEffect(() => {
    if (state.flowExplorerPendingFilter) dispatch({ type: 'flowExplorer/clearPendingFilter' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per real mount (this page unmounts/remounts on every navigation), deliberately not re-run if the field changes later.
  }, []);

  const single = useFlowGraph(isAllGroups ? undefined : state.selectedGroupId, state.metric, state.timeRangeId);
  const multi = useMultiGroupFlowGraph(isAllGroups ? supportedGroups : [], state.metric, state.timeRangeId);
  const { graph: rawGraph, status, error, isPermissionError, refresh } = isAllGroups ? multi : single;

  // Real bug, confirmed: switching between a single Worker Group and "All Worker Groups"/"All
  // Fleets" swaps which of the two hooks above is actually in use — `single`/`multi` are genuinely
  // separate hook instances, each with its own `graph` state that starts at `undefined` until its
  // own fetch resolves. During that brief window right after such a switch, `rawGraph` itself goes
  // `undefined` even though the *previous* scope's data is still perfectly good to keep showing —
  // and since `<FlowExplorerTable>` below is only rendered `{graph && ...}`, that transient
  // `undefined` unmounted it. Losing the mount wipes its own local search/sort/expanded state, and
  // — the specific report this was chasing — re-seeds its search box from the Volume Matrix pivot
  // ref below (`initialSearchFilterRef`, deliberately never cleared after its first read, since a
  // *genuine* first mount is supposed to be seeded from it) even if the reader had already cleared
  // it by hand. Fixed the same way this app already avoids an identical flicker on a plain refresh
  // (see `FlowExplorerTable`'s own "gate on graph presence, not raw status" doc comment) — keep
  // showing the last real graph across the switch instead of unmounting; `graph` only actually
  // moves once the new scope's own real fetch resolves, whether that's fresh data or a genuinely
  // empty result.
  // A second, real bug this same mechanism uncovered: `status === 'idle'` doesn't always mean
  // "no group is genuinely selected." Switching FROM "All Worker Groups" BACK to one specific
  // group flips which hook is read (`isAllGroups` → false → back to `single`) before `single`'s
  // own effect has had a chance to re-fire for its newly-real `groupId` — so for one render,
  // `single` still reports whatever it was last left at, which is `status: 'idle'` (from the
  // *previous* switch, when its own `groupId` argument went `undefined`). Trusting that raw
  // `status` cleared `graph` immediately, unmounting the table anyway — the exact bug this whole
  // mechanism exists to prevent, just from the opposite direction. `trulyIdle` answers the real
  // question directly from the actual selection (`state.selectedGroupId`/`isAllGroups`) instead of
  // trusting either hook's own possibly-stale-mid-switch `status`.
  const trulyIdle = !isAllGroups && !state.selectedGroupId;
  const [graph, setGraph] = useState(rawGraph);
  if (rawGraph && rawGraph !== graph) setGraph(rawGraph);
  useEffect(() => {
    if (trulyIdle) setGraph(undefined);
  }, [trulyIdle]);

  // The manual Refresh button and the auto-refresh timer both go through this, not `refresh`
  // directly, so the top bar's "Pending Commit & Deploy" tag (`PageHeader.tsx`) picks up fresh
  // `pendingCommits`/`pendingDeploy` values on both real refresh triggers.
  const handleRefresh = useCallback(() => {
    refresh();
    void refreshWorkerGroups();
  }, [refresh, refreshWorkerGroups]);

  useEffect(() => {
    if (status !== 'ready' || state.autoRefreshId === 'off') return;
    const ms = AUTO_REFRESH_OPTIONS.find((o) => o.id === state.autoRefreshId)?.ms ?? 60_000;
    const interval = setInterval(handleRefresh, ms);
    return () => clearInterval(interval);
  }, [status, state.autoRefreshId, handleRefresh]);

  // Worker Group/Product/Time Range/Metric switches already trigger a real background refetch on
  // their own (real inputs to `useFlowGraph`/`useMultiGroupFlowGraph`) — the shared status filter
  // doesn't (it's a pure client-side narrowing of the already-fetched `graph`), so it gets its own
  // explicit trigger here.
  useSkipFirstEffect(handleRefresh, [state.statusFilter, state.topSourcesEnabled]);
  // Debounced so the table's own free-text search box triggers one background refresh shortly
  // after typing stops, not one per keystroke — see `FlowExplorerTable`'s own `onFilterChange` prop.
  const debouncedRefreshOnTextFilter = useDebouncedCallback(handleRefresh, 600);

  return (
    <div className="view-page">
      <PageHeader title="Flow Explorer" showTopSourcesToggle>
        <Tooltip title="Refresh" placement="bottom">
          <CustomTooltipTrigger>
            <IconButton
              icon={ReloadOutlined}
              aria-label="Refresh flow data"
              variant="secondary"
              pending={status === 'loading'}
              disabled={status !== 'ready'}
              onClick={handleRefresh}
            />
          </CustomTooltipTrigger>
        </Tooltip>
      </PageHeader>
      <div className="view-body flow-explorer-body">
        {/* Gated on graph presence, not `status` alone — matching Signal Path's own established
            pattern. `status` flips to `'loading'` on every refresh (manual or auto), including one
            replacing an already-loaded graph with a newer one; gating the table on
            `status === 'ready'` would unmount it (and its own local search/sort/expand state) on
            every single refresh, not just a real first load. */}
        {status === 'loading' && !graph && (
          <div className="flow-explorer-status">
            <Spinner size="lg" title="Loading flow graph…" />
          </div>
        )}

        {status === 'error' && !graph && (
          <div className="flow-explorer-status">
            <EmptyState
              size="lg"
              title={isPermissionError ? 'Insufficient permissions' : `Could not load this ${groupNoun}`}
              description={error ?? 'An unexpected error occurred.'}
            />
          </div>
        )}

        {trulyIdle && (
          <div className="flow-explorer-status">
            <EmptyState size="lg" title={`Select a ${groupNoun}`} description={`Choose a ${groupNoun} above to see its flow.`} />
          </div>
        )}

        {graph && graph.nodes.length === 0 && (
          <div className="flow-explorer-status">
            <EmptyState size="lg" title="Nothing configured yet" description={`This ${groupNoun} has no Sources, Routes, or Destinations configured.`} />
          </div>
        )}

        {graph && graph.nodes.length > 0 && (
          <FlowExplorerTable
            graph={graph}
            unit={state.metric}
            statusFilter={state.statusFilter}
            timeRangeId={state.timeRangeId}
            initialSearchFilter={initialSearchFilterRef.current}
            onFilterChange={debouncedRefreshOnTextFilter}
            groupProductById={groupProductById}
            topSourcesEnabled={state.topSourcesEnabled}
            topSourcesCount={state.topSourcesCount}
          />
        )}
      </div>
    </div>
  );
}
