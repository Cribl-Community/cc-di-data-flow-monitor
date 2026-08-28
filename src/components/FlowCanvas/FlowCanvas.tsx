import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search, CloseOutlined } from '@capra/icons';
import { computeLaneOrder } from '../../lib/layout';
import { END_ROUTE_ID } from '../../lib/topology';
import {
  LANES,
  visualLaneOf,
  type CaptureLevel,
  type FlowAnimationStyle,
  type FlowGraph,
  type GraphEdge,
  type GraphNode,
  type GroupProductFilter,
  type NodeKind,
  type StatusFilter,
} from '../../lib/types';
import { NodeCard, OP_STATUS_KINDS, type RuleLike } from './NodeCard';
import { CaptureIcon } from './CaptureIcon';
import { buildEdgePath, buildLoopbackEdgePath, leftAnchor, rightAnchor, type Rect } from './geometry';
import { type ComponentStats, type SignalPathMetrics } from '../../lib/topologyConfigOnlyMetrics';
import type { FunctionErrorLogEntry } from '../../api/logs';
import type { WorkerStatusRow } from '../../api/workers';
import { healthFromWorkerRows, workerRowsForNode } from '../../hooks/useWorkerStatus';
import './FlowCanvas.css';

/**
 * Signal Path's own canvas — the "chain-propagation" metrics model (`lib/topologyConfigOnlyMetrics.ts`)
 * source-attributes traffic at every stage, rather than deriving per-segment health from each
 * edge's own two endpoints. Real per-lane search, Capture checkpoints, per-worker op-status/
 * badges, per-edge "is real traffic currently flowing here" coloring (see `edgeSourceIds`), and
 * hover/select highlighting of a component's full attributed path (`hoveredSourceIds`/
 * `nodeHighlightState`/`edgeSourceIds`, driven by this page's own real per-source attribution
 * rather than a graph walk) are all real, data-driven behavior.
 */

const LANE_TITLE: Record<NodeKind, string> = {
  source: 'Sources',
  prePipeline: 'Pre-Processing',
  routes: 'Routes',
  pipeline: 'Pipelines',
  postPipeline: 'Post-Processing',
  destination: 'Destinations',
  outputRouter: 'Destinations',
};

const CLEAR_Y = 22;
const EDGE_WIDTH = 2;
const EDGE_WIDTH_DISABLED = 1.5;
const DETOUR_BUFFER = 16;

const DOT_ANIM_DURATION_S = 2.2;
const COMET_ANIM_DURATION_S = 1.8;

/** One edge's own moving overlay — rendered only for edges that are `active` (real traffic) and
 *  only while nothing on the canvas is hovered (see the render call below); reverts to the plain
 *  highlighted/dimmed look with zero animation the instant a hover starts anywhere, per explicit
 *  direction. `magnitude` (the edge's own real distinct-source count) only matters for `'density'`,
 *  where it sets how many dots travel the path at once — a real, if coarse, volume signal, since
 *  this page has no per-edge event-count metric of its own to draw a finer one from. */
function FlowAnimationOverlay({ path, magnitude, style }: { path: string; magnitude: number; style: FlowAnimationStyle }) {
  switch (style) {
    case 'ants':
      return <path d={path} pathLength={100} className="flow-anim-ants" aria-hidden="true" />;
    case 'ribbon':
      return <path d={path} pathLength={100} className="flow-anim-ribbon" aria-hidden="true" />;
    case 'sweep':
      return <path d={path} pathLength={100} className="flow-anim-sweep" aria-hidden="true" />;
    case 'comet':
      return (
        <circle
          r={4}
          className="flow-anim-comet"
          style={{ offsetPath: `path('${path}')`, animationDuration: `${COMET_ANIM_DURATION_S}s` }}
          aria-hidden="true"
        />
      );
    case 'dots':
    case 'density': {
      const dotCount = style === 'density' ? Math.min(4, Math.max(1, magnitude)) : 3;
      return (
        <>
          {Array.from({ length: dotCount }, (_, i) => (
            <circle
              key={i}
              r={style === 'density' ? 2.5 : 3}
              className="flow-anim-dot"
              style={{
                offsetPath: `path('${path}')`,
                animationDuration: `${DOT_ANIM_DURATION_S}s`,
                animationDelay: `${-(i * (DOT_ANIM_DURATION_S / dotCount))}s`,
              }}
              aria-hidden="true"
            />
          ))}
        </>
      );
    }
    case 'none':
    default:
      return null;
  }
}

function hasVolume(stats: ComponentStats | undefined): boolean {
  return (stats?.inEvents ?? 0) > 0 || (stats?.outEvents ?? 0) > 0;
}

/** Real per-card status filtering — `stats`/`workerRows` are the same data `NodeCard` itself
 *  already reads for its own headline numbers and op-status color, so a card that matches here is
 *  always consistent with what it visibly shows. Routes is exempt entirely at the call site below
 *  (it's a single table node with no card-level stats of its own — the same reasoning it's already
 *  exempt from the per-lane search). */
function matchesStatusFilter(
  node: GraphNode,
  stats: ComponentStats | undefined,
  workerRows: WorkerStatusRow[] | undefined,
  filter: StatusFilter,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'enabled':
      return !node.disabled;
    case 'active':
      // Real data flowing through this component in the selected timeframe — events actually
      // observed, not just "configured and enabled."
      return hasVolume(stats);
    case 'nodata':
      // Enabled (a user would expect traffic) but nothing real has been observed.
      return !node.disabled && !hasVolume(stats);
    case 'unhealthy': {
      // Only the three kinds with a real per-worker connector status even have a `HealthStatus` of
      // their own (see `OP_STATUS_KINDS`) — every other kind never matches this filter, since there's
      // no real signal to call it "blocked"/"degraded" from.
      if (!OP_STATUS_KINDS.has(node.kind)) return false;
      const health = healthFromWorkerRows(workerRows);
      return health === 'blocked' || health === 'degraded';
    }
  }
}

/** The real Source(s) a given component is attributable to — its own id, if it's a Source itself,
 *  else the `sourceNodeId`s from its own already-computed per-source attribution
 *  (`SignalPathMetrics.byNodeId`/`byRuleId`, the same data the Sources table and the capture default
 *  filter both already read). This is what the per-lane search filters below use to propagate a
 *  match across component *types* — a real cross-lane connection, not a label-text coincidence. */
function sourceIdsOfNode(node: GraphNode, metrics: SignalPathMetrics | undefined): Set<string> {
  if (node.kind === 'source') return new Set([node.id]);
  const sources = metrics?.byNodeId.get(node.id)?.sources ?? [];
  const result = new Set<string>();
  for (const s of sources) {
    // A normal row's own `sourceNodeId` already names the one real Source it's attributed to. An
    // Output Router "Multiple Sources" row (see `SourceShare.attributedSourceIds`'s own doc
    // comment) has no single real source of its own — its placeholder `sourceNodeId` would never
    // match anything real, so this unions in every one of the router's own genuine member sources
    // instead, letting the connecting line color correctly and a hover on any of them still
    // include this row's own destination, rather than reading as permanently unattributed.
    if (s.attributedSourceIds) for (const id of s.attributedSourceIds) result.add(id);
    else result.add(s.sourceNodeId);
  }
  return result;
}

function sourceIdsOfRule(ruleId: string, metrics: SignalPathMetrics | undefined): Set<string> {
  const sources = metrics?.byRuleId.get(ruleId)?.sources ?? [];
  return new Set(sources.map((s) => s.sourceNodeId));
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const id of a) if (b.has(id)) return true;
  return false;
}

/** `true` when `nodeSourceIds` overlaps *every* one of `activeSets` — the same "reachable from
 *  every currently-active lane filter at once" AND semantics the real Signal Path page's own
 *  cross-lane connectivity restriction uses, just computed from real per-source attribution here
 *  instead of a live edge walk. An empty `activeSets` (nothing filtered anywhere) always passes. */
function connectivityOk(nodeSourceIds: Set<string>, activeSets: Set<string>[]): boolean {
  return activeSets.every((set) => intersects(nodeSourceIds, set));
}

/** The real Source(s) actually flowing across this specific connection right now — not just "this
 *  wiring exists per config" (every edge's own previous, uniform treatment). Its own emptiness (no
 *  overlap at all) is what backs both the edge's own grey-vs.-highlighted-blue coloring
 *  (`active = edgeSourceIds(...).size > 0`, at the render call below) and the end-to-end hover
 *  highlight (an edge only lights up on hover when the hovered source is actually a member of this
 *  same set).
 *
 *  `buildConfigOnlyGraph` (`lib/topologyConfigOnly.ts`) never merges edges — two Route rules
 *  sharing the same downstream Pipeline/Destination each get their own distinct edge object, one
 *  per rule, even though they render converging on the same node. So whenever an edge carries a
 *  real `routeIds` (Routes -> Pipeline, Pipeline -> Post-Processing/Destination, Post-Processing ->
 *  Destination), its own attribution is exactly those specific rule(s)' own real sources
 *  (`sourceIdsOfRule`) — *not* the downstream node's own blanket aggregate, which would incorrectly
 *  credit every sibling rule sharing that same node, including one with zero real attribution of
 *  its own (e.g. a `default` catch-all rule sharing a Pipeline with a real, FINAL-claimed rule).
 *
 *  Only an edge with no rule identity of its own (Source -> Pre-Processing, Pre-Processing/Source
 *  -> Routes, Chain, Output Router -> its real targets) falls back to comparing both endpoints' own
 *  real attribution directly. Routes itself never gets a `byNodeId` entry (a pure dispatch
 *  decision, not a measured stage), so a `-> Routes` edge instead checks whether its own *origin*
 *  has real observed volume — resolved via `sourceIdsOfNode`, not the origin's raw node id, so a
 *  Pre-Processing Pipeline origin correctly resolves through to the real Source(s) actually feeding
 *  it rather than its own (non-Source-shaped) id, which could never match anything. */
function edgeSourceIds(edge: GraphEdge, fromNode: GraphNode, toNode: GraphNode, metrics: SignalPathMetrics | undefined): Set<string> {
  if (edge.routeIds && edge.routeIds.length > 0) {
    const result = new Set<string>();
    for (const ruleId of edge.routeIds) for (const id of sourceIdsOfRule(ruleId, metrics)) result.add(id);
    return result;
  }
  if (toNode.kind === 'routes') return hasVolume(metrics?.byNodeId.get(fromNode.id)) ? sourceIdsOfNode(fromNode, metrics) : new Set();
  const fromIds = sourceIdsOfNode(fromNode, metrics);
  const toIds = sourceIdsOfNode(toNode, metrics);
  const result = new Set<string>();
  for (const id of fromIds) if (toIds.has(id)) result.add(id);
  return result;
}

/** End-to-end hover highlight — `'none'` when nothing's hovered anywhere, `'highlighted'` when
 *  this node shares a real attributed Source with whatever's currently hovered, `'dimmed'`
 *  otherwise. Routes has no card-level attribution of its own (same reasoning as `edgeSourceIds`),
 *  so it's treated as always "on the path" for any active hover — it's the one shared hub every
 *  real, routed flow passes through — rather than dimmed for lack of its own direct signal. */
function nodeHighlightState(node: GraphNode, hoveredSourceIds: Set<string> | undefined, metrics: SignalPathMetrics | undefined): 'none' | 'highlighted' | 'dimmed' {
  if (!hoveredSourceIds) return 'none';
  if (node.kind === 'routes') return hoveredSourceIds.size > 0 ? 'highlighted' : 'none';
  return intersects(sourceIdsOfNode(node, metrics), hoveredSourceIds) ? 'highlighted' : 'dimmed';
}

export interface SignalPathCaptureContext {
  level: CaptureLevel;
  label: string;
  groupId: string;
  /** The real node this checkpoint sits at — lets the page look up that node's own per-source
   *  attribution (`SignalPathMetrics.byNodeId`) to pre-fill the capture filter. */
  nodeId: string;
  kind: NodeKind;
}

interface LaneControlState {
  search: string;
}
const DEFAULT_LANE_CONTROL: LaneControlState = { search: '' };

export interface FlowCanvasProps {
  graph: FlowGraph;
  statusFilter: StatusFilter;
  onSelectNode: (node: GraphNode) => void;
  onSelectRule: (rule: RuleLike) => void;
  onCapture: (context: SignalPathCaptureContext) => void;
  metrics: SignalPathMetrics | undefined;
  /** Pipeline-role node id -> real per-function error log entries — see `useFunctionErrors`. */
  functionErrorsByNodeId?: Map<string, FunctionErrorLogEntry[]>;
  /** Source/Destination node id -> real per-worker connector status — see `useWorkerStatus`.
   *  Resolved per-node (Output Router rolled up from its real targets) via `workerRowsForNode`
   *  before being handed to each `NodeCard`. */
  workerStatusByNodeId?: Map<string, WorkerStatusRow[]>;
  /** Traffic-flow animation style for active (real-data), non-highlighted edges — a purely visual
   *  overlay on top of the plain `edge-line--config` blue, never a substitute for it. A real,
   *  persisted Settings preference (`lib/types.ts`'s `FlowAnimationStyle`/`FLOW_ANIMATION_OPTIONS`).
   *  `'none'` is a real, explicit off switch, not just "nothing selected." Every other value is one
   *  of the six concepts proven out in the standalone animation mockup: `'dots'`/`'comet'`/
   *  `'density'` move a small shape along the edge's own path via CSS `offset-path` (the exact same
   *  `d` string the edge itself already renders, so they're always pixel-aligned to it);
   *  `'ants'`/`'ribbon'`/`'sweep'` animate `stroke-dashoffset` on a `pathLength={100}`-normalized
   *  copy of that same path, so the dash pattern reads consistently regardless of how visually long
   *  a given edge happens to be. */
  flowAnimationStyle: FlowAnimationStyle;
  /** Real display name for every group a cross-deployment chain hop (`node.chainsToGroupId` — see
   *  `lib/crossDeploymentChain.ts`) might resolve to, scoped to whatever the top bar's own picker
   *  can actually select. A node whose `chainsToGroupId` has no entry here renders as a plain
   *  Destination, not a broken link. */
  groupNameById?: Map<string, string>;
  /** Real `GroupProductFilter` ('stream'/'edge') per real, unscoped Worker Group id — resolved by
   *  `SignalPathPage.tsx` from `state.workerGroups`, looked up per node via its own
   *  `workerGroupId` and passed to each `NodeCard` so its own worker-alert badge/table say
   *  "Worker"/"Node" correctly regardless of which product a given node actually belongs to (this
   *  matters most under "All Worker Groups," where Stream and Edge nodes can render side by side
   *  on the same canvas at once). A group id absent from this map (shouldn't normally happen)
   *  falls back to `'stream'`, this app's own prior always-"Worker" behavior. */
  groupProductById?: Map<string, GroupProductFilter>;
  /** Pivots the top bar's Worker Group selection to the given group id — only ever called for a
   *  `chainsToGroupId` that resolved a real name in `groupNameById` above. */
  onChainClick?: (groupId: string) => void;
  /** Fired on every change to any lane's own free-text search box — the page wires this to a
   *  debounced background refresh, so a text filter always reflects fresh data shortly after
   *  typing stops rather than whatever was loaded when the page first opened. */
  onFilterChange?: () => void;
  /** The Top Sources filter's own on/off state (`state.topSourcesEnabled`, `PageHeader.tsx`) — when
   *  on, every lane (Sources included) narrows to just the top `topSourcesCount` real Sources by
   *  volume in the selected time range, plus everything those Sources actually reach, via the same
   *  real per-source attribution (`sourceIdsOfNode`/`connectivityOk`) the per-lane search filters
   *  already use — not a second, separate filtering mechanism. */
  topSourcesEnabled?: boolean;
  /** How many Sources the filter above narrows down to when on — `state.topSourcesCount`. */
  topSourcesCount?: number;
}

export function FlowCanvas({
  graph,
  statusFilter,
  onSelectNode,
  onSelectRule,
  onCapture,
  metrics,
  functionErrorsByNodeId,
  workerStatusByNodeId,
  flowAnimationStyle,
  groupNameById,
  groupProductById,
  onChainClick,
  onFilterChange,
  topSourcesEnabled = false,
  topSourcesCount = 10,
}: FlowCanvasProps) {
  const lanes = useMemo(() => computeLaneOrder(graph), [graph]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const laneIndexOf = useMemo(() => {
    const m = new Map<NodeKind, number>();
    LANES.forEach((lane, i) => m.set(lane, i));
    return m;
  }, []);

  // Per-lane free-text search — each lane's box narrows *that* lane's own nodes by label (or, for
  // Routes, its own rule names) exactly as before, but now also propagates cross-lane: a match in
  // one lane restricts every *other* lane to whatever's actually connected to it via real
  // per-source attribution (`activeLaneSourceSets` below) — the same "filter one type, narrow the
  // related ones too" behavior the real Signal Path page's own `computeConnectivityRestriction`
  // provides, computed here from this page's own already-real per-source attribution data
  // (`SignalPathMetrics.byNodeId`/`byRuleId`) instead of a live edge/reachability walk.
  const [laneControls, setLaneControls] = useState<Partial<Record<NodeKind, LaneControlState>>>({});

  // One real-source-id set per lane that currently has an active text query — a node/rule anywhere
  // in the graph stays visible only if its own attributed sources overlap *every* one of these sets
  // (see `connectivityOk`), the same AND-across-simultaneous-filters semantics the real page uses.
  // Routes is excluded as a *contributor* here (its own lane has no card-level attribution of its
  // own to seed from — matched rule ids are handled separately, see the render loop below), but its
  // rule rows are still narrowed *by* other lanes' restrictions, same as every other component.
  const activeLaneSourceSets = useMemo(() => {
    const entries: { lane: NodeKind; ids: Set<string> }[] = [];
    for (const { lane, nodes: laneNodes } of lanes) {
      if (lane === 'routes') continue;
      const q = (laneControls[lane]?.search ?? '').trim().toLowerCase();
      if (!q) continue;
      const matched = new Set<string>();
      for (const n of laneNodes) {
        if (n.label.toLowerCase().includes(q)) {
          for (const sid of sourceIdsOfNode(n, metrics)) matched.add(sid);
        }
      }
      if (matched.size > 0) entries.push({ lane, ids: matched });
    }
    return entries;
  }, [lanes, laneControls, metrics]);

  // "Top N Active" filter — the real ids of the top `topSourcesCount` *active* Source nodes by
  // volume (the larger of each Source's own `inEvents`/`outEvents`, since a Source's own real
  // traffic can show up on either side of `ComponentStats` depending on how it's wired — see
  // `cardValue` in `NodeCard.tsx`). Ranked only among Sources with real, non-zero volume
  // (`hasVolume`) — a Source with no observed traffic never fills a slot just because fewer than
  // `topSourcesCount` real Sources exist, so a genuinely quiet graph can show fewer than N, never
  // padded out with idle ones. `undefined` when the filter is off, meaning "no restriction"
  // everywhere it's consulted below — same convention `activeLaneSourceSets`'s own per-lane
  // entries use. Mutually exclusive with the status filter (see `PageHeader.tsx`/`AppState.tsx`),
  // so every lane's own status-filter predicate is bypassed (`effectiveStatusFilter` below) while
  // this is on — the only restriction while it's active is this real top-N-active set itself.
  // Routes is exempt from it entirely, same as it's already exempt from every real status filter
  // value — see `routesOtherSets` in the render loop below, which deliberately never includes this.
  const topSourceIds = useMemo(() => {
    if (!topSourcesEnabled) return undefined;
    const sourceNodes = graph.nodes.filter((n) => n.kind === 'source');
    const ranked = sourceNodes
      .map((n) => {
        const stats = metrics?.byNodeId.get(n.id);
        return { id: n.id, volume: Math.max(stats?.inEvents ?? 0, stats?.outEvents ?? 0) };
      })
      .filter((r) => r.volume > 0)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, topSourcesCount);
    return new Set(ranked.map((r) => r.id));
  }, [graph.nodes, metrics, topSourcesEnabled, topSourcesCount]);

  // While "Top N Active" is on, it fully replaces the ordinary status filter rather than combining
  // with it (mutual exclusivity — see the doc comment above) — every lane's own per-node status
  // check below reads this instead of the raw `statusFilter` prop directly.
  const effectiveStatusFilter: StatusFilter = topSourcesEnabled ? 'all' : statusFilter;

  // End-to-end hover highlight — real per-source attribution, not a live graph walk (this page has
  // no edge-level reachability model of its own). `hoveredSourceIds` is the specific Source(s)
  // attributable to whatever's currently hovered — a node, or one specific Route rule row — and
  // every card/edge below renders 'highlighted'/'dimmed' by checking its own attribution against
  // it (see `nodeHighlightState`/`edgeSourceIds`). `undefined` means nothing's hovered anywhere.
  const [hoveredKey, setHoveredKey] = useState<{ kind: 'node' | 'rule'; id: string } | undefined>(undefined);
  const hoveredSourceIds = useMemo(() => {
    if (!hoveredKey) return undefined;
    if (hoveredKey.kind === 'rule') return sourceIdsOfRule(hoveredKey.id, metrics);
    const node = nodeById.get(hoveredKey.id);
    // Routes' own card has no card-level attribution to hover *from* (only its individual rule
    // rows do, the `'rule'` branch above) — hovering the card itself is a no-op, not "highlight
    // everything," which would just read as broken.
    if (!node || node.kind === 'routes') return undefined;
    return sourceIdsOfNode(node, metrics);
  }, [hoveredKey, nodeById, metrics]);

  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const laneRefs = useRef(new Map<NodeKind, HTMLDivElement>());
  const [rects, setRects] = useState<{ nodes: Map<string, Rect>; lanes: Map<NodeKind, Rect>; ruleRows: Map<string, Rect> }>({
    nodes: new Map(),
    lanes: new Map(),
    ruleRows: new Map(),
  });

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const toRect = (el: HTMLElement): Rect => {
      const r = el.getBoundingClientRect();
      return { x: r.left - containerRect.left + container.scrollLeft, y: r.top - containerRect.top + container.scrollTop, width: r.width, height: r.height };
    };
    const nodeRects = new Map<string, Rect>();
    nodeRefs.current.forEach((el, id) => nodeRects.set(id, toRect(el)));
    const laneRects = new Map<NodeKind, Rect>();
    laneRefs.current.forEach((el, lane) => laneRects.set(lane, toRect(el)));
    const ruleRowRects = new Map<string, Rect>();
    container.querySelectorAll<HTMLElement>('[data-rule-row-id]').forEach((el) => {
      const id = el.getAttribute('data-rule-row-id');
      if (id) ruleRowRects.set(id, toRect(el));
    });
    setRects({ nodes: nodeRects, lanes: laneRects, ruleRows: ruleRowRects });
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    measure();
    const observer = new ResizeObserver(() => measure());
    observer.observe(container);
    nodeRefs.current.forEach((el) => observer.observe(el));
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, lanes]);

  // Filtering (the status filter or a lane's own search) changes which nodes/rows are actually in
  // the DOM without changing `graph`/`lanes`, so the effect above never notices — re-measure
  // synchronously right after, same reasoning as the real FlowCanvas's own equivalent second effect.
  //
  // `metrics`/`workerStatusByNodeId` are also real inputs to which nodes end up in the DOM, not
  // just `statusFilter`/`laneControls` themselves: `matchesStatusFilter`'s 'active'/'nodata'
  // cases read `hasVolume(stats)` (from `metrics`) and its 'unhealthy' case reads
  // `healthFromWorkerRows(workerRows)` (from `workerStatusByNodeId`), and the per-lane search's own
  // cross-lane attribution (`sourceIdsOfNode`) reads `metrics` too. Both resolve asynchronously,
  // independently of the graph itself and well after this component's first mount — a real,
  // confirmed bug (not just filter interactions) was every edge silently vanishing once metrics
  // loaded in with the default "Active" filter already selected: the DOM gained newly-qualifying
  // nodes, but neither this effect nor the one above ever re-ran to notice, so `rects` stayed at
  // its stale, metrics-still-loading snapshot and every edge's own `!fromRect || !toRect` check
  // dropped it. Toggling the status filter afterward "fixed" it only by accident, by finally
  // giving this effect a dependency it actually tracked to fire on.
  useLayoutEffect(() => {
    measure();
  }, [measure, effectiveStatusFilter, laneControls, metrics, workerStatusByNodeId, topSourcesEnabled, topSourcesCount]);

  // --- Edges — same detour/gap-finding geometry as the real canvas (copied verbatim, since it's
  //     pure obstacle-avoidance math with no dependency on health/hover), stripped only of the
  //     highlight/dim class computation at the very end. ---
  const edgeElements = useMemo(() => {
    const elements: {
      key: string;
      path: string;
      strokeWidth: number;
      className: string;
      fromId: string;
      toId: string;
      active: boolean;
      magnitude: number;
    }[] = [];
    let detourFanIndex = 0;

    const allLaneTops = [...rects.lanes.values()].map((r) => r.y);
    const topClearY = allLaneTops.length ? Math.min(...allLaneTops) - 30 : CLEAR_Y;

    function bottomClearYFor(lane: NodeKind): number {
      const laneNodeBottoms = graph.nodes
        .filter((n) => n.kind === lane)
        .map((n) => rects.nodes.get(n.id))
        .filter((r): r is Rect => r !== undefined)
        .map((r) => r.y + r.height);
      if (laneNodeBottoms.length > 0) return Math.max(...laneNodeBottoms) + 24;
      const laneRect = rects.lanes.get(lane);
      return laneRect ? laneRect.y + 40 : topClearY;
    }
    const prePipelineBottomClearY = bottomClearYFor('prePipeline');
    const postPipelineBottomClearY = bottomClearYFor('postPipeline');

    const GAP_MIN_HEIGHT = 24;
    const GAP_PADDING = 8;
    function gapClearYFor(laneKinds: readonly NodeKind[], targetY: number, excludeIds?: ReadonlySet<string>): number {
      const obstacles = graph.nodes
        .filter((n) => laneKinds.includes(n.kind) && !excludeIds?.has(n.id))
        .map((n) => rects.nodes.get(n.id))
        .filter((r): r is Rect => r !== undefined)
        .sort((a, b) => a.y - b.y);
      if (obstacles.length === 0) return Math.max(...laneKinds.map(bottomClearYFor));

      const bands: { top: number; bottom: number }[] = [];
      for (const r of obstacles) {
        const top = r.y;
        const bottom = r.y + r.height;
        const last = bands[bands.length - 1];
        if (last && top <= last.bottom + GAP_PADDING) last.bottom = Math.max(last.bottom, bottom);
        else bands.push({ top, bottom });
      }

      const candidates: number[] = [];
      for (let i = 0; i < bands.length - 1; i++) {
        const gapTop = bands[i].bottom;
        const gapBottom = bands[i + 1].top;
        if (gapBottom - gapTop >= GAP_MIN_HEIGHT) candidates.push((gapTop + gapBottom) / 2);
      }
      candidates.push(bands[bands.length - 1].bottom + GAP_PADDING * 1.5);
      if (candidates.length === 0) return Math.max(...laneKinds.map(bottomClearYFor));

      return candidates.reduce((best, c) => (Math.abs(c - targetY) < Math.abs(best - targetY) ? c : best));
    }

    for (const edge of graph.edges) {
      const fromNode = nodeById.get(edge.fromId);
      const toNode = nodeById.get(edge.toId);
      const fromRect = rects.nodes.get(edge.fromId);
      const toRect = rects.nodes.get(edge.toId);
      if (!fromNode || !toNode || !fromRect || !toRect) continue;

      const fromLane = laneIndexOf.get(visualLaneOf(fromNode.kind)) ?? 0;
      const toLane = laneIndexOf.get(visualLaneOf(toNode.kind)) ?? 0;

      const fromRuleRowRect = fromNode.kind === 'routes' ? rects.ruleRows.get(edge.routeIds?.[0] ?? '') : undefined;
      const from = fromRuleRowRect
        ? { x: fromRect.x + fromRect.width, y: fromRuleRowRect.y + fromRuleRowRect.height / 2 }
        : rightAnchor(fromRect);
      const to = toNode.kind === 'routes' ? { x: toRect.x, y: toRect.y + Math.min(18, toRect.height / 2) } : leftAnchor(toRect);

      let path: string;
      const isSameLaneLoopback = (edge.kind === 'chain' || edge.kind === 'routerRule') && fromLane === toLane;
      if (isSameLaneLoopback) {
        const laneKind = visualLaneOf(fromNode.kind);
        const spanTop = Math.min(from.y, to.y);
        const spanBottom = Math.max(from.y, to.y);
        const hasRealObstacle = graph.nodes.some((n) => {
          if (n.kind !== laneKind || n.id === fromNode.id || n.id === toNode.id) return false;
          const r = rects.nodes.get(n.id);
          return r !== undefined && r.y <= spanBottom && r.y + r.height >= spanTop;
        });
        const clearY = hasRealObstacle ? gapClearYFor([laneKind], (from.y + to.y) / 2, new Set([fromNode.id])) : (from.y + to.y) / 2;
        path = buildLoopbackEdgePath(from, to, clearY);
      } else {
        let detour;
        if (toLane - fromLane >= 2) {
          const spanTop = Math.min(from.y, to.y);
          const spanBottom = Math.max(from.y, to.y);
          const skippedLaneKinds = LANES.slice(fromLane + 1, toLane);
          const hasRealObstacle = graph.nodes.some((n) => {
            if (!skippedLaneKinds.includes(n.kind)) return false;
            const r = rects.nodes.get(n.id);
            return r !== undefined && r.y <= spanBottom && r.y + r.height >= spanTop;
          });
          if (hasRealObstacle) {
            const skippedStart = rects.lanes.get(LANES[fromLane + 1]);
            const skippedEnd = rects.lanes.get(LANES[toLane - 1]);
            const isSourceToRoutes = fromNode.kind === 'source' && toNode.kind === 'routes';
            const isPipelineToDestination = fromNode.kind === 'pipeline' && toLane === laneIndexOf.get('destination');
            // Every other multi-lane skip — Routes' own endRoute fallthrough, or (the real bug
            // this covers) a QuickConnect Source wired straight to a Destination with no Pipeline
            // configured, skipping all four middle lanes at once — searches for a real gap among
            // whichever lanes it actually skips, the same way endRoute's detour always has,
            // instead of falling back to `topClearY` (routing above the entire canvas). That
            // fallback only ever made sense as a last resort for the two common, single-lane-skip
            // cases above; for a wider skip with real content on either side of it, it produced
            // exactly the "lines come in from above the diagram" bug this replaces — confirmed via
            // a real Edge Fleet's own QuickConnect topology, where this shape is common.
            const usesGapSearch = !isSourceToRoutes && !isPipelineToDestination;
            const belowClearY = isSourceToRoutes
              ? prePipelineBottomClearY
              : isPipelineToDestination
                ? postPipelineBottomClearY
                : gapClearYFor(skippedLaneKinds, (from.y + to.y) / 2);
            if (skippedStart && skippedEnd) {
              const fanOffset = usesGapSearch ? 0 : (detourFanIndex % 5) * 4;
              detour = {
                obstacleLeft: skippedStart.x,
                obstacleRight: skippedEnd.x + skippedEnd.width,
                clearY: belowClearY + fanOffset,
              };
              detourFanIndex++;
            }
          }
        }
        path = buildEdgePath(from, to, detour);
      }

      const edgeIds = edgeSourceIds(edge, fromNode, toNode, metrics);
      const active = edgeIds.size > 0;
      // `edge-line--active`/`edge-line--dimmed` are the real, shared hover-highlight classes
      // (`FlowCanvas.css`) — reused here for the identical purpose the real Signal Path canvas
      // already uses them for, just driven by real source-attribution overlap instead of a graph
      // walk. `undefined` (nothing hovered anywhere) adds neither, leaving every edge at its own
      // plain active/inactive color with no highlight/dim on top.
      const hoverClass = hoveredSourceIds ? (intersects(edgeIds, hoveredSourceIds) ? 'edge-line--active' : 'edge-line--dimmed') : undefined;
      elements.push({
        key: edge.id,
        path,
        strokeWidth: edge.disabled ? EDGE_WIDTH_DISABLED : EDGE_WIDTH,
        // Real events flowing across this specific connection (`edge-line--config`, the same accent
        // blue this app has always used) vs. wired per config but nothing currently observed
        // (`edge-line--default`, an existing shared neutral-grey class — see `edgeSourceIds`'s own
        // doc comment for exactly what "flowing" means per edge shape).
        className: ['edge-line', active ? 'edge-line--config' : 'edge-line--default', edge.disabled && 'edge-line--disabled', hoverClass]
          .filter(Boolean)
          .join(' '),
        fromId: edge.fromId,
        toId: edge.toId,
        active,
        magnitude: edgeIds.size,
      });
    }
    return elements;
  }, [graph, rects, nodeById, laneIndexOf, metrics, hoveredSourceIds]);

  // --- Capture icons — same 4 checkpoints as the real page (Before Pre-Processing / Before Routes
  //     / Before Post-Processing / Before Destination), positioned the same way. Each icon carries
  //     its own real `nodeId`/`kind` so the page can build a default filter from that node's own
  //     already-computed per-source attribution (`SignalPathMetrics.byNodeId`) — no graph walk needed,
  //     unlike the real page's own `upstreamSourceInputKeys`, since this page's metrics module already
  //     computes genuine per-source attribution for every node directly. ---
  const captureIcons = useMemo(() => {
    const icons: { key: string; x: number; y: number; level: CaptureLevel; label: string; groupId: string; nodeId: string; kind: NodeKind }[] = [];
    const hasOutgoing = new Set(graph.edges.map((e) => e.fromId));
    const hasIncoming = new Set(graph.edges.map((e) => e.toId));
    for (const node of graph.nodes) {
      const rect = rects.nodes.get(node.id);
      if (!rect) continue;
      const groupId = node.workerGroupId;
      if (node.kind === 'source' && hasOutgoing.has(node.id)) {
        icons.push({
          key: `cap0:${node.id}`,
          x: rect.x + rect.width + DETOUR_BUFFER,
          y: rect.y + rect.height / 2,
          level: 0,
          label: node.label,
          groupId,
          nodeId: node.id,
          kind: node.kind,
        });
      }
      if (node.kind === 'routes' && hasIncoming.has(node.id)) {
        icons.push({
          key: `cap1:${node.id}`,
          x: rect.x - DETOUR_BUFFER,
          y: rect.y + Math.min(18, rect.height / 2),
          level: 1,
          label: node.label,
          groupId,
          nodeId: node.id,
          kind: node.kind,
        });
      }
      if (node.kind === 'pipeline' && hasOutgoing.has(node.id)) {
        icons.push({
          key: `cap2:${node.id}`,
          x: rect.x + rect.width + DETOUR_BUFFER,
          y: rect.y + rect.height / 2,
          level: 2,
          label: node.label,
          groupId,
          nodeId: node.id,
          kind: node.kind,
        });
      }
      if ((node.kind === 'destination' || node.kind === 'outputRouter') && hasIncoming.has(node.id)) {
        icons.push({
          key: `cap3:${node.id}`,
          x: rect.x - DETOUR_BUFFER,
          y: rect.y + rect.height / 2,
          level: 3,
          label: node.label,
          groupId,
          nodeId: node.id,
          kind: node.kind,
        });
      }
    }
    return icons;
  }, [graph, rects]);

  const canvasHeight = Math.max(400, ...[...rects.nodes.values()].map((r) => r.y + r.height + 40));

  return (
    <div className="flow-canvas" ref={containerRef}>
      <svg className="flow-canvas-edges" style={{ height: canvasHeight }}>
        {edgeElements.map((e) => (
          <path key={e.key} data-edge-id={e.key} d={e.path} className={e.className} strokeWidth={e.strokeWidth} />
        ))}
        {/* Traffic-flow animation — active edges only, and only while nothing on the canvas is
            hovered (a hover already has its own, more precise highlighted/dimmed treatment; layering
            a moving overlay on top of that would fight it rather than help). */}
        {flowAnimationStyle !== 'none' &&
          hoveredSourceIds === undefined &&
          edgeElements
            .filter((e) => e.active)
            .map((e) => <FlowAnimationOverlay key={`anim:${e.key}`} path={e.path} magnitude={e.magnitude} style={flowAnimationStyle} />)}
      </svg>

      <div className="flow-canvas-lanes" style={{ minHeight: canvasHeight }}>
        {lanes.map(({ lane, nodes: laneNodes }) => {
          const control = laneControls[lane] ?? DEFAULT_LANE_CONTROL;
          const query = control.search.trim().toLowerCase();
          // Routes is a single node (the table itself) — its own search narrows the *rule rows*
          // inside it (below), not the lane's node list, and it has no card-level `stats`/health of
          // its own for the filter to evaluate, so it's exempt from both here, same as before.
          const statusFiltered =
            lane === 'routes'
              ? laneNodes
              : laneNodes.filter((n) =>
                  matchesStatusFilter(
                    n,
                    metrics?.byNodeId.get(n.id),
                    workerStatusByNodeId ? workerRowsForNode(n, workerStatusByNodeId) : undefined,
                    effectiveStatusFilter,
                  ),
                );
          const textFiltered =
            lane === 'routes' || query === '' ? statusFiltered : statusFiltered.filter((n) => n.label.toLowerCase().includes(query));
          // Cross-lane connectivity — narrows to whatever's actually attributable to every *other*
          // active lane's own matches (this lane's own set is excluded so a node that already
          // matched its own lane's text query is never accidentally hidden by its own contribution,
          // e.g. a real-but-zero-attribution node that still matched by name). "Top N Active",
          // unlike a per-lane search, applies to *every non-Routes* lane including Sources itself —
          // it's a global "only these Sources exist" restriction, not one specific lane's own query
          // that every other lane narrows against — so it's appended unconditionally here rather
          // than excluded for its own lane the way `activeLaneSourceSets` entries are. Routes is the
          // one deliberate exception, same as it already is for the ordinary status filter — see
          // `routesOtherSets` below, which never includes `topSourceIds`.
          const otherLaneSourceSets = [...activeLaneSourceSets.filter((e) => e.lane !== lane).map((e) => e.ids), ...(topSourceIds ? [topSourceIds] : [])];
          const nodes =
            lane === 'routes'
              ? textFiltered
              : textFiltered.filter((n) => connectivityOk(sourceIdsOfNode(n, metrics), otherLaneSourceSets));
          const setControl = (patch: Partial<LaneControlState>) => {
            setLaneControls((prev) => ({ ...prev, [lane]: { ...(prev[lane] ?? DEFAULT_LANE_CONTROL), ...patch } }));
            onFilterChange?.();
          };

          const routeTable = lane === 'routes' ? (nodes[0]?.raw as { routes: RuleLike[] } | undefined) : undefined;
          const totalRuleCount = nodes[0]?.ruleCount ?? 0;
          const routesNode = lane === 'routes' ? nodes[0] : undefined;
          // "Top N Active" deliberately excluded here, unlike `otherLaneSourceSets` above — Routes
          // is already exempt from the ordinary status filter entirely (`statusFiltered` above
          // never runs `matchesStatusFilter` for this lane), and per explicit direction "Top
          // N Active" should behave the same way: it narrows every other lane, but never touches
          // the Routes card or its own rule rows. Lane *search* still narrows the rule rows, same
          // as before — only this one specific filter is exempted.
          const routesOtherSets = lane === 'routes' ? activeLaneSourceSets.map((e) => e.ids) : [];
          const textMatchedRuleIds: Set<string> | undefined =
            lane === 'routes' && query !== '' && routeTable
              ? new Set([
                  ...routeTable.routes.filter((r) => r.name.toLowerCase().includes(query)).map((r) => r.id),
                  ...(routesNode?.endRoute && 'endroute'.includes(query) ? [END_ROUTE_ID] : []),
                ])
              : undefined;
          // A rule row stays visible only if it matches this lane's own text query (when one is
          // active) *and* its own real attribution overlaps every other active lane's restriction.
          // `END_ROUTE_ID` never has a `byRuleId` entry of its own (no live attribution exists for
          // "unrouted" events) — treated permissively, same "don't hide when genuinely unknown"
          // reasoning already established for it elsewhere, rather than hidden as if it had none.
          const visibleRuleIds: Set<string> | undefined =
            lane === 'routes' && (textMatchedRuleIds !== undefined || routesOtherSets.length > 0) && routeTable
              ? new Set(
                  [...routeTable.routes.map((r) => r.id), ...(routesNode?.endRoute ? [END_ROUTE_ID] : [])].filter((id) => {
                    if (textMatchedRuleIds && !textMatchedRuleIds.has(id)) return false;
                    if (id === END_ROUTE_ID) return true;
                    return connectivityOk(sourceIdsOfRule(id, metrics), routesOtherSets);
                  }),
                )
              : undefined;
          const visibleRuleCount = visibleRuleIds ? routeTable!.routes.filter((r) => visibleRuleIds.has(r.id)).length : totalRuleCount;

          // Route rule rows' own end-to-end hover highlight — same real-attribution overlap check
          // every card/edge already uses, just keyed per rule instead of per node (a rule row has
          // no `GraphNode` of its own to run `nodeHighlightState` against).
          const ruleHighlightStates: Map<string, 'highlighted' | 'dimmed'> | undefined =
            lane === 'routes' && hoveredSourceIds && routeTable
              ? new Map(routeTable.routes.map((r) => [r.id, intersects(sourceIdsOfRule(r.id, metrics), hoveredSourceIds) ? 'highlighted' : 'dimmed'] as const))
              : undefined;

          // Each rule's own real status, as a colored left edge — 'success' (green) once it has
          // real, currently-observed traffic of its own (`metrics.byRuleId`, the same data its own
          // Sources table reads), 'default' (plain neutral) otherwise — matching the real Signal
          // Path page's own established per-rule status convention (`route-rule-row--*`, already
          // defined in the shared, read-only-reused `NodeCard.css`, just never applied here before).
          const ruleHealthStates: Map<string, 'success' | 'default'> | undefined =
            lane === 'routes' && routeTable
              ? new Map(routeTable.routes.map((r) => [r.id, hasVolume(metrics?.byRuleId.get(r.id)) ? 'success' : 'default'] as const))
              : undefined;

          return (
            <div
              key={lane}
              className={lane === 'routes' ? 'flow-lane flow-lane--routes' : 'flow-lane'}
              ref={(el) => {
                if (el) laneRefs.current.set(lane, el);
                else laneRefs.current.delete(lane);
              }}
            >
              <div className="flow-lane-header">
                <div className="flow-lane-title">
                  {LANE_TITLE[lane].toUpperCase()}
                  <span className="flow-lane-count">
                    {lane === 'routes'
                      ? `(${visibleRuleCount !== totalRuleCount ? `${visibleRuleCount}/${totalRuleCount}` : totalRuleCount})`
                      : `(${nodes.length !== laneNodes.length ? `${nodes.length}/${laneNodes.length}` : nodes.length})`}
                  </span>
                </div>
                {/* No search box for Routes — per explicit direction, this lane's own single card
                    (a routing table, not a filterable set of components) doesn't get one; its rule
                    rows still respect the *other* lanes' own cross-lane connectivity restriction
                    (see `visibleRuleIds` above), just never their own direct text query. A same-
                    height invisible spacer stands in its place instead of just omitting the box —
                    every lane's own `.flow-lane-nodes` needs to start at the identical Y position,
                    which `.flow-lane-header` (a plain flex column) can only guarantee if every
                    lane's header actually occupies the same total height. */}
                {lane !== 'routes' ? (
                  <div className="flow-lane-search">
                    <Search />
                    <input
                      type="text"
                      placeholder={`Filter ${LANE_TITLE[lane].toLowerCase()}…`}
                      value={control.search}
                      onChange={(e) => setControl({ search: e.target.value })}
                    />
                    {control.search !== '' && (
                      <button
                        type="button"
                        className="flow-lane-search-clear"
                        aria-label={`Clear ${LANE_TITLE[lane].toLowerCase()} filter`}
                        onClick={() => setControl({ search: '' })}
                      >
                        <CloseOutlined />
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flow-lane-search-spacer" aria-hidden="true" />
                )}
              </div>
              <div
                className={
                  lane === 'pipeline' || lane === 'postPipeline' || lane === 'destination'
                    ? 'flow-lane-nodes flow-lane-nodes--detour-gap'
                    : 'flow-lane-nodes'
                }
              >
                {nodes.map((node) => (
                  <NodeCard
                    key={node.id}
                    node={node}
                    onSelect={onSelectNode}
                    onSelectRule={onSelectRule}
                    stats={metrics?.byNodeId.get(node.id)}
                    functionErrors={functionErrorsByNodeId?.get(node.id)}
                    visibleRuleIds={visibleRuleIds}
                    workerRows={workerStatusByNodeId ? workerRowsForNode(node, workerStatusByNodeId) : undefined}
                    product={groupProductById?.get(node.workerGroupId)}
                    highlightState={nodeHighlightState(node, hoveredSourceIds, metrics)}
                    ruleHighlightStates={ruleHighlightStates}
                    ruleHealthStates={ruleHealthStates}
                    chainGroupName={node.chainsToGroupId ? groupNameById?.get(node.chainsToGroupId) : undefined}
                    onChainClick={node.chainsToGroupId && onChainClick ? () => onChainClick(node.chainsToGroupId!) : undefined}
                    onNodeHoverStart={(id) => setHoveredKey({ kind: 'node', id })}
                    onNodeHoverEnd={() => setHoveredKey(undefined)}
                    onRuleHoverStart={(id) => setHoveredKey({ kind: 'rule', id })}
                    onRuleHoverEnd={() => setHoveredKey(undefined)}
                    ref={(el) => {
                      if (el) nodeRefs.current.set(node.id, el);
                      else nodeRefs.current.delete(node.id);
                    }}
                  />
                ))}
                {nodes.length === 0 && <div className="flow-lane-empty">{laneNodes.length === 0 ? 'None' : 'No matches'}</div>}
              </div>
            </div>
          );
        })}
      </div>

      {captureIcons.map((icon) => (
        <CaptureIcon
          key={icon.key}
          x={icon.x}
          y={icon.y}
          level={icon.level}
          onClick={(level) => onCapture({ level, label: icon.label, groupId: icon.groupId, nodeId: icon.nodeId, kind: icon.kind })}
        />
      ))}
    </div>
  );
}
