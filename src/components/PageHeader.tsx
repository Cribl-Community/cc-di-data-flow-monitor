import { Text } from '@capra/core';
import { useAppState } from '../state/AppState';
import { ALL_GROUPS_ID, TIME_RANGE_OPTIONS, type GroupProductFilter, type StatusFilter } from '../lib/types';
import { isGroupOfProduct, isSupportedGroup } from '../api/groups';
import type { CriblUser } from '../lib/cribl-globals';
import { CommitDeployStatus } from './CommitDeployStatus';
import './PageHeader.css';

/** Prefers the real first name over the bare `username` — a friendlier greeting than an account
 *  handle where the platform gives us one. `username` is the one field `CriblUser` always has, so
 *  this only ever returns `undefined` while the identity itself hasn't loaded yet (see
 *  `AppState.tsx`'s own doc comment on `state.criblUser`). */
function displayNameFor(user: CriblUser | undefined): string | undefined {
  if (!user) return undefined;
  return user.firstName ?? user.username;
}

const PRODUCT_FILTER_ORDER: GroupProductFilter[] = ['stream', 'edge'];
const PRODUCT_FILTER_LABEL: Record<GroupProductFilter, string> = {
  stream: 'Stream',
  edge: 'Edge',
};
// The Worker Group dropdown's own sentinel "everything in scope" option — worded to match
// whichever product the toggle above currently has selected ("Worker Group" is Stream's own
// vocabulary; Edge calls the same concept a "Fleet").
const ALL_GROUPS_LABEL: Record<GroupProductFilter, string> = {
  stream: 'All Worker Groups',
  edge: 'All Fleets',
};

// Plain native <select> controls, restyled as pills, for Worker Group / Time Range — Capra's
// AutocompleteField/Menu are the better long-term fit but their exact selection-callback
// contracts weren't confirmed safe to rely on blind; see CLAUDE.md open questions.

// The one status-filter pack every dashboard's top bar shows — originally built for Signal Path's
// own config-only validation page, promoted here once that page became the real Signal Path (see
// `StatusFilter`'s own doc comment, `lib/types.ts`). No standalone "Degraded" button: `degraded`
// can now only ever mean one specific thing app-wide (a Destination blocked on some, but not all,
// Worker processes — see `deriveHealth`/`withWorkerAlert`), which `matchesStatusFilter` already
// folds into "Unhealthy" itself, so a separate button for it would be an unreachable duplicate.
// On Signal Path/Flow Explorer, a 6th button ("Top N Active," gated by `showTopSourcesToggle`) is
// appended to this same row below, real `StatusFilter` type though it isn't — see
// `AppState.tsx`'s own `topSourcesEnabled` field for why it's mutually exclusive with these five
// rather than a plain 6th `StatusFilter` value (it needs to *rank* nodes, not just test one at a
// time, which every real `StatusFilter` value's own predicate does).
const STATUS_FILTER_ORDER: StatusFilter[] = ['all', 'enabled', 'active', 'unhealthy', 'nodata'];
const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: 'All',
  enabled: 'Enabled',
  active: 'Active',
  unhealthy: 'Unhealthy',
  nodata: 'No data',
};

interface PageHeaderProps {
  title: string;
  children?: React.ReactNode;
  /** Omits the shared status-filter segmented control — for a page (Overview) whose own panels
   *  don't read `state.statusFilter` at all and already have their own, more specific local
   *  filtering (Node Inventory's own search box), where the shared control would just be a
   *  second, redundant, and disconnected filter mechanism. Every other page still gets it by
   *  default. */
  showStatusFilter?: boolean;
  /** Omits the shared Events/Bytes segmented control — for Signal Path, whose canvas/cards show
   *  Events only by deliberate design (Bytes appears only as a secondary line/local switcher on
   *  individual cards, never as a page-level unit toggle). Every other page still gets it. */
  showMetricToggle?: boolean;
  /** Adds a "Top N Active" button to the shared status-filter row — a real 6th, mutually-exclusive
   *  option alongside All/Enabled/Active/Unhealthy/No data (see `AppState.tsx`'s own `statusFilter/
   *  set`/`topSources/setEnabled` reducer cases), narrowing the page's own view down to just the top
   *  `state.topSourcesCount` *active* (real, non-zero-volume) Sources by volume in the selected time
   *  range — and, on Signal Path, everything those Sources actually reach. Off by default; only
   *  Signal Path and Flow Explorer opt in, since Overview has no equivalent per-Source canvas/table
   *  to narrow. Requires `showStatusFilter` — there's no separate row to add it to otherwise. */
  showTopSourcesToggle?: boolean;
}

export function PageHeader({ title, children, showStatusFilter = true, showMetricToggle = true, showTopSourcesToggle = false }: PageHeaderProps) {
  const { state, dispatch } = useAppState();
  const welcomeName = displayNameFor(state.criblUser);
  // Scoped to just the top-left Stream/Edge toggle's own current product — "All Worker Groups"
  // and every commit/deploy figure below are both scoped through this same filtered list, not the
  // wider `isSupportedGroup` set, so switching products always narrows everything consistently.
  const supportedGroups = state.workerGroups.filter(isSupportedGroup).filter((g) => isGroupOfProduct(g, state.groupProductFilter));

  // Scoped to exactly what the Worker Group select above shows: every supported group under "All
  // Worker Groups," or just the one selected group otherwise — same real, already-fetched
  // `state.workerGroups` data (see `api/groups.ts`'s own doc comment for where `pendingCommits`/
  // `pendingDeploy` come from), no separate fetch needed.
  const isAllGroups = state.selectedGroupId === ALL_GROUPS_ID;
  const commitDeployScope = isAllGroups ? supportedGroups : supportedGroups.filter((g) => g.id === state.selectedGroupId);
  const pendingCommits = commitDeployScope.reduce((sum, g) => sum + g.pendingCommits, 0);
  const pendingDeployGroups = commitDeployScope.filter((g) => g.pendingDeploy).length;
  // No single real group to name in the redirect URL under "All Worker Groups" — the icon hides
  // itself rather than guessing which one the user actually meant.
  const commitDeployRedirectGroupId = isAllGroups ? undefined : state.selectedGroupId;

  return (
    <header className="page-header">
      <div className="page-header-top">
        <Text as="h1" variant="heading">
          {title}
        </Text>
        {welcomeName && (
          <Text as="span" variant="body-sm-normal" color="subtle" FORCE__className="page-header-welcome">
            Welcome {welcomeName}
          </Text>
        )}
      </div>

      <div className="control-bar">
        <div className="segmented" role="group" aria-label="Product">
          {PRODUCT_FILTER_ORDER.map((product) => (
            <button
              key={product}
              type="button"
              className={state.groupProductFilter === product ? 'active' : ''}
              aria-pressed={state.groupProductFilter === product}
              onClick={() => dispatch({ type: 'groupProductFilter/set', product })}
            >
              {PRODUCT_FILTER_LABEL[product]}
            </button>
          ))}
        </div>

        <select
          className="pill-select"
          aria-label={state.groupProductFilter === 'edge' ? 'Fleet' : 'Worker Group'}
          // `?? ALL_GROUPS_ID`, not `?? ''` — a bare `''` matches no real `<option>` here, which a
          // native `<select>` silently resolves by *displaying* whichever option is listed first
          // (`ALL_GROUPS_ID`'s own option, below) regardless of what `selectedGroupId` actually is.
          // That's exactly what let a real, confirmed bug hide in plain sight: `selectedGroupId`
          // could be a bare `undefined` (meaning "not really set to anything yet") while this
          // dropdown *looked* like "All Worker Groups" was a real, deliberate selection — see
          // `AppState.tsx`'s own `preferences/reset` doc comment for the full incident. Falling
          // back to the real sentinel here makes the display's own fallback intent explicit rather
          // than an accidental side effect of option ordering.
          value={state.selectedGroupId ?? ALL_GROUPS_ID}
          onChange={(e) => dispatch({ type: 'group/select', groupId: e.target.value })}
          disabled={state.workerGroupsStatus === 'loading'}
        >
          <option value={ALL_GROUPS_ID}>{ALL_GROUPS_LABEL[state.groupProductFilter]}</option>
          {supportedGroups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>

        <select
          className="pill-select"
          aria-label="Time Range"
          value={state.timeRangeId}
          onChange={(e) => dispatch({ type: 'timeRange/set', timeRangeId: e.target.value as (typeof TIME_RANGE_OPTIONS)[number]['id'] })}
        >
          {TIME_RANGE_OPTIONS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>

        {showMetricToggle && (
          <div className="segmented" role="group" aria-label="Metric">
            <button
              type="button"
              className={state.metric === 'events' ? 'active' : ''}
              aria-pressed={state.metric === 'events'}
              onClick={() => dispatch({ type: 'metric/set', metric: 'events' })}
            >
              Events
            </button>
            <button
              type="button"
              className={state.metric === 'bytes' ? 'active' : ''}
              aria-pressed={state.metric === 'bytes'}
              onClick={() => dispatch({ type: 'metric/set', metric: 'bytes' })}
            >
              Bytes
            </button>
          </div>
        )}

        {showStatusFilter && (
          <div className="segmented" role="group" aria-label="Status filter">
            {STATUS_FILTER_ORDER.map((status) => (
              <button
                key={status}
                type="button"
                className={!state.topSourcesEnabled && state.statusFilter === status ? 'active' : ''}
                aria-pressed={!state.topSourcesEnabled && state.statusFilter === status}
                onClick={() => dispatch({ type: 'statusFilter/set', statusFilter: status })}
              >
                {STATUS_FILTER_LABEL[status]}
              </button>
            ))}
            {showTopSourcesToggle && (
              <button
                type="button"
                className={state.topSourcesEnabled ? 'active' : ''}
                aria-pressed={state.topSourcesEnabled}
                title={`Show only the top ${state.topSourcesCount} active Sources by volume in the selected time range`}
                onClick={() => dispatch({ type: 'topSources/setEnabled', enabled: true })}
              >
                Top {state.topSourcesCount} Active
              </button>
            )}
          </div>
        )}

        {children}

        <CommitDeployStatus
          pendingCommits={pendingCommits}
          pendingDeployGroups={pendingDeployGroups}
          redirectGroupId={commitDeployRedirectGroupId}
          redirectProduct={state.groupProductFilter}
        />
      </div>
    </header>
  );
}
