// Shared data model for Data Flow Monitor for Cribl.
// Six-lane Cribl Stream processing model: Source -> Pre-Processing Pipeline -> Routes ->
// Pipeline -> Post-Processing Pipeline -> Destination, plus two structural extensions:
// pipeline "Chain" functions (a pipeline jumping into another pipeline) and Output Router
// destinations (a destination that itself fans out to real destinations via internal rules).

export type ProductType = 'stream' | 'edge' | 'search' | 'outpost';

/** The top-left product filter (`PageHeader.tsx`) — narrows the Worker Group dropdown, and
 *  everything scoped through it ("All Worker Groups" included), to just one product at a time.
 *  A strict subset of `ProductType`: Search/Outpost were never selectable here to begin with
 *  (see `isSupportedGroup`'s own doc comment). */
export type GroupProductFilter = 'stream' | 'edge';

/** Shared sentinel meaning "every Worker Group at once" — used by every page's Worker Group
 *  select (Signal Path/Flow Explorer's default one, and Settings' "Default Worker Group" picker),
 *  so they all recognize the same value rather than each page inventing its own. */
export const ALL_GROUPS_ID = '__all__';

export interface WorkerGroupSummary {
  id: string;
  name: string;
  description?: string;
  type: ProductType;
  isFleet?: boolean;
  isSearch?: boolean;
  onPrem?: boolean;
  estimatedIngestRate?: number;
  /** Real, uncommitted configuration changes for this group — see `api/groups.ts`'s own doc
   *  comment for the confirmed-live `fields` request this depends on. */
  pendingCommits: number;
  /** True once this group's currently *committed* configuration differs from what's actually
   *  deployed to its Workers. */
  pendingDeploy: boolean;
  /** The group's own currently-deployed config version hash — compared against a specific node's
   *  own reported `conf.confVersion` (`api/workerInfo.ts`) to flag a node that hasn't picked up the
   *  latest push yet, a real, common state for an intermittently-connected Edge node. */
  configVersion?: string;
}

/**
 * green = receiving & sending, grey = no data, red = receiving but not sending (or every real
 * Worker process reports a Destination as blocked). orange ("degraded") is never derived from a
 * drop count or an operational warning (see `deriveHealth`) — the only source of it anywhere in
 * this app is `withWorkerAlert`'s partial (some-but-not-all-workers) per-worker-blocked escalation.
 */
export type HealthStatus = 'good' | 'degraded' | 'nodata' | 'blocked';

export type VolumeUnit = 'events' | 'bytes';

export type NodeKind =
  | 'source'
  | 'prePipeline'
  | 'routes'
  | 'pipeline'
  | 'postPipeline'
  | 'destination'
  | 'outputRouter';

/**
 * Which of the 6 fixed columns a node kind actually renders in — `outputRouter` shares the
 * `destination` column (same visual lane, different node styling) rather than getting a 7th
 * column of its own, since to the layout algorithm it's just another kind of destination.
 */
export function visualLaneOf(kind: NodeKind): NodeKind {
  return kind === 'outputRouter' ? 'destination' : kind;
}

/** Fixed lane order for the Signal Path layout. Routes' own internal rule order is never resorted. */
export const LANES: readonly NodeKind[] = [
  'source',
  'prePipeline',
  'routes',
  'pipeline',
  'postPipeline',
  'destination',
];

interface MetricPoint {
  t: number;
  v: number;
}

interface NodeMetrics {
  inEvents?: number;
  outEvents?: number;
  inBytes?: number;
  outBytes?: number;
  /**
   * Always an event count, never bytes — confirmed live that no `dropped_bytes` metric exists
   * anywhere in the catalog (`total.*`/`route.*`/`pipe.*` all only have `dropped_events`), so
   * this doesn't vary with the selected unit the way in/out do.
   */
  droppedEvents?: number;
  /**
   * Function/processing errors this Pipeline has thrown in the selected window — set only on
   * `pipeline`/`prePipeline`/`postPipeline` nodes (from real `pipe.err_events`, see
   * `fetchPipelineVolumeTotals`'s own doc comment); `undefined` for every other node kind, which
   * has no equivalent metric. Always an event count, same reasoning as `droppedEvents` above.
   */
  errEvents?: number;
  /** 0-1, derived as (in - out) / in for the currently selected unit. */
  dropRate?: number;
  latencyP95?: number;
  pqDepth?: number;
  /** Same-shape totals for the baseline comparison period (e.g. this time yesterday). */
  baseline?: {
    inEvents?: number;
    outEvents?: number;
    inBytes?: number;
    outBytes?: number;
  };
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  workerGroupId: string;
  /**
   * Set only by `mergeFlowGraphs` (the "All Worker Groups" view) — the node's real, un-prefixed
   * Cribl id, since `id` there is scoped with the owning Worker Group id to keep it unique across
   * groups (e.g. two groups can each have a Destination literally named `local_splunk`) and can no
   * longer be split back apart by `rawIdOf` alone. Anything that needs the real id for an actual
   * Cribl API call (a metrics filter, a per-worker status lookup) should read `realRawIdOf(node)`
   * (falls back to `rawIdOf(node)` when this is unset, i.e. every non-merged graph), never `id`
   * or `rawIdOf` directly.
   */
  unscopedId?: string;
  health: HealthStatus;
  metrics: NodeMetrics;
  disabled?: boolean;
  /** Path within the Cribl UI for this component's config page, for the click-through deep link. */
  configPath?: string;
  /** Original API object, kept for the detail drawer. */
  raw?: unknown;
  /** Set on a `pipeline` node when its config chains into another pipeline via the Chain function. */
  chainedPipelineId?: string;
  /** Set on a `destination`/`outputRouter` node whose real config (`cribl_tcp`/`cribl_http`) is a
   *  Cribl-to-Cribl hop that resolves to a real, *different* Worker Group already known to this
   *  app — not a final terminus, but a continuation into another deployment (see
   *  `lib/crossDeploymentChain.ts`). Undefined for every other output type, an unresolvable host,
   *  or a same-group loopback. */
  chainsToGroupId?: string;
  /** Set on a `routes` node: total rule count (for the "+N more" cap on the canvas). */
  ruleCount?: number;
  /** Set on an `outputRouter` node: ids of the real destinations its internal rules point to. */
  routerRuleIds?: string[];
  /** True if the count of feeder sources for this node was observed empirically, not statically configured. */
  sourcesObserved?: boolean;
  /** Set on pipeline-role nodes: number of Functions configured in the Pipeline. */
  functionCount?: number;
  /** Cribl connector type (e.g. `splunk`, `datagen`) — needed to build the config deep link for sources/destinations. */
  refType?: string;
  /**
   * Set on a `routes` node: each rule's own health, keyed by rule id. A route table's rules are
   * independent — one rule being degraded doesn't mean they all are — so this drives per-row
   * status in the UI instead of a single aggregate color for the whole node.
   */
  routeRuleHealth?: Record<string, HealthStatus>;
  /**
   * Set on a `routes` node: each rule's own real, live-observed feeder Source node ids, keyed by
   * rule id — the same per-rule attribution used to set `observedSourceIds` on that rule's own
   * edges, just also preserved here at the rule-id level. Needed specifically for an edge/rule-row
   * hover (`FlowCanvas.tsx`'s `computeEndToEndHighlight`): the *edge* a specific rule's own
   * downstream hop uses can be shared/merged with a different rule (two rules referencing the same
   * Pipeline+Destination pair), so re-deriving scope from that merged edge would incorrectly pull
   * in the sibling rule's own sources too — this gives the precise, single-rule answer directly.
   *
   * A rule with no live traffic of its own but *proven*, from Route config alone, to be
   * structurally unreachable (it's listed after an enabled `final:true` rule that's guaranteed to
   * match everything remaining) gets a single-element array holding
   * `UNREACHABLE_SOURCE_SENTINEL` (`lib/topology.ts`) instead of a real source id — a value no
   * real Source node can ever have, so every reachability check against it correctly resolves to
   * "definitely nothing" rather than falling back to the normal "no data, stay permissive"
   * behavior an *actually* unobserved (but reachable) rule gets.
   */
  routeRuleSourceIds?: Record<string, string[]>;
  /**
   * Set on a `routes` node only when Cribl's own implicit "no rule claimed this event" fallback
   * is real for this table — no rule structurally guarantees full coverage (see
   * `buildFlowGraph`'s own `sawGuaranteedCatchAllRule` detection) and the group still has a real
   * "default" output configured. Rendered as "endRoute" — a real, dedicated row always last in the
   * Routes card's rule list, with a normal `routeId`-tagged edge to wherever the "default" output's
   * own `defaultId` actually points (or to the "default" output itself if `defaultId` is unset or
   * stale) — behaving exactly like a real rule for hover/highlight/connections, per explicit
   * direction, not a visually-special case.
   *
   * Deliberately a *separate* concept from Cribl's own literal pre-built "default" Route rule some
   * orgs ship with out of the box — that's just an ordinary entry in this node's own `raw.routes`
   * (a real rule, ordinarily `final:true` with no filter, which is exactly the shape
   * `sawGuaranteedCatchAllRule` recognizes and defers to — when it's present and enabled, this
   * field is `undefined`, since there's nothing left for the implicit fallback to catch).
   */
  endRoute?: { health: HealthStatus; destinationLabel: string; destinationId: string; postPipelineId?: string };
  /**
   * Persistent queue status — `source`/`destination`/`outputRouter` nodes only, and only set at
   * all when Cribl's own group-scoped status response actually includes a `pq` object for this
   * component (confirmed live: it's simply absent when PQ isn't enabled there, not present with a
   * "disabled" state) — `undefined` here means "not applicable," not "unknown." Read from the
   * cheap, already-fetched group-scoped status (no extra API call for this alone); richer
   * per-worker PQ detail for the drawer is a separate, on-demand fetch — see
   * `NodeDetailPanel.tsx`'s `useWorkerStatuses`.
   */
  pq?: PqStatus;
}

/** Cribl's own PQ health enum, confirmed against this project's `openapi.json`
 *  (`AggregatedPQStatus`) — deliberately a distinct type from `HealthStatus`, since a component's
 *  PQ can be unhealthy independently of the component's own overall health, and conflating the two
 *  would make one status silently overwrite the other's meaning. */
export interface PqStatus {
  health: 'Green' | 'Yellow' | 'Red' | 'Unknown';
  error?: string;
}

type EdgeKind = 'flow' | 'chain' | 'routerRule';

export interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: EdgeKind;
  health: HealthStatus;
  /** The currently-selected metric's numeric value for this edge; drives stroke thickness. */
  metricValue: number;
  /**
   * Route rule id(s) this edge carries traffic for (drives hover highlighting). More than one id
   * when several rules share the same downstream Pipeline+Destination pair — a real, common
   * shape, not an edge case: the Pipeline/Destination is a shared final segment, structurally
   * incapable of carrying a single rule's identity.
   */
  routeIds?: string[];
  /**
   * Source node ids actually observed feeding this edge, from live traffic — not a static
   * assumption. An unfiltered Route may carry events from several Sources; this is how we know
   * which ones, so the Signal Path draws the real fan-in rather than guessing 1:1.
   */
  observedSourceIds?: string[];
  disabled?: boolean;
}

export interface FlowGraph {
  workerGroupId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** One entry per observed Source -> Destination pair, for Flow Matrix and Flow Explorer. */
  flowSummaries: FlowSummary[];
  generatedAt: number;
}

/**
 * The four Live Capture checkpoints, matching Cribl's `CaptureLevel` exactly:
 * 0 = Before pre-processing Pipeline, 1 = Before Routes, 2 = Before post-processing Pipeline,
 * 3 = Before Destination.
 */
export type CaptureLevel = 0 | 1 | 2 | 3;

export const CAPTURE_LEVEL_LABEL: Record<CaptureLevel, string> = {
  0: 'Before Pre-Processing',
  1: 'Before Routes',
  2: 'Before Post-Processing',
  3: 'Before Destination',
};


export type ViewId = 'signalPath' | 'flowExplorer' | 'overview';

export const VIEW_LABEL: Record<ViewId, string> = {
  signalPath: 'Signal Path',
  flowExplorer: 'Flow Explorer',
  overview: 'Overview',
};

const DEFAULT_VIEW: ViewId = 'overview';

export const VIEW_PATH: Record<ViewId, string> = {
  signalPath: '/signal-path',
  flowExplorer: '/flow-explorer',
  overview: '/overview',
};

/** Shared between the sidebar's own nav item order and the Settings page's "Default view" list. */
export const VIEW_ORDER: ViewId[] = ['overview', 'signalPath', 'flowExplorer'];

export interface TimeRangeOption {
  id: '15m' | '1h' | '4h' | '12h' | '24h';
  label: string;
  ms: number;
}

export const TIME_RANGE_OPTIONS: TimeRangeOption[] = [
  { id: '15m', label: 'Last 15 minutes', ms: 15 * 60 * 1000 },
  { id: '1h', label: 'Last 1 hour', ms: 60 * 60 * 1000 },
  { id: '4h', label: 'Last 4 hours', ms: 4 * 60 * 60 * 1000 },
  { id: '12h', label: 'Last 12 hours', ms: 12 * 60 * 60 * 1000 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
];

/**
 * One contributing Route rule (or QuickConnect connection) within a `FlowSummary` — two or more
 * rules can legitimately share the same Source + Destination pair (e.g. one rule splits off
 * `sourcetype=='errors'` to Splunk while another sends everything else there too); `FlowSummary`
 * aggregates them into one row for Flow Matrix's cell math, but Flow Explorer wants to show each
 * contributing flow individually under that same aggregate, which is what this is for.
 */
export interface IndividualFlow {
  id: string;
  /** The Route rule's own configured name, or "QuickConnect" — never a bare rule id, which isn't
   *  meaningful to read on its own. */
  label: string;
  health: HealthStatus;
  inEvents: number;
  outEvents: number;
  inBytes: number;
  outBytes: number;
  routeId?: string;
  pipelineId?: string;
  /** Every pipeline `pipelineId` chains into via the Chain function, in order, NOT including
   *  `pipelineId` itself — empty/absent when there's no chain. Lets a chained flow's own expanded
   *  diagram (`resolveIndividualFlowSteps`) show every real hop, not just the first. */
  chainPipelineIds?: string[];
}

/**
 * One observed Source -> Destination path, for Flow Matrix and Flow Explorer. A flow can cross
 * more than one Route/Pipeline if pipeline chaining is involved; those ids are listed in order.
 */
export interface FlowSummary {
  id: string;
  sourceId: string;
  sourceLabel: string;
  destinationId: string;
  destinationLabel: string;
  workerGroupId: string;
  /**
   * Blocked = real input volume, zero output. Healthy = both input and output above zero,
   * regardless of how much smaller output is than input — Cribl reducing volume before it reaches
   * a destination (dropping/shortening events to save on destination license/storage cost) is
   * expected, intentional behavior, not degradation. No data = no observed input at all. There is
   * deliberately no "degraded" state for a flow (unlike a component's own `HealthStatus` elsewhere
   * in this app, which still uses one) — see `reduction` below for where volume-shrinkage is
   * actually surfaced instead of being folded into status.
   */
  health: HealthStatus;
  /** True when either real endpoint (Source or Destination) is disabled in Cribl's own config —
   *  drives the shared `'enabled'` status filter (`matchesStatusFilter`), independent of `health`. */
  disabled?: boolean;
  inEvents: number;
  outEvents: number;
  inBytes: number;
  outBytes: number;
  /** outEvents / inEvents in the currently selected unit, 0-1. */
  ratio: number;
  routeIds: string[];
  pipelineIds: string[];
  /** Set only when the Source's own config routes it through a pre-processing Pipeline first. */
  prePipelineId?: string;
  /** Set only when the Destination's own config runs events through a post-processing Pipeline. */
  postPipelineId?: string;
  /** Every Route rule (or QuickConnect connection) that contributes to this aggregate — see
   *  `IndividualFlow`'s own doc comment. Always at least one entry. */
  flows: IndividualFlow[];
  trend?: MetricPoint[];
  baseline?: {
    inEvents?: number;
    outEvents?: number;
  };
}

/**
 * The one status-filter pack every dashboard's top bar shows — originally Signal Path's own
 * config-only validation page, promoted app-wide once that page became the real Signal Path.
 * Deliberately its own type, not `HealthStatus` itself (`good`/`degraded`/`blocked`/`nodata`,
 * still used everywhere for actual status coloring): `'enabled'` is a config-level signal (is the
 * component turned on at all, independent of any traffic — see `matchesStatusFilter`'s own
 * `disabled` parameter), and `'unhealthy'` folds `blocked`+`degraded` into one bucket the same way
 * the older `'blocked'` filter value already did, just renamed to match this pack. `'active'`
 * means "any status except nodata" (good, degraded, or blocked all count as actively flowing).
 */
export type StatusFilter = 'all' | 'enabled' | 'active' | 'unhealthy' | 'nodata';

export interface SavedView {
  id: string;
  name: string;
  view: ViewId;
  workerGroupIds: string[];
  metric: VolumeUnit;
  timeRangeId: TimeRangeOption['id'];
  statusFilter?: StatusFilter;
  createdAt: number;
  updatedAt: number;
}

export interface AutoRefreshOption {
  id: '30s' | '1m' | '2m' | '3m' | '5m' | 'off';
  label: string;
  /** `undefined` for `'off'` — deliberately not `0` (which would read as "fire immediately and
   *  repeatedly" if a caller ever passed it straight to `setInterval` without its own explicit
   *  `'off'` guard). Every real call site already checks `autoRefreshId === 'off'` first and never
   *  reads `ms` in that case, but an unrepresentable "no interval" value is a second, structural
   *  safeguard against that guard ever being missed. */
  ms: number | undefined;
}

export const AUTO_REFRESH_OPTIONS: AutoRefreshOption[] = [
  { id: '30s', label: '30s', ms: 30 * 1000 },
  { id: '1m', label: '1m', ms: 60 * 1000 },
  { id: '2m', label: '2m', ms: 2 * 60 * 1000 },
  { id: '3m', label: '3m', ms: 3 * 60 * 1000 },
  { id: '5m', label: '5m', ms: 5 * 60 * 1000 },
  { id: 'off', label: 'Off', ms: undefined },
];

/** The sidebar's own default/starting state on load — not a live, in-session override (the
 *  Collapse-toggle button in the sidebar rail itself remains a session-only choice, exactly as it
 *  already was before this preference existed). `'collapsed'` (the default) and `'expanded'` pin
 *  the sidebar at that fixed state on every fresh load; `'hover'` starts collapsed but temporarily
 *  reveals labels while the pointer is over it, without changing the persisted starting state
 *  itself. Replaces the former plain `sidebarAutoExpandOnHover: boolean` — that flag only ever
 *  captured the third of these three states, with no way to express "start expanded" at all. */
export type SidebarMode = 'collapsed' | 'expanded' | 'hover';

/** Traffic-flow animation style for Signal Path's active (real-data), non-highlighted edges — a
 *  purely visual overlay on top of the plain flow-line color, never a substitute for it. `'none'`
 *  is a real, explicit off switch, not just "nothing selected." `'dots'`/`'comet'`/`'density'`
 *  move a small shape along the edge's own path via CSS `offset-path`; `'ants'`/`'ribbon'`/
 *  `'sweep'` animate `stroke-dashoffset` on a `pathLength={100}`-normalized copy of that same
 *  path, so the dash pattern reads consistently regardless of how visually long a given edge
 *  happens to be — see `components/FlowCanvas/FlowCanvas.tsx`'s `FlowAnimationOverlay` for the
 *  actual rendering. A real, persisted Settings preference (not page-local state) now that Signal
 *  Path is a real, permanent view rather than a standalone validation page. */
export type FlowAnimationStyle = 'none' | 'dots' | 'ants' | 'sweep' | 'comet' | 'ribbon' | 'density';

/** The fixed set of choices for "how many of the top Sources by volume to show" — the Top Sources
 *  filter (Signal Path/Flow Explorer top bars) narrows down to this many Sources, ranked by real
 *  volume within the selected time range. Kept a small, fixed set (rather than a free-typed number)
 *  matching this app's own established pattern for every other bounded numeric preference
 *  (`AUTO_REFRESH_OPTIONS`, `FLOW_ANIMATION_OPTIONS`). */
export const TOP_SOURCES_COUNT_OPTIONS: number[] = [5, 10, 15, 20, 25];

export const FLOW_ANIMATION_OPTIONS: { id: FlowAnimationStyle; label: string }[] = [
  { id: 'none', label: 'No animation' },
  { id: 'dots', label: 'Marching dots' },
  { id: 'ants', label: 'Marching ants' },
  { id: 'sweep', label: 'Gradient sweep' },
  { id: 'comet', label: 'Comet trail' },
  { id: 'ribbon', label: 'Flowing ribbon' },
  { id: 'density', label: 'Volume-weighted density' },
];

export interface UserPreferences {
  defaultView: ViewId;
  theme: 'light' | 'dark' | 'system';
  lastWorkerGroupId?: string;
  lastMetric: VolumeUnit;
  lastTimeRangeId: TimeRangeOption['id'];
  autoRefreshId: AutoRefreshOption['id'];
  sidebarMode: SidebarMode;
  flowAnimationStyle: FlowAnimationStyle;
  /** Worker Inventory's own mini-bar "warn" (amber) cutoffs, as a percent — the "danger" (red)
   *  cutoff stays a fixed 85 regardless (see `FleetRoster.tsx`'s own `UtilCell`), so these only
   *  ever tune how eager the amber band is, never what counts as red. Deliberately *not* wired
   *  into `deriveWorkerHealth()`/the Status column's own real color — that function was already
   *  changed once, on purpose, to stop deriving a worker's real status from made-up percentage
   *  thresholds like this one, specifically because it let the KPI count and the Status column
   *  disagree (see `lib/workerHealth.ts`'s own doc comment). This is a pure display preference for
   *  the mini-bar only, not a second, configurable copy of that same mistake.
   *
   *  Separately tunable per `GroupProductFilter` ("Stream"/"Edge" suffix on each field) — the
   *  Worker Inventory table is shared between both products (`FleetRoster.tsx`), and a Stream
   *  Worker's normal resource profile isn't necessarily the same as an Edge Node's, so one shared
   *  cutoff would either be too eager for one product or too lax for the other. */
  cpuPressureWarnPctStream?: number;
  cpuPressureWarnPctEdge?: number;
  memPressureWarnPctStream?: number;
  memPressureWarnPctEdge?: number;
  diskPressureWarnPctStream?: number;
  diskPressureWarnPctEdge?: number;
  /** How many Sources the Top Sources filter (Signal Path/Flow Explorer top bars) narrows down to
   *  when switched on — one of `TOP_SOURCES_COUNT_OPTIONS`. The filter's own on/off state is a
   *  session-only `AppState` field (`topSourcesEnabled`), matching `statusFilter`'s own "shared,
   *  live, not persisted" precedent — only *how many* is worth remembering across a reload. */
  topSourcesCount?: number;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  defaultView: DEFAULT_VIEW,
  // System, not a hardcoded 'dark' — per explicit direction for the fresh-start per-user defaults
  // (see AppState.tsx's own `userScopedKey` doc comment for the rest of that cutover). `lib/theme.
  // ts`'s `useApplyTheme` already handles 'system' by tracking the OS preference live, no separate
  // wiring needed here.
  theme: 'system',
  // Bytes, not Events — per explicit direction that every page's default metric should match
  // (`lastTimeRangeId` below was already '1h' everywhere; this was the one default that wasn't
  // actually consistent, since it silently meant "whichever unit was last used" would drift back
  // to Events for a first-time user on any page).
  lastMetric: 'bytes',
  lastTimeRangeId: '1h',
  // 2m, not 1m — per the same explicit direction as `theme` above.
  autoRefreshId: '2m',
  // Collapsed by default, per explicit direction — matches this app's own long-standing default
  // (the sidebar always started collapsed even before this was a real, persisted choice).
  sidebarMode: 'collapsed',
  // No animation by default — matches Signal Path's own established default from its validation-
  // page days.
  flowAnimationStyle: 'none',
  // Matches `UtilCell`'s own previous hardcoded values exactly — a user who never touches this
  // setting sees byte-for-byte the same mini-bar coloring as before this preference existed, for
  // both products (Stream and Edge started out sharing one implicit 70 cutoff too).
  cpuPressureWarnPctStream: 70,
  cpuPressureWarnPctEdge: 70,
  memPressureWarnPctStream: 70,
  memPressureWarnPctEdge: 70,
  diskPressureWarnPctStream: 70,
  diskPressureWarnPctEdge: 70,
  // Default to 10, per explicit direction.
  topSourcesCount: 10,
};
