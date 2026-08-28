import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { listWorkerGroups } from '../api/groups';
import { getKv, setKv } from '../api/kv';
import type { CriblUser } from '../lib/cribl-globals';
import {
  DEFAULT_PREFERENCES,
  type AutoRefreshOption,
  type FlowAnimationStyle,
  type GroupProductFilter,
  type SavedView,
  type SidebarMode,
  type StatusFilter,
  type TimeRangeOption,
  type UserPreferences,
  type ViewId,
  type VolumeUnit,
  type WorkerGroupSummary,
} from '../lib/types';

/** The two live/session sidebar flags `Sidebar.tsx` actually reads, derived from a `SidebarMode`
 *  preference — `'expanded'` starts uncollapsed with no hover behavior; `'hover'` starts collapsed
 *  but with hover-reveal on; `'collapsed'` starts collapsed with hover-reveal off. Kept as a plain
 *  derivation (not `sidebarMode` itself) rather than merged into one field, since the manual
 *  Collapse-toggle button in the sidebar rail still needs to flip `sidebarCollapsed` alone, for the
 *  current session only, without touching the persisted `sidebarMode` preference underneath it. */
function deriveSidebarFlags(mode: SidebarMode): { sidebarCollapsed: boolean; sidebarAutoExpandOnHover: boolean } {
  switch (mode) {
    case 'expanded':
      return { sidebarCollapsed: false, sidebarAutoExpandOnHover: false };
    case 'hover':
      return { sidebarCollapsed: true, sidebarAutoExpandOnHover: true };
    case 'collapsed':
    default:
      return { sidebarCollapsed: true, sidebarAutoExpandOnHover: false };
  }
}

const PREFS_KEY = 'preferences';
const SAVED_VIEWS_KEY = 'saved-views';

/** Root-caused live against the real org (see CLAUDE.md's dated entry): a KV key containing a
 *  literal `|` character — anywhere in it, flat or nested — 404s on Cribl's real KV store route
 *  every time, confirmed via a direct PUT/GET round trip through the same `/a/{appId}/kvstore/...`
 *  endpoint this app uses. A key with a `/` but no `|` works fine, so it's specifically the pipe,
 *  not path segmentation. `user.id` for an Auth0-backed org is always shaped like
 *  `auth0|<hex>` — every KV key this app ever built from a real user's own id was therefore
 *  permanently unroutable, which is the actual root cause of every save/load 404 this app has
 *  seen. Replacing every character outside `[A-Za-z0-9_-]` (not just `|` specifically — a
 *  different identity provider could plausibly produce other unsafe characters, e.g. `:`) is the
 *  fix: it's applied to the id before it's ever used in a key, so every key this app builds is
 *  guaranteed routable regardless of what shape a given org's identity provider happens to use. */
function sanitizeKvIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** The KV store is scoped per *app*, not per user (`AGENTS.md` — `/kvstore/*` rewrites to
 *  `/api/v1/a/{appId}/kvstore/*`, with no user segment at all) — a bare `preferences` key is one
 *  single entry every Cribl user of this app shares and overwrites. `window.getCriblUser().id` is
 *  the real per-user identity the platform provides; suffixing every key with it (sanitized, see
 *  `sanitizeKvIdSegment` above) turns the same shared store into a real per-user one. Per explicit
 *  direction this is a clean cutover, not a migration — everyone (including whoever was using the
 *  old bare `preferences`/`saved-views` keys before this) starts fresh from `DEFAULT_PREFERENCES`,
 *  and those old shared entries are simply left orphaned rather than copied forward. `'anonymous'`
 *  is only a safety net for `getCriblUser` rejecting outright (network blip, etc.) — AGENTS.md
 *  documents it as always present when actually running inside Cribl. */
function userScopedKey(base: string, userId: string | undefined): string {
  return `${base}/${userId ? sanitizeKvIdSegment(userId) : 'anonymous'}`;
}

interface AppState {
  workerGroups: WorkerGroupSummary[];
  workerGroupsStatus: 'loading' | 'ready' | 'error';
  workerGroupsError?: string;

  /** The signed-in user's own identity, for the "Welcome, {name}" greeting in `PageHeader.tsx`.
   *  `undefined` until `window.getCriblUser()` resolves (or forever, if it rejects outright — see
   *  this file's own doc comment on why that's a real, if unlikely, possibility) — every reader of
   *  this should treat that as "nothing to show yet," not an error state. */
  criblUser?: CriblUser;

  /** Primary Worker Group for Signal Path / Flow Explorer. */
  selectedGroupId?: string;
  /** The top-left Stream/Edge toggle (`PageHeader.tsx`) — which product `selectedGroupId` (and
   *  "All Worker Groups") is currently scoped to. Not a `UserPreferences` field — same reasoning
   *  as `statusFilter`, a session filter, not a durable setting worth persisting across reloads. */
  groupProductFilter: GroupProductFilter;

  view: ViewId;
  metric: VolumeUnit;
  timeRangeId: TimeRangeOption['id'];
  statusFilter: StatusFilter;
  /** The "Top N Active" filter's own on/off state (Signal Path/Flow Explorer top bars) — a real
   *  6th option in the same status-filter row as All/Enabled/Active/Unhealthy/No data
   *  (`PageHeader.tsx`), mutually exclusive with `statusFilter` (see the reducer's own `statusFilter/
   *  set`/`topSources/setEnabled` cases) rather than a second, independently-combinable narrowing.
   *  A shared, session-only field, same "live filter, not a durable setting" precedent `statusFilter`
   *  above already establishes (not persisted; resets to off on every fresh load). How many Sources
   *  it narrows down to when on is the separate, persisted `topSourcesCount` below. */
  topSourcesEnabled: boolean;
  /** How many *active* (real, non-zero-volume) Sources the "Top N Active" filter narrows down to —
   *  the persisted half of that same filter (`UserPreferences.topSourcesCount`, one of
   *  `TOP_SOURCES_COUNT_OPTIONS`, default 10). */
  topSourcesCount: number;

  /** One-shot pivot payload: the Overview page's "Volume Matrix" panel sets this right before
   *  navigating to Flow Explorer, so that page can pin down to exactly the one Source ->
   *  Destination pair the clicked cell represented. `FlowExplorerPage` clears it immediately
   *  after reading it once, same reasoning as `signalPathPendingFilter` above — left set, it
   *  would silently reapply on a later, unrelated visit to Flow Explorer. */
  flowExplorerPendingFilter?: { sourceLabel: string; destinationLabel: string };

  /** The persisted preference itself — source of truth for Settings' own active-icon display.
   *  `sidebarCollapsed`/`sidebarAutoExpandOnHover` below are the live/session state actually
   *  consumed by `Sidebar.tsx`, derived from this on load but independently mutable afterward (the
   *  manual Collapse-toggle button changes only those two, never this one — see `deriveSidebarFlags`
   *  above). Keeping them separate is what lets Settings correctly keep showing e.g. "Expanded" as
   *  the chosen mode even if the reader has manually collapsed the rail for this session alone. */
  sidebarMode: SidebarMode;
  sidebarCollapsed: boolean;
  sidebarAutoExpandOnHover: boolean;
  theme: UserPreferences['theme'];
  autoRefreshId: AutoRefreshOption['id'];
  flowAnimationStyle: FlowAnimationStyle;
  /** Worker Inventory's own mini-bar "warn" cutoffs, one pair per `GroupProductFilter` — see
   *  `UserPreferences.cpuPressureWarnPctStream`'s own doc comment for why these deliberately stay
   *  a display-only preference, never wired into the worker's own real derived health/Status
   *  color, and why they're split by product. */
  cpuPressureWarnPctStream: number;
  cpuPressureWarnPctEdge: number;
  memPressureWarnPctStream: number;
  memPressureWarnPctEdge: number;
  diskPressureWarnPctStream: number;
  diskPressureWarnPctEdge: number;

  savedViews: SavedView[];
  preferencesLoaded: boolean;
}

type Action =
  | { type: 'workerGroups/loading' }
  | { type: 'workerGroups/loaded'; groups: WorkerGroupSummary[] }
  | { type: 'workerGroups/error'; message: string }
  | { type: 'criblUser/loaded'; user: CriblUser }
  | { type: 'preferences/loaded'; prefs: UserPreferences }
  | { type: 'preferences/reset' }
  | { type: 'savedViews/loaded'; views: SavedView[] }
  | { type: 'view/set'; view: ViewId }
  | { type: 'group/select'; groupId: string }
  | { type: 'groupProductFilter/set'; product: GroupProductFilter }
  | { type: 'metric/set'; metric: VolumeUnit }
  | { type: 'timeRange/set'; timeRangeId: TimeRangeOption['id'] }
  | { type: 'statusFilter/set'; statusFilter: StatusFilter }
  | { type: 'topSources/setEnabled'; enabled: boolean }
  | { type: 'topSourcesCount/set'; count: number }
  | { type: 'flowExplorer/setPendingFilter'; sourceLabel: string; destinationLabel: string }
  | { type: 'flowExplorer/clearPendingFilter' }
  | { type: 'sidebar/setCollapsed'; collapsed: boolean }
  | { type: 'sidebar/setMode'; mode: SidebarMode }
  | { type: 'theme/set'; theme: UserPreferences['theme'] }
  | { type: 'autoRefresh/set'; autoRefreshId: AutoRefreshOption['id'] }
  | { type: 'flowAnimation/set'; flowAnimationStyle: FlowAnimationStyle }
  | { type: 'pressureThreshold/set'; metric: 'cpu' | 'mem' | 'disk'; product: GroupProductFilter; pct: number }
  | { type: 'savedViews/upsert'; view: SavedView }
  | { type: 'savedViews/remove'; id: string };

const initialState: AppState = {
  workerGroups: [],
  workerGroupsStatus: 'loading',
  groupProductFilter: 'stream',
  view: DEFAULT_PREFERENCES.defaultView,
  metric: DEFAULT_PREFERENCES.lastMetric,
  timeRangeId: DEFAULT_PREFERENCES.lastTimeRangeId,
  statusFilter: 'active',
  topSourcesEnabled: false,
  topSourcesCount: DEFAULT_PREFERENCES.topSourcesCount!,
  sidebarMode: DEFAULT_PREFERENCES.sidebarMode,
  ...deriveSidebarFlags(DEFAULT_PREFERENCES.sidebarMode),
  theme: DEFAULT_PREFERENCES.theme,
  autoRefreshId: DEFAULT_PREFERENCES.autoRefreshId,
  flowAnimationStyle: DEFAULT_PREFERENCES.flowAnimationStyle,
  cpuPressureWarnPctStream: DEFAULT_PREFERENCES.cpuPressureWarnPctStream!,
  cpuPressureWarnPctEdge: DEFAULT_PREFERENCES.cpuPressureWarnPctEdge!,
  memPressureWarnPctStream: DEFAULT_PREFERENCES.memPressureWarnPctStream!,
  memPressureWarnPctEdge: DEFAULT_PREFERENCES.memPressureWarnPctEdge!,
  diskPressureWarnPctStream: DEFAULT_PREFERENCES.diskPressureWarnPctStream!,
  diskPressureWarnPctEdge: DEFAULT_PREFERENCES.diskPressureWarnPctEdge!,
  savedViews: [],
  preferencesLoaded: false,
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'workerGroups/loading':
      return { ...state, workerGroupsStatus: 'loading', workerGroupsError: undefined };
    case 'workerGroups/loaded': {
      const selectedGroupId = state.selectedGroupId ?? action.groups.find((g) => g.type === 'stream')?.id;
      return { ...state, workerGroups: action.groups, workerGroupsStatus: 'ready', selectedGroupId };
    }
    case 'workerGroups/error':
      return { ...state, workerGroupsStatus: 'error', workerGroupsError: action.message };
    case 'criblUser/loaded':
      return { ...state, criblUser: action.user };
    case 'preferences/loaded': {
      // `?? default`, not just the loaded value directly — an existing user's stored preferences
      // object predates this field and won't have it at all, which would otherwise leave this
      // `undefined` instead of a real mode.
      const sidebarMode = action.prefs.sidebarMode ?? DEFAULT_PREFERENCES.sidebarMode;
      return {
        ...state,
        preferencesLoaded: true,
        view: action.prefs.defaultView,
        theme: action.prefs.theme,
        autoRefreshId: action.prefs.autoRefreshId,
        // `?? default` — an existing user's stored preferences object predates this field too.
        flowAnimationStyle: action.prefs.flowAnimationStyle ?? DEFAULT_PREFERENCES.flowAnimationStyle,
        sidebarMode,
        ...deriveSidebarFlags(sidebarMode),
        metric: action.prefs.lastMetric,
        timeRangeId: action.prefs.lastTimeRangeId,
        selectedGroupId: action.prefs.lastWorkerGroupId ?? state.selectedGroupId,
        // `?? default` — an existing user's stored preferences object predates these fields (both
        // the original pair and this round's product-split rename).
        cpuPressureWarnPctStream: action.prefs.cpuPressureWarnPctStream ?? DEFAULT_PREFERENCES.cpuPressureWarnPctStream!,
        cpuPressureWarnPctEdge: action.prefs.cpuPressureWarnPctEdge ?? DEFAULT_PREFERENCES.cpuPressureWarnPctEdge!,
        memPressureWarnPctStream: action.prefs.memPressureWarnPctStream ?? DEFAULT_PREFERENCES.memPressureWarnPctStream!,
        memPressureWarnPctEdge: action.prefs.memPressureWarnPctEdge ?? DEFAULT_PREFERENCES.memPressureWarnPctEdge!,
        diskPressureWarnPctStream: action.prefs.diskPressureWarnPctStream ?? DEFAULT_PREFERENCES.diskPressureWarnPctStream!,
        diskPressureWarnPctEdge: action.prefs.diskPressureWarnPctEdge ?? DEFAULT_PREFERENCES.diskPressureWarnPctEdge!,
        // `?? default` — an existing user's stored preferences object predates this field too.
        topSourcesCount: action.prefs.topSourcesCount ?? DEFAULT_PREFERENCES.topSourcesCount!,
      };
    }
    case 'preferences/reset':
      // Every field the Settings panel itself exposes, reset to the same `DEFAULT_PREFERENCES`
      // object a first-time user would start from — deliberately the same field mapping
      // `preferences/loaded` already uses (just sourced from the default constant instead of a
      // loaded KV value), so this goes through the exact same debounced-save effect below and
      // needs no separate persistence code of its own. Saved Views are a different KV key
      // entirely and are left untouched — a "reset settings" action resetting a user's own saved
      // content would be a much larger, unexpected side effect than what was asked for.
      return {
        ...state,
        view: DEFAULT_PREFERENCES.defaultView,
        theme: DEFAULT_PREFERENCES.theme,
        autoRefreshId: DEFAULT_PREFERENCES.autoRefreshId,
        flowAnimationStyle: DEFAULT_PREFERENCES.flowAnimationStyle,
        sidebarMode: DEFAULT_PREFERENCES.sidebarMode,
        ...deriveSidebarFlags(DEFAULT_PREFERENCES.sidebarMode),
        metric: DEFAULT_PREFERENCES.lastMetric,
        timeRangeId: DEFAULT_PREFERENCES.lastTimeRangeId,
        // Real bug this fixed: this used to read `DEFAULT_PREFERENCES.lastWorkerGroupId ??
        // state.selectedGroupId` — `lastWorkerGroupId` is *always* `undefined` (an unset
        // preference, by design), so that expression always fell through to `state.
        // selectedGroupId` unchanged, meaning a reset never actually touched the selected group at
        // all, contradicting the setting's own name ("Default Worker Group/Edge Fleet") and the
        // confirm dialog's own claim that it would be reset. Fixed to mirror exactly what a fresh,
        // first-time load computes (`workerGroups/loaded`'s own `state.workerGroups.find((g) => g.
        // type === 'stream')?.id`) — a real reset now lands on the same real, concrete Stream group
        // a brand-new session would, with `groupProductFilter` reset to `'stream'` alongside it so
        // the two always agree (the same class of "picked a group of one product, toggle stuck on
        // the other" bug `group/select` above now guards against, closed here too).
        selectedGroupId: state.workerGroups.find((g) => g.type === 'stream')?.id,
        groupProductFilter: 'stream',
        cpuPressureWarnPctStream: DEFAULT_PREFERENCES.cpuPressureWarnPctStream!,
        cpuPressureWarnPctEdge: DEFAULT_PREFERENCES.cpuPressureWarnPctEdge!,
        memPressureWarnPctStream: DEFAULT_PREFERENCES.memPressureWarnPctStream!,
        memPressureWarnPctEdge: DEFAULT_PREFERENCES.memPressureWarnPctEdge!,
        diskPressureWarnPctStream: DEFAULT_PREFERENCES.diskPressureWarnPctStream!,
        diskPressureWarnPctEdge: DEFAULT_PREFERENCES.diskPressureWarnPctEdge!,
        topSourcesCount: DEFAULT_PREFERENCES.topSourcesCount!,
      };
    case 'savedViews/loaded':
      return { ...state, savedViews: action.views };
    case 'view/set':
      return { ...state, view: action.view };
    case 'group/select': {
      // A real, concrete group's own `type` always wins the product toggle too, not just the
      // group id — real bug this fixed: Settings' own "Default Worker Group/Edge Fleet" picker
      // lists both Stream Worker Groups and Edge Fleets in one unified list (unlike the top bar's
      // own dropdown, which is already pre-filtered to just the current product's groups), so
      // picking an Edge Fleet there previously left `groupProductFilter` on whatever it already
      // was — usually still `'stream'` — and every page's own `supportedGroups` filter (scoped to
      // the current product) then couldn't find the newly-selected Fleet id among its own
      // candidates at all, reading as "nothing selected" and showing the empty "Select a Worker
      // Group" state directly under a dropdown that looked like it had a real selection. The
      // `ALL_GROUPS_ID` sentinel has no real `.type` of its own, so it leaves the product filter
      // untouched, matching `groupProductFilter/set`'s own established behavior for "no group in
      // particular." A real caller whose own dropdown is already product-filtered (the top bar)
      // never actually changes `groupProductFilter` via this path — the selected group's `.type`
      // always already matches the current one there, so this is a no-op for that caller.
      const group = state.workerGroups.find((g) => g.id === action.groupId);
      // `WorkerGroupSummary.type` is the broader `ProductType` (Search/Outpost included) — only a
      // real, selectable Stream/Edge type can drive the toggle; anything else (shouldn't normally
      // reach here at all, since neither dropdown ever lists a Search/Outpost group) leaves it as
      // it was rather than assigning a value the toggle itself doesn't support.
      const product: GroupProductFilter | undefined = group?.type === 'stream' || group?.type === 'edge' ? group.type : undefined;
      return { ...state, selectedGroupId: action.groupId, groupProductFilter: product ?? state.groupProductFilter };
    }
    case 'groupProductFilter/set': {
      // Mirrors `workerGroups/loaded`'s own first-load default (auto-select the first real group
      // of the relevant product) rather than resetting to "All Worker Groups" — the previously
      // selected group almost certainly doesn't exist under the new product at all, so landing on
      // a real, concrete group reads as a deliberate switch, not an empty "now pick one again."
      const firstOfProduct = state.workerGroups.find((g) => g.type === action.product)?.id;
      return { ...state, groupProductFilter: action.product, selectedGroupId: firstOfProduct };
    }
    case 'metric/set':
      return { ...state, metric: action.metric };
    case 'timeRange/set':
      return { ...state, timeRangeId: action.timeRangeId };
    // Mutually exclusive with the Top N Active filter (both now live in the same visual row, see
    // `PageHeader.tsx`) — picking a real status filter always turns that filter off, rather than
    // combining the two (e.g. "Unhealthy" + "Top 10 Active" narrowed by both at once).
    case 'statusFilter/set':
      return { ...state, statusFilter: action.statusFilter, topSourcesEnabled: false };
    case 'topSources/setEnabled':
      return { ...state, topSourcesEnabled: action.enabled };
    case 'topSourcesCount/set':
      return { ...state, topSourcesCount: action.count };
    case 'flowExplorer/setPendingFilter':
      return { ...state, flowExplorerPendingFilter: { sourceLabel: action.sourceLabel, destinationLabel: action.destinationLabel } };
    case 'flowExplorer/clearPendingFilter':
      return { ...state, flowExplorerPendingFilter: undefined };
    case 'sidebar/setCollapsed':
      return { ...state, sidebarCollapsed: action.collapsed };
    // Immediately re-derives the live `sidebarCollapsed`/`sidebarAutoExpandOnHover` flags too, not
    // just the persisted `sidebarMode` — the same "picking a new Settings option applies right
    // away" behavior `theme/set` already has, rather than only taking effect on the next reload.
    case 'sidebar/setMode':
      return { ...state, sidebarMode: action.mode, ...deriveSidebarFlags(action.mode) };
    case 'theme/set':
      return { ...state, theme: action.theme };
    case 'autoRefresh/set':
      return { ...state, autoRefreshId: action.autoRefreshId };
    case 'flowAnimation/set':
      return { ...state, flowAnimationStyle: action.flowAnimationStyle };
    case 'pressureThreshold/set': {
      const field = `${action.metric}PressureWarnPct${action.product === 'stream' ? 'Stream' : 'Edge'}` as
        | 'cpuPressureWarnPctStream'
        | 'cpuPressureWarnPctEdge'
        | 'memPressureWarnPctStream'
        | 'memPressureWarnPctEdge'
        | 'diskPressureWarnPctStream'
        | 'diskPressureWarnPctEdge';
      return { ...state, [field]: action.pct };
    }
    case 'savedViews/upsert': {
      const existingIndex = state.savedViews.findIndex((v) => v.id === action.view.id);
      const savedViews = [...state.savedViews];
      if (existingIndex >= 0) savedViews[existingIndex] = action.view;
      else savedViews.push(action.view);
      return { ...state, savedViews };
    }
    case 'savedViews/remove':
      return { ...state, savedViews: state.savedViews.filter((v) => v.id !== action.id) };
    default:
      return state;
  }
}

export interface AppStateContextValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  saveSavedView: (view: SavedView) => Promise<void>;
  /** Volatile — callers must have already confirmed this with the user before calling. */
  deleteSavedView: (id: string) => Promise<void>;
  /** Re-fetches `state.workerGroups` — the only way to pick up fresh `pendingCommits`/
   *  `pendingDeploy` values (`PageHeader.tsx`'s "Pending Commit & Deploy" tag) after the initial
   *  load, since that data otherwise only loads once, on mount. Deliberately does *not* dispatch
   *  `workerGroups/loading` first (unlike the real initial load) — this runs silently in the
   *  background on every page's own manual Refresh click and auto-refresh tick, and flipping
   *  `workerGroupsStatus` to `'loading'` on every one of those would disable the Worker Group
   *  `<select>` for the duration, the same "don't unmount/disable on a background refresh" lesson
   *  this app has already learned the hard way elsewhere (see e.g. `SignalPathPage.tsx`'s own doc
   *  comment on gating render by data presence, not `status`). Failures are swallowed — a stale
   *  Worker Group list is a better outcome than replacing an already-working one with an error. */
  refreshWorkerGroups: () => Promise<void>;
}

const AppStateContext = createContext<AppStateContextValue | undefined>(undefined);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const hasLoadedPrefs = useRef(false);
  // Set once `window.getCriblUser()` resolves, before either KV load below fires — the save
  // effect and `saveSavedView`/`deleteSavedView` all read this ref rather than re-awaiting
  // `getCriblUser()` themselves each time (the platform memoizes it too, so this is purely to
  // avoid a promise round-trip on every keystroke-driven save, not to work around it being slow).
  const userIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    dispatch({ type: 'workerGroups/loading' });
    listWorkerGroups()
      .then((groups) => dispatch({ type: 'workerGroups/loaded', groups }))
      .catch((err: unknown) => dispatch({ type: 'workerGroups/error', message: err instanceof Error ? err.message : String(err) }));

    // `user.id` is Cribl's own stable per-user identifier (frequently an Auth0 subject string
    // like `auth0|<hex>` when the org's identity provider is Auth0-backed) — used to scope KV
    // keys rather than `user.username`, since it's the one field guaranteed to never change even
    // if a user's display name/username is edited later. Sanitized (`sanitizeKvIdSegment`) before
    // it goes into a KV key — a literal `|` character was confirmed live to break Cribl's own KV
    // store routing entirely (see `userScopedKey`'s own doc comment).
    window
      .getCriblUser()
      .then((user) => {
        dispatch({ type: 'criblUser/loaded', user });
        return user.id;
      })
      .catch(() => undefined)
      .then((userId) => {
        userIdRef.current = userId;
        const prefsKey = userScopedKey(PREFS_KEY, userId);
        getKv<UserPreferences>(prefsKey)
          // A genuine fetch failure (network blip, non-404 error — `getKv` only ever swallows a
          // 404 itself) must still resolve to *something*, not leave this promise chain silently
          // dead: `state.preferencesLoaded` gates the app's own initial-route redirect below (see
          // `App.tsx`), so if this never dispatched, a real fetch failure would leave the whole
          // app stuck on that route's loading state forever instead of falling back to defaults.
          .catch(() => DEFAULT_PREFERENCES)
          .then((prefs) => dispatch({ type: 'preferences/loaded', prefs: prefs ?? DEFAULT_PREFERENCES }))
          .finally(() => {
            hasLoadedPrefs.current = true;
          });

        const savedViewsKey = userScopedKey(SAVED_VIEWS_KEY, userId);
        getKv<SavedView[]>(savedViewsKey).then((views) => dispatch({ type: 'savedViews/loaded', views: views ?? [] }));
      });
  }, []);

  // Persist non-sensitive UI preferences to the KV store the instant any of them change, once the
  // initial load has completed (so we don't immediately overwrite a stored preference with the
  // default on first render). `hasLoadedPrefs` only ever flips to `true` after `userIdRef` is
  // already set (both happen inside the same `getCriblUser().then(...)` continuation above), so
  // it's safe to read the ref here without a separate null check gating it.
  //
  // Deliberately *not* debounced, after two real, confirmed data-loss bugs traced back to exactly
  // that: a debounce (this used to be 500ms) means a setting only exists in memory, not in the KV
  // store, for that whole window — and closing the app, or (per a direct user report) switching to
  // a *different* Cribl app and back, can both tear down this app's own iframe well inside that
  // window with no reliable warning event this app's own code can catch first (a `visibilitychange`
  // -on-hide flush closed the "close the browser tab" case, confirmed live, but evidently not
  // whatever mechanism the platform uses to swap between two different installed Apps). Removing
  // the artificial delay entirely — rather than continuing to chase which teardown signals this
  // specific host platform does or doesn't reliably fire — is the one fix that doesn't depend on
  // guessing that. `setKv` also passes `keepalive: true` through to `fetch` by default (see its own
  // doc comment), so even a save that's still in flight the instant the page/iframe is torn down
  // still has a real chance to land instead of being aborted mid-request. The tradeoff is a real
  // one, not a free lunch: this can now fire once per click while a user rapidly browses through
  // several Worker Groups/time ranges in a row, instead of coalescing them into one write — a
  // small, harmless increase in KV traffic for a low-frequency, human-driven dashboard, clearly
  // worth it against silently losing a deliberate Settings change.
  useEffect(() => {
    if (!hasLoadedPrefs.current) return;
    const prefs: UserPreferences = {
      defaultView: state.view,
      theme: state.theme,
      autoRefreshId: state.autoRefreshId,
      flowAnimationStyle: state.flowAnimationStyle,
      lastWorkerGroupId: state.selectedGroupId,
      lastMetric: state.metric,
      lastTimeRangeId: state.timeRangeId,
      sidebarMode: state.sidebarMode,
      cpuPressureWarnPctStream: state.cpuPressureWarnPctStream,
      cpuPressureWarnPctEdge: state.cpuPressureWarnPctEdge,
      memPressureWarnPctStream: state.memPressureWarnPctStream,
      memPressureWarnPctEdge: state.memPressureWarnPctEdge,
      diskPressureWarnPctStream: state.diskPressureWarnPctStream,
      diskPressureWarnPctEdge: state.diskPressureWarnPctEdge,
      topSourcesCount: state.topSourcesCount,
    };
    void setKv(userScopedKey(PREFS_KEY, userIdRef.current), prefs);
  }, [
    state.view,
    state.theme,
    state.autoRefreshId,
    state.flowAnimationStyle,
    state.selectedGroupId,
    state.metric,
    state.timeRangeId,
    state.sidebarMode,
    state.cpuPressureWarnPctStream,
    state.cpuPressureWarnPctEdge,
    state.memPressureWarnPctStream,
    state.memPressureWarnPctEdge,
    state.diskPressureWarnPctStream,
    state.diskPressureWarnPctEdge,
    state.topSourcesCount,
  ]);

  // A genuinely stable reference (`dispatch` from `useReducer` never changes identity, and this
  // never reads `state` itself) — deliberately hoisted out of the `value` object's own `[state]`-
  // dependent `useMemo` below, unlike `saveSavedView`/`deleteSavedView` (which do need a fresh
  // closure over `state.savedViews`). Every page wires this into its own `useCallback`-memoized
  // refresh handler (manual button + auto-refresh interval); if this weren't stable, doing so
  // would recreate that handler — and reset the interval it drives — on every unrelated state
  // change, not just a real refresh.
  const refreshWorkerGroups = useCallback(async () => {
    try {
      const groups = await listWorkerGroups();
      dispatch({ type: 'workerGroups/loaded', groups });
    } catch {
      // Swallowed — see this method's own doc comment (`AppStateContextValue`) above.
    }
  }, []);

  const value = useMemo<AppStateContextValue>(
    () => ({
      state,
      dispatch,
      saveSavedView: async (view) => {
        dispatch({ type: 'savedViews/upsert', view });
        const next = [...state.savedViews.filter((v) => v.id !== view.id), view];
        await setKv(userScopedKey(SAVED_VIEWS_KEY, userIdRef.current), next);
      },
      deleteSavedView: async (id) => {
        dispatch({ type: 'savedViews/remove', id });
        const next = state.savedViews.filter((v) => v.id !== id);
        await setKv(userScopedKey(SAVED_VIEWS_KEY, userIdRef.current), next);
      },
      refreshWorkerGroups,
    }),
    [state, refreshWorkerGroups],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within an AppStateProvider');
  return ctx;
}
