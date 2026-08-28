import { useEffect, useRef, useState } from 'react';
import type { AppStateContextValue } from '../state/AppState';
import { ALL_GROUPS_ID, TIME_RANGE_OPTIONS, type StatusFilter, type TimeRangeOption, type VolumeUnit } from './types';

/**
 * Makes the current filtered view (Worker Group, time range, status filter, metric unit)
 * shareable via a plain URL — pasting the address bar to a colleague reproduces the exact same
 * scope, complementing (not replacing) the existing per-user Saved Views, which persist in the
 * KV store and aren't something you can hand someone who doesn't already have this app open.
 *
 * Query params only carry a value when it differs from what a fresh load would already show, so
 * an untouched app keeps a clean URL — `?group=...` only appears once a real Worker Group is
 * selected, `?range=...` only once it's not this app's own default, and so on. On load, a
 * recognized param overrides whatever the user's own KV-persisted preference would otherwise
 * show — a shared link's own point is to show what it says, not the visiting user's last-used
 * scope — read once, via the existing `group/select`/`timeRange/set`/`statusFilter/set`/
 * `metric/set` actions every other part of this app already dispatches through, not a second
 * state-loading path of its own.
 */
const PARAM_KEYS = { group: 'group', range: 'range', status: 'status', metric: 'metric' } as const;

const VALID_TIME_RANGE_IDS = new Set(TIME_RANGE_OPTIONS.map((t) => t.id));
const VALID_STATUS_FILTERS = new Set<StatusFilter>(['all', 'enabled', 'active', 'unhealthy', 'nodata']);
const VALID_METRICS = new Set<VolumeUnit>(['events', 'bytes']);

export function useShareableUrlState({ state, dispatch }: AppStateContextValue): void {
  const appliedFromUrl = useRef(false);
  // Captured once, at the very first render — the load effect below is deliberately deferred until
  // `state.workerGroups` has loaded, but the sync effect further down runs immediately and rewrites
  // `window.location.search` on every state change in the meantime (via `replaceState`, reflecting
  // whatever `selectedGroupId` the reducer's own default auto-selection already set). Reading
  // `window.location.search` live inside the deferred load effect would race against that rewrite
  // and see its own already-applied — and by then possibly wrong-product — value instead of the
  // real, original link. A `useState` initializer runs exactly once, before either effect below
  // has had a chance to touch the URL.
  const [originalSearch] = useState(() => window.location.search);

  // Applied once — but not until `state.workerGroups` has actually loaded (or failed to), not on
  // the very first render. A `?group=` param needs to resolve which real group it names before it
  // can also switch the top-left Stream/Edge toggle (`groupProductFilter`) to match — otherwise a
  // shared link into an Edge Fleet while the toggle defaults to Stream would select a group id the
  // Worker Group dropdown doesn't currently list at all. `appliedFromUrl` still only ever lets this
  // run once — later, real user-driven changes are never meant to be silently re-overridden by the
  // original link's own params.
  useEffect(() => {
    if (appliedFromUrl.current) return;
    if (state.workerGroupsStatus === 'loading') return;
    appliedFromUrl.current = true;
    const params = new URLSearchParams(originalSearch);

    const group = params.get(PARAM_KEYS.group);
    if (group) {
      const target = state.workerGroups.find((g) => g.id === group);
      if (target && (target.type === 'stream' || target.type === 'edge') && target.type !== state.groupProductFilter) {
        dispatch({ type: 'groupProductFilter/set', product: target.type });
      }
      dispatch({ type: 'group/select', groupId: group });
    }

    const range = params.get(PARAM_KEYS.range) as TimeRangeOption['id'] | null;
    if (range && VALID_TIME_RANGE_IDS.has(range)) dispatch({ type: 'timeRange/set', timeRangeId: range });

    const status = params.get(PARAM_KEYS.status) as StatusFilter | null;
    if (status && VALID_STATUS_FILTERS.has(status)) dispatch({ type: 'statusFilter/set', statusFilter: status });

    const metric = params.get(PARAM_KEYS.metric) as VolumeUnit | null;
    if (metric && VALID_METRICS.has(metric)) dispatch({ type: 'metric/set', metric });
  }, [state.workerGroupsStatus, state.workerGroups, state.groupProductFilter, dispatch, originalSearch]);

  // Keeps the address bar in sync with every later change — `replaceState`, not a real navigation
  // (`pushState`/react-router's own `navigate`), so tweaking a filter doesn't pollute the
  // back/forward history with one entry per click; the URL is just always an accurate, copyable
  // snapshot of "what am I looking at right now."
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const setOrDelete = (key: string, value: string | undefined) => {
      if (value) params.set(key, value);
      else params.delete(key);
    };
    setOrDelete(PARAM_KEYS.group, state.selectedGroupId && state.selectedGroupId !== ALL_GROUPS_ID ? state.selectedGroupId : undefined);
    setOrDelete(PARAM_KEYS.range, state.timeRangeId);
    setOrDelete(PARAM_KEYS.status, state.statusFilter !== 'active' ? state.statusFilter : undefined);
    setOrDelete(PARAM_KEYS.metric, state.metric !== 'bytes' ? state.metric : undefined);
    const query = params.toString();
    const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, '', url);
    }
  }, [state.selectedGroupId, state.timeRangeId, state.statusFilter, state.metric]);
}
