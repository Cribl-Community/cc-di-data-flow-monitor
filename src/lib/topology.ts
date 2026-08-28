import type {
  RawPipeline,
  RawStatusEntry,
  RawTopologyBundle,
} from '../api/topology';
import type { NodeVolumeTotals } from '../api/metrics';
import { ALL_GROUPS_ID, type FlowGraph, type FlowSummary, type GraphEdge, type GraphNode, type HealthStatus, type IndividualFlow, type PqStatus, type VolumeUnit } from './types';
import { criblConfigPath } from './criblLinks';

export interface VolumeData {
  /** Which unit `sourceTotals`/`destTotals` (as opposed to `*Other`) were fetched in. */
  unit: VolumeUnit;
  sourceTotals: Record<string, NodeVolumeTotals>;
  destTotals: Record<string, NodeVolumeTotals>;
  /**
   * Source/Destination totals for the *other* unit, fetched in parallel regardless of which one
   * is selected at the top of the app — the drawer shows Events and Bytes side by side, so both
   * always need to be populated, not just whichever the top toggle currently has selected.
   */
  sourceTotalsOther: Record<string, NodeVolumeTotals>;
  destTotalsOther: Record<string, NodeVolumeTotals>;
  routeTotals: Record<string, NodeVolumeTotals>;
  /**
   * Same idea as `sourceTotalsOther`/`destTotalsOther`, for Routes — additionally used to derive
   * each main Pipeline's byte volume (Cribl has no `pipe.*_bytes` counter), by summing every
   * contributing rule's `route.in_bytes`/`route.out_bytes`. See `pipelineByteVolume` below.
   */
  routeTotalsOther: Record<string, NodeVolumeTotals>;
  pipelineTotals: Record<string, NodeVolumeTotals>;
  routeSourceBreakdown: Record<string, Record<string, number>>;
  /**
   * Same query as `routeSourceBreakdown`, fetched in the other unit — same reasoning as
   * `sourceTotalsOther`/`routeTotalsOther`: Flow Matrix's `FlowSummary` rows carry both Events
   * and Bytes simultaneously (not just whichever unit is selected at the top), so both need to be
   * populated regardless of which one drives the current view.
   */
  routeSourceBreakdownOther: Record<string, Record<string, number>>;
}

const ZERO_TOTALS: NodeVolumeTotals = { in: 0, out: 0, dropped: 0 };
const EMPTY_STUCK_SET: ReadonlySet<string> = new Set();

function opHealthOf(entry: RawStatusEntry | undefined): 'Green' | 'Yellow' | 'Red' | 'Unknown' | undefined {
  return entry?.status?.health;
}

/** `undefined` when persistent queue isn't enabled on this component at all (Cribl simply omits
 *  `status.pq` in that case — confirmed live against the real test org — rather than including it
 *  with an "off" state), which is exactly the "where applicable" signal `GraphNode.pq` needs. */
function pqStatusOf(entry: RawStatusEntry | undefined): PqStatus | undefined {
  const pq = entry?.status?.pq;
  if (!pq?.health) return undefined;
  return { health: pq.health, error: pq.error?.message };
}

/**
 * Single health rule applied uniformly across node kinds: no observed volume this window is
 * always grey ("no data"), even if the underlying connector reports itself operationally
 * healthy — operational health and current traffic are different signals, and conflating them
 * makes an idle Source read as green. Otherwise: any operational error, or volume arriving with
 * nothing leaving, is red ("receiving but not sending"); clean in-and-out is green.
 *
 * Deliberately does *not* derive `degraded` from a nonzero drop count (or a `Yellow` operational
 * status) anymore, per explicit direction — a component dropping some events isn't necessarily a
 * problem (Cribl trimming volume before a Destination to save on license/storage cost is expected,
 * intentional behavior, the same reasoning `flowHealthFromVolume` below already applies to a
 * flow's own health), and treating every drop as "degraded" read as false-positive-prone. `dropped`
 * stays in the signature (several call sites still need it for `received`'s own math, e.g. a
 * Destination's `received = out + dropped`) but no longer affects the returned status — the *only*
 * source of a real `degraded` result anywhere in this app now is `withWorkerAlert`'s own partial
 * (some-but-not-all-workers) per-worker-blocked escalation, a factual signal Cribl reports directly
 * rather than something inferred from a drop count.
 */
function deriveHealth(opts: {
  received: number;
  sent: number;
  dropped: number;
  opHealth?: 'Green' | 'Yellow' | 'Red' | 'Unknown';
}): HealthStatus {
  const { received, sent, opHealth } = opts;
  if (received <= 0) return 'nodata';
  if (opHealth === 'Red') return 'blocked';
  if (sent <= 0) return 'blocked';
  return 'good';
}

/**
 * Bug found live via the Playwright harness (see CLAUDE.md): this used to seed `worst` with the
 * literal value `'nodata'` rather than the *rank* of "nothing worse than good yet" — since
 * `nodata` (rank 1) outranks `good` (rank 0), an all-`good` input array never updated `worst`
 * away from that seed and silently returned `nodata`. Concretely: two perfectly healthy
 * endpoints on a segment rendered that segment grey, every time — this was very likely the
 * dominant cause of "some lines are grey despite processing data," more so than the Routes
 * aggregate-contamination issue fixed alongside it. Seeding from the first real status (there's
 * always at least one whenever this matters) instead of a hardcoded value fixes the whole class.
 */
function worstOf(statuses: HealthStatus[]): HealthStatus {
  const rank: Record<HealthStatus, number> = { blocked: 3, degraded: 2, nodata: 1, good: 0 };
  if (statuses.length === 0) return 'nodata';
  let worst = statuses[0];
  for (const s of statuses) {
    if (rank[s] > rank[worst]) worst = s;
  }
  return worst;
}

interface EdgeAccumulator {
  fromId: string;
  toId: string;
  kind: GraphEdge['kind'];
  metricValue: number;
  healths: HealthStatus[];
  routeIds: Set<string>;
  observedSourceIds: Set<string>;
  /** True once any contributing rule was NOT disabled — see `disabled` below. */
  everEnabled: boolean;
}

class EdgeBuilder {
  private map = new Map<string, EdgeAccumulator>();

  add(opts: {
    fromId: string;
    toId: string;
    kind: GraphEdge['kind'];
    metricValue: number;
    health: HealthStatus;
    routeId?: string;
    observedSourceIds?: Iterable<string>;
    disabled?: boolean;
  }): void {
    const key = `${opts.fromId}=>${opts.toId}=>${opts.kind}`;
    let acc = this.map.get(key);
    if (!acc) {
      acc = {
        fromId: opts.fromId,
        toId: opts.toId,
        kind: opts.kind,
        metricValue: 0,
        healths: [],
        routeIds: new Set(),
        observedSourceIds: new Set(),
        everEnabled: false,
      };
      this.map.set(key, acc);
    }
    acc.metricValue += opts.metricValue;
    acc.healths.push(opts.health);
    if (opts.routeId) acc.routeIds.add(opts.routeId);
    if (opts.observedSourceIds) for (const s of opts.observedSourceIds) acc.observedSourceIds.add(s);
    if (!opts.disabled) acc.everEnabled = true;
  }

  build(): GraphEdge[] {
    return [...this.map.entries()].map(([key, acc]) => ({
      id: key,
      fromId: acc.fromId,
      toId: acc.toId,
      kind: acc.kind,
      health: worstOf(acc.healths),
      metricValue: acc.metricValue,
      routeIds: acc.routeIds.size ? [...acc.routeIds] : undefined,
      observedSourceIds: acc.observedSourceIds.size ? [...acc.observedSourceIds] : undefined,
      // Two or more Route rules can legitimately share the same physical edge (same Pipeline,
      // same next hop) — the edge is only genuinely unused if *every* rule using it is disabled,
      // not if merely one of several is. Marking it disabled whenever any single contributor was
      // disabled would render an actively-flowing, heavily-trafficked rule's own edge as dashed
      // and faded just because it happens to share a destination with an unrelated disabled rule.
      disabled: acc.everEnabled ? undefined : true,
    }));
  }
}

/**
 * Blocked = real input, zero output. No data = no input at all. Healthy = both above zero,
 * regardless of the *ratio* between them — Cribl trimming volume before a destination is expected
 * behavior, not degradation, so there is deliberately no "degraded" state for a flow (unlike a
 * component's own `HealthStatus` elsewhere in this app). Always computed from event counts
 * specifically, never bytes: a `FlowSummary`/`IndividualFlow` carries both units at once and
 * health has to mean the same thing regardless of which one the top toggle currently shows.
 */
function flowHealthFromVolume(inEvents: number, outEvents: number): HealthStatus {
  if (inEvents <= 0) return 'nodata';
  if (outEvents <= 0) return 'blocked';
  return 'good';
}

interface FlowSummaryAccumulator {
  sourceId: string;
  destinationId: string;
  workerGroupId: string;
  inEvents: number;
  outEvents: number;
  inBytes: number;
  outBytes: number;
  routeIds: Set<string>;
  pipelineIds: Set<string>;
  prePipelineId?: string;
  postPipelineId?: string;
  flows: IndividualFlow[];
}

/**
 * Aggregates one row per (Source, Destination) pair actually observed together, for the Overview
 * Volume Matrix and Flow Explorer. Two or more Route rules can share the same Source+Destination
 * pair — each contributing rule/connection is always kept as its own `IndividualFlow` entry (what
 * Flow Explorer's expanded, per-flow breakdown needs), unaffected by anything below.
 *
 * The aggregate row's own `outEvents`/`outBytes` are summed across every contributing flow — each
 * one is a real, physically distinct delivery out to the Destination, so summing them is correct
 * (more routes to the same place genuinely means more total egress).
 *
 * The aggregate row's own `inEvents`/`inBytes` are the **max**, not the sum, across contributing
 * flows — a real, reported bug fix, not the original design. Cribl's own per-rule attribution
 * (`route.in_events` split by rule + input) reports "how much of this Source reached this rule,"
 * which is a genuinely different question from "how much of this Source is unique, un-duplicated
 * traffic" — when two rules on the same table both see the *same* physical ingest (e.g. two
 * non-final rules, or any structure where the Source's real traffic reaches both independently),
 * each one reports close to the Source's own full volume, and summing them double- (or N-times-)
 * counts a Source that was only ever ingested once. Taking the max instead reflects "at least this
 * much reached this Destination via any one of these paths" without inflating past what was really
 * observed. **Known, deliberate limitation**: if two rules instead used mutually exclusive filters
 * to split a Source's real traffic into genuinely disjoint subsets both landing on the same
 * Destination (each rule then correctly reporting only its own partial share, not a duplicate of
 * the whole), max would *undercount* the real total reaching that Destination — Cribl's own metrics
 * don't expose enough to tell the two cases apart, and this app has no way to distinguish "these two
 * numbers are duplicates of one ingest" from "these two numbers are genuinely disjoint slices of one
 * ingest" without guessing. Chosen deliberately over sum: this app's own established convention is
 * to never let a shared physical resource look busier than it really is (see `EdgeBuilder`'s
 * identical `everEnabled`-not-`anyEnabled` reasoning for a merged edge's own disabled state) —
 * overstating a real ingest reads as more actively misleading than the rarer disjoint-filter case
 * reading as slightly conservative.
 */
class FlowSummaryBuilder {
  private map = new Map<string, FlowSummaryAccumulator>();

  add(opts: {
    sourceId: string;
    destinationId: string;
    workerGroupId: string;
    inEvents: number;
    outEvents: number;
    inBytes: number;
    outBytes: number;
    /** The Route rule's own configured name, or "QuickConnect" for a connection with no rule. */
    flowLabel: string;
    /** Absent for a QuickConnect Source — it bypasses Routes entirely, so there's no rule to name. */
    routeId?: string;
    pipelineId?: string;
    /** Every pipeline `pipelineId` chains into via the Chain function, in order, NOT including
     *  `pipelineId` itself — see `chainHopsFrom`. Folded into the aggregate's own `pipelineIds`
     *  the same as `pipelineId`, and carried on the individual flow so a chained flow's own
     *  expanded diagram (Flow Explorer) shows every real hop, not just the first. */
    chainPipelineIds?: string[];
    prePipelineId?: string;
    postPipelineId?: string;
  }): void {
    const key = `${opts.sourceId}=>${opts.destinationId}`;
    let acc = this.map.get(key);
    if (!acc) {
      acc = {
        sourceId: opts.sourceId,
        destinationId: opts.destinationId,
        workerGroupId: opts.workerGroupId,
        inEvents: 0,
        outEvents: 0,
        inBytes: 0,
        outBytes: 0,
        routeIds: new Set(),
        pipelineIds: new Set(),
        prePipelineId: opts.prePipelineId,
        postPipelineId: opts.postPipelineId,
        flows: [],
      };
      this.map.set(key, acc);
    }
    // IN is the max across contributing flows, not the sum — see this class's own doc comment for
    // why. OUT keeps summing: each contributing flow is a real, distinct delivery.
    acc.inEvents = Math.max(acc.inEvents, opts.inEvents);
    acc.inBytes = Math.max(acc.inBytes, opts.inBytes);
    acc.outEvents += opts.outEvents;
    acc.outBytes += opts.outBytes;
    if (opts.routeId) acc.routeIds.add(opts.routeId);
    if (opts.pipelineId) acc.pipelineIds.add(opts.pipelineId);
    for (const pid of opts.chainPipelineIds ?? []) acc.pipelineIds.add(pid);
    acc.flows.push({
      id: opts.routeId ?? `quickconnect:${acc.flows.length}`,
      label: opts.flowLabel,
      health: flowHealthFromVolume(opts.inEvents, opts.outEvents),
      inEvents: opts.inEvents,
      outEvents: opts.outEvents,
      inBytes: opts.inBytes,
      outBytes: opts.outBytes,
      routeId: opts.routeId,
      pipelineId: opts.pipelineId,
      chainPipelineIds: opts.chainPipelineIds,
    });
  }

  build(nodesById: Map<string, GraphNode>, unit: VolumeUnit): FlowSummary[] {
    return [...this.map.entries()].map(([key, acc]) => {
      const { inEvents, outEvents, inBytes, outBytes } = acc;
      const inForUnit = unit === 'events' ? inEvents : inBytes;
      const outForUnit = unit === 'events' ? outEvents : outBytes;
      return {
        id: key,
        sourceId: acc.sourceId,
        sourceLabel: nodesById.get(acc.sourceId)?.label ?? rawIdOf({ id: acc.sourceId, kind: 'source' }),
        destinationId: acc.destinationId,
        destinationLabel: nodesById.get(acc.destinationId)?.label ?? rawIdOf({ id: acc.destinationId, kind: 'destination' }),
        workerGroupId: acc.workerGroupId,
        health: flowHealthFromVolume(inEvents, outEvents),
        // "Enabled" for a flow means both real endpoints are turned on in Cribl's own config —
        // either one being disabled means this pairing can't structurally carry real traffic
        // regardless of what any rule between them does.
        disabled: (nodesById.get(acc.sourceId)?.disabled ?? false) || (nodesById.get(acc.destinationId)?.disabled ?? false),
        inEvents,
        outEvents,
        inBytes,
        outBytes,
        ratio: inForUnit > 0 ? outForUnit / inForUnit : 0,
        routeIds: [...acc.routeIds],
        pipelineIds: [...acc.pipelineIds],
        prePipelineId: acc.prePipelineId,
        postPipelineId: acc.postPipelineId,
        flows: acc.flows,
      };
    });
  }
}

/**
 * A source node id that can never be a real Cribl id (real ones are always `source:<rawId>`) —
 * used as the sole member of a rule's own `routeRuleSourceIds`/edge `observedSourceIds` when
 * static analysis (see `sawGuaranteedCatchAllBeforeRule` below) has *proven*, from Route config
 * alone, that this rule can never receive any events at all (it's listed after an enabled
 * `final:true` rule that's guaranteed to match everything remaining). This is deliberately never
 * emitted as a real attribution — only as a way to force the *existing* observedSourceIds-based
 * reachability filtering (`lib/reachability.ts`) to correctly resolve to "definitely nothing,"
 * rather than falling through to its normal "no data at all, stay permissive" behavior, which
 * would otherwise be actively misleading for a rule we can prove is structurally dead.
 */
const UNREACHABLE_SOURCE_SENTINEL = 'source:__structurally_unreachable__';

/**
 * The synthetic rule id "endRoute" (Cribl's own implicit fallthrough, not a real configured rule
 * — see `GraphNode.endRoute`'s own doc comment) is given everywhere it needs to participate in the
 * same systems a real rule's own id would: `routeRuleHealth`, an edge's own `routeId`, and the
 * canvas row's `data-rule-row-id` (`NodeCard.tsx`, imported from here for consistency rather than
 * a second, possibly-drifting string literal).
 */
export const END_ROUTE_ID = '__end_route__';

/**
 * True when this filter is Cribl's own convention for "match every event" — an absent filter, or
 * the literal string `"true"` (confirmed against this project's own established display
 * convention, `NodeCard.tsx`'s `rule.filter || 'true'`, and the user's own description: "A filter
 * of 'true' mean all events..."). Deliberately a plain string check, not real expression
 * evaluation — this app has never evaluated Cribl's own JS-like filter syntax and doesn't start
 * here; an unusual-but-equivalent expression (e.g. `"1==1"`) simply won't be recognized, which
 * only means the optimization below doesn't kick in for that rule — the safe direction to miss in,
 * never the unsafe one (it can only fail to prove unreachability, never wrongly prove it).
 */
function isUnconditionalMatchFilter(filter: string | undefined): boolean {
  return !filter || filter.trim() === 'true';
}

/** First enabled `chain` function in a Pipeline's function list, if any. */
function findChainTarget(pipeline: RawPipeline): string | undefined {
  const fn = pipeline.conf.functions?.find((f) => f.id === 'chain' && !f.disabled);
  const target = fn?.conf?.processor;
  return typeof target === 'string' && target.length > 0 ? target : undefined;
}

/**
 * The `input`/`output` metric dimensions are keyed `${type}:${id}` (confirmed live — e.g. a
 * Source with id `apache_error` and type `datagen` reports as `datagen:apache_error`), not the
 * bare id `/system/inputs`/`/system/outputs` use. Every lookup into a totals map keyed by this
 * dimension must go through this helper rather than the raw id.
 */
export function metricsKey(type: string, id: string): string {
  return `${type}:${id}`;
}

/**
 * Sums the canonical `total.in_*` volume of every *distinct* Source referenced by `summaries`,
 * each counted exactly once via its own `GraphNode.metrics.inEvents`/`inBytes` — never by
 * summing `FlowSummary.inEvents`/`inBytes` across that Source's own rows directly. A Source that
 * fans out to more than one Destination (via more than one Route rule, or a non-final rule
 * matching alongside another) is represented by *multiple* `FlowSummary` rows — one per pairing —
 * each carrying that Source's own attributed inbound share for that one destination. Summing
 * `inEvents`/`inBytes` across those rows double- (or multiply-) counts the same physical ingest,
 * inflating an aggregate "total IN" figure past what the Source actually received. A Source
 * node's own `metrics.inEvents`/`inBytes` is set directly from Cribl's real `total.in_*` boundary
 * counter (see the Sources construction loop above) — measured once, regardless of how many Route
 * rules subsequently reprocess it — so it's the correct ground truth for "how much came in."
 *
 * There's no equivalent concern on the OUT side: each pairing's own `outEvents`/`outBytes`
 * reflects a distinct, real delivery to that one Destination, so summing OUT across a Source's
 * multiple pairings (or a Destination's multiple Sources) stays correct as-is — only aggregating
 * IN across more than one `FlowSummary` row needs this dedup.
 */
export function sumUniqueSourceIn(summaries: Iterable<{ sourceId: string }>, nodesById: Map<string, GraphNode>, unit: VolumeUnit): number {
  const seen = new Set<string>();
  let total = 0;
  for (const s of summaries) {
    if (seen.has(s.sourceId)) continue;
    seen.add(s.sourceId);
    const node = nodesById.get(s.sourceId);
    if (!node) continue;
    total += unit === 'bytes' ? (node.metrics.inBytes ?? 0) : (node.metrics.inEvents ?? 0);
  }
  return total;
}

export function buildFlowGraph(bundle: RawTopologyBundle, volumes: VolumeData, stuckDestinationIds: ReadonlySet<string> = EMPTY_STUCK_SET): FlowGraph {
  const { groupId, routeTables, pipelines, inputs, outputs, inputStatus, outputStatus } = bundle;
  const {
    unit,
    sourceTotals,
    destTotals,
    sourceTotalsOther,
    destTotalsOther,
    routeTotals,
    routeTotalsOther,
    pipelineTotals,
    routeSourceBreakdown,
    routeSourceBreakdownOther,
  } = volumes;
  // Route bytes, regardless of which unit is currently selected — same idea as `eventsAndBytes`
  // below, just for `fetchRouteVolumeTotals`'s two calls instead of the endpoint ones.
  const routeBytesTotals = unit === 'bytes' ? routeTotals : routeTotalsOther;
  const routeSourceBreakdownEvents = unit === 'events' ? routeSourceBreakdown : routeSourceBreakdownOther;
  const routeSourceBreakdownBytes = unit === 'bytes' ? routeSourceBreakdown : routeSourceBreakdownOther;
  // Which of the two fetched totals maps actually corresponds to bytes, regardless of which unit
  // is currently selected — used below to tell "Cribl genuinely reported zero bytes" apart from
  // "Cribl never reported a bytes row for this key at all" (see `sourceBytesTotals` below).
  const sourceBytesTotals = unit === 'bytes' ? sourceTotals : sourceTotalsOther;
  const destBytesTotals = unit === 'bytes' ? destTotals : destTotalsOther;
  // A Source/Destination's events and bytes values regardless of which unit is selected at the
  // top of the app — `primary` is whichever unit was fetched as `unit` this render, `other` is
  // the other one, and which one is events vs. bytes flips depending on `unit`.
  function eventsAndBytes(primary: number, other: number): { events: number; bytes: number } {
    return unit === 'events' ? { events: primary, bytes: other } : { events: other, bytes: primary };
  }

  const pipelinesById = new Map(pipelines.map((p) => [p.id, p]));
  const inputsById = new Map(inputs.map((i) => [i.id, i]));
  const inputStatusById = new Map(inputStatus.map((s) => [s.id, s]));
  const outputStatusById = new Map(outputStatus.map((s) => [s.id, s]));
  const outputsById = new Map(outputs.map((o) => [o.id, o]));
  /** metricsKey(type,id) -> bare Source id, for translating route-source-breakdown keys back to node ids. */
  const inputIdByMetricsKey = new Map(inputs.map((i) => [metricsKey(i.type, i.id), i.id]));

  /**
   * The built-in "default" output is an exception destination, not a real terminus of its own — a
   * pointer, configurable to forward to any other real Destination (`RawOutput.defaultId`,
   * "Default Output ID"; out of the box this points at "devnull"). Confirmed live against the test
   * org: Cribl's own metrics engine reflects this structurally — the "default" output's own
   * `total.out_events`/`total.out_bytes` row carries no `output` dimension tag at all, so it can
   * never be measured as a destination in its own right. Per explicit direction, every reference to
   * "default" as a dispatch target — a Route rule's own `output`, a QuickConnect connection's
   * `output`, an Output Router rule's `output` — resolves through this pointer to the real target
   * instead, so nothing in the graph ever treats "default" as a distinct destination when it
   * structurally can't be one: connections land on the real target's own card, and that card's
   * volume/health/bytes-availability all come from the exact same aggregation every other
   * Destination already gets, with no separate "default (devnull)" identity in between. Returns the
   * raw id unchanged for every other output, and falls back to the raw id if `defaultId` is unset or
   * points at a Destination that no longer exists (the same defensive-against-stale-config pattern
   * an Output Router's own rules already use elsewhere in this function) — in that one fallback
   * case, the "default" output still gets its own (permanently no-data) card below, exactly as
   * before, rather than leaving a dangling reference to a node that was never created.
   */
  function resolveOutputId(id: string): string {
    const output = outputsById.get(id);
    if (output?.type === 'default' && output.defaultId && outputsById.has(output.defaultId)) {
      return output.defaultId;
    }
    return id;
  }

  const nodes = new Map<string, GraphNode>();
  const edges = new EdgeBuilder();
  const flowSummaries = new FlowSummaryBuilder();

  function pipelineHealth(pid: string): { health: HealthStatus; totals: NodeVolumeTotals } {
    const totals = pipelineTotals[pid] ?? ZERO_TOTALS;
    return {
      health: deriveHealth({ received: totals.in, sent: totals.out, dropped: totals.dropped }),
      totals,
    };
  }

  /** Ensures a pipeline node exists in the given lane/role, following its chain target if any. */
  function ensurePipelineNode(pid: string, lane: 'prePipeline' | 'pipeline' | 'postPipeline'): string {
    const nodeId = `${lane}:${pid}`;
    if (nodes.has(nodeId)) return nodeId;
    const raw = pipelinesById.get(pid);
    const { health, totals } = pipelineHealth(pid);
    nodes.set(nodeId, {
      id: nodeId,
      kind: lane,
      label: pid,
      workerGroupId: groupId,
      health,
      metrics: {
        inEvents: totals.in,
        outEvents: totals.out,
        droppedEvents: totals.dropped,
        errEvents: totals.err,
        dropRate: totals.in > 0 ? totals.dropped / totals.in : undefined,
      },
      configPath: criblConfigPath(groupId, lane, pid),
      raw,
      disabled: false,
      functionCount: raw?.conf.functions?.length,
    });

    if (raw) {
      const chainTarget = findChainTarget(raw);
      if (chainTarget && chainTarget !== pid) {
        const node = nodes.get(nodeId);
        if (node) node.chainedPipelineId = chainTarget;
        const targetNodeId = ensurePipelineNode(chainTarget, lane);
        const { health: targetHealth, totals: targetTotals } = pipelineHealth(chainTarget);
        edges.add({
          fromId: nodeId,
          toId: targetNodeId,
          kind: 'chain',
          metricValue: unit === 'events' ? targetTotals.in : 0,
          health: targetHealth,
        });
      }
    }
    return nodeId;
  }

  /**
   * The real pipeline id that actually forwards events onward from `pid` — `pid` itself if it
   * doesn't chain at all, otherwise the pipeline at the far end of its own Chain-function
   * hand-off (walking multiple hops if the chain is more than one link long). Mirrors
   * `ensurePipelineNode`'s own recursive chain-target creation exactly — every node this
   * resolves to has already been created by the time `ensurePipelineNode(pid, lane)` returns, so
   * this never needs to create anything itself, just find the real final id. A cycle (a
   * genuinely broken/circular chain config) just stops at whichever pipeline is first revisited,
   * rather than looping forever.
   */
  function resolveChainEndPid(pid: string): string {
    const hops = chainHopsFrom(pid);
    return hops.length > 0 ? hops[hops.length - 1] : pid;
  }

  /** Every pipeline id `pid` chains into, in order, NOT including `pid` itself — e.g. for
   *  `main` chaining into `passthru` which chains into `finalize`, `chainHopsFrom('main')`
   *  returns `['passthru', 'finalize']`. Empty when `pid` doesn't chain at all. */
  function chainHopsFrom(pid: string): string[] {
    const hops: string[] = [];
    const visited = new Set<string>([pid]);
    let current = pid;
    for (;;) {
      const pipeline = pipelinesById.get(current);
      const target = pipeline ? findChainTarget(pipeline) : undefined;
      if (!target || visited.has(target)) break;
      hops.push(target);
      visited.add(target);
      current = target;
    }
    return hops;
  }

  // --- Sources ---
  for (const input of inputs) {
    const status = inputStatusById.get(input.id);
    const inputKey = metricsKey(input.type, input.id);
    const totals = sourceTotals[inputKey] ?? ZERO_TOTALS;
    const otherTotals = sourceTotalsOther[inputKey] ?? ZERO_TOTALS;
    const { events: inEvents, bytes: inBytes } = eventsAndBytes(totals.in, otherTotals.in);
    // Real, live-confirmed gap: Cribl can have a genuine `total.in_events` series for a Source
    // while having *no* `total.in_bytes` series for it at all (confirmed directly against the test
    // org — a `datagen` Source whose own configured sample never produces a measurable byte
    // payload) — not a zero value, the row is simply absent from the bytes query's own response.
    // `sourceTotals`/`sourceTotalsOther` fall back to `ZERO_TOTALS` on a missing key, which made
    // this indistinguishable from "Cribl measured zero bytes," reading as a plain, silent "0 bytes"
    // with no way to tell it apart from a real, current stall. Checking the bytes-specific totals
    // map directly (bypassing the `?? ZERO_TOTALS` fallback) recovers that distinction — `undefined`
    // here is `headlineFor`'s own existing signal (already used for Pipelines) for the "Events
    // only — no Bytes metric available" message, rather than a number that looks precise but isn't.
    const hasRealSourceBytes = inputKey in sourceBytesTotals;
    const sourceNodeId = `source:${input.id}`;
    nodes.set(sourceNodeId, {
      id: sourceNodeId,
      kind: 'source',
      label: input.id,
      workerGroupId: groupId,
      // Always events, never `totals.in` directly — `totals` is whichever unit the top toggle
      // currently has selected, and a Source with real event traffic but zero *reported* bytes
      // (a real, confirmed live case) would otherwise flip to `nodata` purely from switching units,
      // vanishing under the "Active" status filter with no actual change in what it's doing. Same
      // "health must mean the same thing regardless of the selected unit" principle already applied
      // to Pipeline and flow-level health — Sources/Destinations just never got updated to match.
      health: deriveHealth({ received: inEvents, sent: inEvents, dropped: 0, opHealth: opHealthOf(status) }),
      metrics: { inEvents, inBytes: hasRealSourceBytes ? inBytes : undefined },
      configPath: criblConfigPath(groupId, 'source', input.id, input.type),
      raw: input,
      disabled: input.disabled,
      refType: input.type,
      pq: pqStatusOf(status),
    });

    const quickConnections = input.connections ?? [];
    if (quickConnections.length > 0) {
      // Same events-not-current-unit fix as the Source node's own health just above.
      const quickConnectHealth = deriveHealth({ received: inEvents, sent: inEvents, dropped: 0 });
      for (const conn of quickConnections) {
        const resolvedConnOutput = resolveOutputId(conn.output);
        const destNodeId = `destination:${resolvedConnOutput}`;
        // `observedSourceIds` on every leg — same reasoning as the Route-rule edges below: a
        // QuickConnect connection's own Pipeline can be the *same* shared Pipeline a different
        // rule (or a different QuickConnect connection) also dispatches through with a different
        // Destination, and without this, a highlight walk would fan out past this Source's own
        // real connections once it passes through that shared node.
        if (conn.pipeline) {
          const pipeNodeId = ensurePipelineNode(conn.pipeline, 'pipeline');
          const chainEndPid = resolveChainEndPid(conn.pipeline);
          const chainEndPipeId = chainEndPid === conn.pipeline ? pipeNodeId : ensurePipelineNode(chainEndPid, 'pipeline');
          edges.add({ fromId: sourceNodeId, toId: pipeNodeId, kind: 'flow', metricValue: totals.in, health: quickConnectHealth, observedSourceIds: [sourceNodeId] });
          edges.add({ fromId: chainEndPipeId, toId: destNodeId, kind: 'flow', metricValue: totals.in, health: quickConnectHealth, observedSourceIds: [sourceNodeId] });
        } else {
          edges.add({ fromId: sourceNodeId, toId: destNodeId, kind: 'flow', metricValue: totals.in, health: quickConnectHealth, observedSourceIds: [sourceNodeId] });
        }
        // No Route rule involved — a QuickConnect Source's traffic is modeled as lossless
        // pass-through end to end (same as the edges above, which both reuse `totals.in` rather
        // than tracking a separate out/dropped figure for this path), so out == in here too —
        // unless the real Destination this connects to is confirmed genuinely stuck (see
        // `stuckDestinationIds`'s own doc comment above), in which case nothing is actually
        // leaving regardless of how much this Source is still handing off.
        const quickConnectStuck = stuckDestinationIds.has(resolvedConnOutput);
        flowSummaries.add({
          sourceId: sourceNodeId,
          destinationId: destNodeId,
          workerGroupId: groupId,
          inEvents,
          outEvents: quickConnectStuck ? 0 : inEvents,
          inBytes,
          outBytes: quickConnectStuck ? 0 : inBytes,
          flowLabel: 'QuickConnect',
          pipelineId: conn.pipeline,
          chainPipelineIds: conn.pipeline ? chainHopsFrom(conn.pipeline) : undefined,
        });
      }
      continue; // QuickConnect Sources bypass Routes entirely.
    }

    if (input.sendToRoutes === false) continue; // No Routes and no QuickConnect: nothing to wire.

    // Same events-not-current-unit fix as the Source node's own health above.
    const edgeHealth = deriveHealth({ received: inEvents, sent: inEvents, dropped: 0, opHealth: opHealthOf(status) });
    if (input.pipeline) {
      const preNodeId = ensurePipelineNode(input.pipeline, 'prePipeline');
      edges.add({ fromId: sourceNodeId, toId: preNodeId, kind: 'flow', metricValue: totals.in, health: edgeHealth });
      for (const table of routeTables) {
        edges.add({ fromId: preNodeId, toId: `routes:${table.id}`, kind: 'flow', metricValue: totals.in, health: edgeHealth });
      }
    } else {
      for (const table of routeTables) {
        edges.add({ fromId: sourceNodeId, toId: `routes:${table.id}`, kind: 'flow', metricValue: totals.in, health: edgeHealth });
      }
    }
  }

  // Confirmed live against the test org: Cribl *usually* never reports `pipe.*` metrics for a
  // Pre-Processing Pipeline (configured on a Source, applied unconditionally *before* Routes even
  // runs) — only for a Pipeline reached via Route/QuickConnect dispatch. Without this,
  // `ensurePipelineNode` falls back to `ZERO_TOTALS` unconditionally for every Pre-Processing
  // Pipeline, which `deriveHealth` reads as "no data" (grey) — permanently, regardless of how much
  // real traffic its own Source(s) actually report, since there's no live counter for this stage to
  // ever populate `pipelineTotals` with. Since a Pre-Processing Pipeline is a deterministic,
  // unconditional pass-through of its own Source(s) (not a real drop-yielding checkpoint we could
  // otherwise measure independently), derive its health/volume from whichever real Source(s)
  // actually reference it instead — summed across more than one, for the rare case of several
  // Sources sharing the same Pre-Processing Pipeline id. Only a *fallback*: a Pipeline id Cribl
  // *does* report real `pipe.*` events data for is left exactly as-is, trusting the real metric
  // over this derived one for events/health specifically.
  const prePipelineFallback = new Map<string, { inEvents: number; inBytes: number; healths: HealthStatus[] }>();
  // A real, live-confirmed gap this round found and fixed: `pipe.*_bytes` never exists for *any*
  // Pipeline role at all, regardless of whether `pipe.*_events` happens to be reported (this org's
  // own live data shows Cribl unexpectedly *does* sometimes report real events for a
  // Pre-Processing Pipeline — contradicting the "never" assumption above closely enough that a
  // real one was found reporting them — even though bytes are still never included). The full
  // fallback above only runs when there's *no* real events data at all, so a Pre-Processing
  // Pipeline that DOES get real events from Cribl fell through with `inBytes`/`outBytes` left
  // permanently `undefined` — reading as the generic "Events only — no Bytes metric available"
  // message, indistinguishable from a genuine platform gap even though its own bytes are just as
  // derivable from its Source as the full-fallback case above. Tracked separately so it applies
  // *regardless* of whether the events-and-health fallback above ran.
  const prePipelineByteFallback = new Map<string, number>();
  for (const input of inputs) {
    if (!input.pipeline) continue;
    const sourceNode = nodes.get(`source:${input.id}`);
    if (!sourceNode) continue;
    prePipelineByteFallback.set(input.pipeline, (prePipelineByteFallback.get(input.pipeline) ?? 0) + (sourceNode.metrics.inBytes ?? 0));
    if (input.pipeline in pipelineTotals) continue;
    const existing = prePipelineFallback.get(input.pipeline) ?? { inEvents: 0, inBytes: 0, healths: [] };
    existing.inEvents += sourceNode.metrics.inEvents ?? 0;
    existing.inBytes += sourceNode.metrics.inBytes ?? 0;
    existing.healths.push(sourceNode.health);
    prePipelineFallback.set(input.pipeline, existing);
  }
  for (const [pid, vol] of prePipelineFallback) {
    const node = nodes.get(`prePipeline:${pid}`);
    if (!node) continue;
    // Mirrored as its own "out" too — the same lossless-pass-through modeling this app already
    // uses for a QuickConnect leg with no better data (see the `flowSummaries.add` call above):
    // there's no separately measurable output for this stage, and treating it as a real 100% drop
    // would be actively misleading, not merely imprecise.
    node.metrics.inEvents = vol.inEvents;
    node.metrics.outEvents = vol.inEvents;
    node.metrics.inBytes = vol.inBytes;
    node.metrics.outBytes = vol.inBytes;
    node.health = worstOf(vol.healths);
  }
  for (const [pid, inBytes] of prePipelineByteFallback) {
    if (prePipelineFallback.has(pid)) continue; // already fully covered by the pass above.
    const node = nodes.get(`prePipeline:${pid}`);
    if (!node) continue;
    node.metrics.inBytes = inBytes;
    node.metrics.outBytes = inBytes;
  }

  // --- Destinations (incl. Output Router) ---
  for (const output of outputs) {
    // The built-in "default" output is an exception destination, not a real terminus of its own —
    // per explicit direction, it never gets its own separate card when it successfully resolves to
    // a real target (see `resolveOutputId`'s own doc comment above): every Route rule, QuickConnect
    // connection, Output Router rule, and endRoute that would otherwise point at "default" already
    // resolves straight to that real target's own node instead (via `resolveOutputId`, applied at
    // every one of those call sites), so a separate "default (devnull)" identity in between would
    // be redundant at best and, since its own metrics can never be measured (see that same doc
    // comment), permanently misleading at worst. Only falls through to the old behavior — its own
    // card, using its own (permanently no-data) identity — when `defaultId` is unset or points at a
    // Destination that no longer exists, so a Route rule still pointing at a genuinely unresolved
    // "default" doesn't dangle with nowhere to render.
    if (output.type === 'default' && resolveOutputId(output.id) !== output.id) continue;
    const status = outputStatusById.get(output.id);
    const outputKey = metricsKey(output.type, output.id);
    const totals = destTotals[outputKey] ?? ZERO_TOTALS;
    const otherTotals = destTotalsOther[outputKey] ?? ZERO_TOTALS;
    const { events: rawOutEvents, bytes: rawOutBytes } = eventsAndBytes(totals.out, otherTotals.out);
    // Events-only, for the health check below — same reasoning as `inEvents` for Sources above.
    const { events: droppedEvents } = eventsAndBytes(totals.dropped, otherTotals.dropped);
    // Same real gap as Sources above: Cribl can report `total.out_events` for a Destination with
    // no `total.out_bytes` series at all. Takes precedence over `isStuck` below — "no bytes metric
    // exists for this Destination at all" and "genuinely stuck, but otherwise measured normally"
    // are different, unrelated conditions.
    const hasRealDestBytes = outputKey in destBytesTotals;
    // `total.out_*` reflects what was *handed to* this Destination's output stage, not what
    // actually left it — a genuinely stuck connection (real per-worker status: `Red` health, its
    // own buffered count exactly equal to its own reported "sent" count — see
    // `lib/blockedOutput.ts`) keeps reporting as if flowing right up to "now." `stuckDestinationIds`
    // is computed once, before this function runs, from that same real per-worker signal — zeroing
    // here is the single source of truth every other consumer of this node's own `outEvents`/
    // `outBytes` (the canvas card, the drawer's stats table) reads, and, via the identical
    // destination id used below, every `FlowSummary`/`IndividualFlow` sharing this Destination
    // inherits automatically, with no separate correction needed downstream.
    const isStuck = stuckDestinationIds.has(output.id);
    const outEvents = isStuck ? 0 : rawOutEvents;
    const outBytes = isStuck ? 0 : rawOutBytes;
    const destNodeId = `destination:${output.id}`;
    const isRouter = output.type === 'router';
    nodes.set(destNodeId, {
      id: destNodeId,
      kind: isRouter ? 'outputRouter' : 'destination',
      // Only ever reached here for "default" when it *didn't* resolve (see the `continue` guard
      // above) — `defaultId` may still be set but broken (points at a deleted Destination), worth
      // surfacing next to the id even in that degraded fallback case.
      label: output.defaultId ? `${output.id} (${output.defaultId})` : output.id,
      workerGroupId: groupId,
      // Always events, never `totals.out`/`totals.dropped` directly — same fix as Sources above,
      // for the identical reason: a Destination with real event traffic but zero reported bytes
      // would otherwise flip to `nodata` purely from switching the top unit toggle.
      health: deriveHealth({ received: rawOutEvents + droppedEvents, sent: rawOutEvents, dropped: droppedEvents, opHealth: opHealthOf(status) }),
      metrics: {
        // The raw, *uncorrected* `total.out_*` figure — what every Pipeline/Route rule actually
        // handed to this Destination's own output stage, real Cribl-side-summed across every flow
        // that reaches it (the metric is already split by `output` alone, not per-flow, so this is
        // the true aggregate with no extra summing needed here). Deliberately the pre-`isStuck`
        // value, unlike `outEvents`/`outBytes` below — for a genuinely blocked Destination, this is
        // the one figure left that still shows real volume, so a card reading "IN 1.2K / OUT 0"
        // reads as "blocked," not as "no data reaching it at all."
        inEvents: rawOutEvents,
        inBytes: hasRealDestBytes ? rawOutBytes : undefined,
        outEvents,
        outBytes: hasRealDestBytes ? outBytes : undefined,
        droppedEvents: totals.dropped,
        dropRate: totals.out + totals.dropped > 0 ? totals.dropped / (totals.out + totals.dropped) : undefined,
      },
      configPath: criblConfigPath(groupId, isRouter ? 'outputRouter' : 'destination', output.id, output.type),
      raw: output,
      disabled: output.disabled,
      // Deduped: two rules resolving to the same real target (e.g. one points at "devnull"
      // directly, another at "default" which also resolves to "devnull") should roll up into one
      // real target once, not have its own volume summed twice into this router's own aggregate.
      routerRuleIds: isRouter ? [...new Set(output.rules?.map((r) => resolveOutputId(r.output)) ?? [])] : undefined,
      refType: output.type,
      pq: pqStatusOf(status),
    });

    if (isRouter && output.rules) {
      for (const rule of output.rules) {
        const resolvedRuleOutput = resolveOutputId(rule.output);
        const targetId = `destination:${resolvedRuleOutput}`;
        if (!outputsById.has(resolvedRuleOutput)) continue; // Rule points at a destination that no longer exists.
        edges.add({
          fromId: destNodeId,
          toId: targetId,
          kind: 'routerRule',
          metricValue: totals.out,
          // Same events-not-current-unit fix as the Destination node's own health above.
          health: deriveHealth({ received: rawOutEvents, sent: rawOutEvents, dropped: 0 }),
        });
      }
    }
  }

  // An Output Router is a routing table, not a real endpoint — it has no traffic metrics of its
  // own (the metrics API never reports `total.out_events` for a `type: router` output, only for
  // the genuine destinations it forwards to). Deriving its health/volume from its own
  // always-empty totals made it — and by extension every Route rule that dispatches to one —
  // permanently read as "no data" regardless of how much real traffic actually flowed through.
  // Recompute both from the real destinations its rules point at instead, now that they all exist.
  for (const node of nodes.values()) {
    if (node.kind !== 'outputRouter' || !node.routerRuleIds) continue;
    const targets = node.routerRuleIds
      .map((id) => nodes.get(`destination:${id}`))
      .filter((n): n is GraphNode => n !== undefined);
    if (targets.length === 0) continue;
    node.health = worstOf(targets.map((t) => t.health));
    node.metrics.inEvents = targets.reduce((sum, t) => sum + (t.metrics.inEvents ?? 0), 0);
    node.metrics.inBytes = targets.reduce((sum, t) => sum + (t.metrics.inBytes ?? 0), 0);
    node.metrics.outEvents = targets.reduce((sum, t) => sum + (t.metrics.outEvents ?? 0), 0);
    node.metrics.outBytes = targets.reduce((sum, t) => sum + (t.metrics.outBytes ?? 0), 0);
    node.metrics.droppedEvents = targets.reduce((sum, t) => sum + (t.metrics.droppedEvents ?? 0), 0);
  }

  // Accumulates each main Pipeline's derived byte volume across every Route rule that dispatches
  // to it — see the comment where this is applied to node metrics, after the table loop below.
  const pipelineByteVolume = new Map<string, { in: number; out: number }>();

  // Every rule's own health, indexed by rule id across every table in this group (mirrors each
  // table's own local `routeRuleHealth`, just not scoped to one table) — used by the per-segment
  // edge recoloring pass below, which runs after every table has been processed and needs to look
  // up a rule's own health from a *non-Routes* edge (Pipeline -> next hop, next hop -> Destination),
  // not just the Routes -> Pipeline edge a table-local map would cover.
  const ruleHealthById = new Map<string, HealthStatus>();

  // --- Route tables + rules ---
  for (const table of routeTables) {
    const routeRuleHealth: Record<string, HealthStatus> = {};
    const routeRuleSourceIds: Record<string, string[]> = {};
    // Resolved once per rule and reused below when adding edges, so ensurePipelineNode's
    // (idempotent) creation isn't duplicated between this pass and the edge-building pass.
    const resolvedByRule = new Map<
      string,
      { pipeNodeId: string; chainEndPipeId: string; nextHopId: string; hasPostPipeline: boolean; ruleOutputId: string }
    >();

    // Rules are evaluated top-down (this array's own order — never resorted anywhere in this
    // app, matching Cribl's real behavior); once an *enabled* rule is both `final` and matches
    // unconditionally, every rule listed after it is structurally dead — no event can ever reach
    // it, regardless of its own filter, since nothing survives past the guaranteed match above it.
    // A disabled rule is skipped entirely from this tracking (neither able to trigger it nor
    // affected by it), matching how a disabled rule is already treated as structurally absent
    // everywhere else in this app (its own edges/health already reflect that separately).
    let sawGuaranteedCatchAllRule = false;

    // Real, per-rule FINAL cascading applied over Cribl's own raw `route.in_events` (split by
    // route+input) data — confirmed live (see CLAUDE.md) that this metric reports, independently
    // for *every* rule (including disabled ones), "how many of this Source's events match this
    // rule's own filter," NOT "how many events this rule actually dispatched after real FINAL
    // cascading was applied." Two enabled rules can easily share an identical or overlapping
    // filter (e.g. both explicitly matching one Source via `__inputId=='type:id'`) — trusting the
    // raw per-rule number directly would show that Source's traffic reaching *both* rules, even
    // though a `final:true` earlier rule genuinely claims it and stops it from ever being
    // evaluated by anything below. `claimedSourceKeys` accumulates the metricsKey-format keys
    // (Cribl's own `type:id` dimension shape) an earlier *enabled* `final` rule has already
    // claimed; each subsequent rule's own raw match set has those keys subtracted before it's used
    // for anything — attribution, edges, or FlowSummaries — and a disabled rule's own raw numbers
    // are discarded entirely (real per-rule attribution is always `{}` for one, matching how
    // FlowSummaries already treats it, never just left at its raw, phantom value).
    const claimedSourceKeys = new Set<string>();
    const effectiveSourceKeysByRule = new Map<string, Set<string>>();

    for (const rule of table.routes) {
      const pipeNodeId = ensurePipelineNode(rule.pipeline, 'pipeline');
      // If `rule.pipeline` chains into another pipeline (the Chain function), the events it
      // actually hands off downstream really leave from the far end of that chain, not from
      // `rule.pipeline` itself — see `chainHopsFrom`'s own doc comment. `Routes -> Pipeline`
      // below stays anchored on `rule.pipeline` (that's genuinely where the rule dispatches to),
      // but every edge/health/ratio *past* that point uses the chain's real end instead.
      const chainHops = chainHopsFrom(rule.pipeline);
      const chainEndPid = chainHops.length > 0 ? chainHops[chainHops.length - 1] : rule.pipeline;
      const chainEndPipeId = chainEndPid === rule.pipeline ? pipeNodeId : ensurePipelineNode(chainEndPid, 'pipeline');
      // A rule configured to send to "default" resolves straight to the real target Destination
      // it actually points at (see `resolveOutputId`'s own doc comment) — every downstream lookup
      // below (its post-pipeline, its own health/volume aggregation) is that real target's, the
      // same as for any other Destination, not a separate "default" identity's.
      const ruleOutputId = resolveOutputId(rule.output);
      const targetOutput = outputsById.get(ruleOutputId);
      const nextHopId = targetOutput?.pipeline
        ? ensurePipelineNode(targetOutput.pipeline, 'postPipeline')
        : `destination:${ruleOutputId}`;
      resolvedByRule.set(rule.id, { pipeNodeId, chainEndPipeId, nextHopId, hasPostPipeline: Boolean(targetOutput?.pipeline), ruleOutputId });

      const byteTotals = routeBytesTotals[rule.id] ?? ZERO_TOTALS;
      const existingByteVolume = pipelineByteVolume.get(rule.pipeline) ?? { in: 0, out: 0 };
      pipelineByteVolume.set(rule.pipeline, { in: existingByteVolume.in + byteTotals.in, out: existingByteVolume.out + byteTotals.out });

      // This rule's own real, cascading-corrected feeder Sources — computed *before* this rule's
      // own health below, which now depends on it (see that doc comment). A disabled rule gets
      // none at all (its raw numbers are phantom, never real dispatch); an enabled rule gets its
      // own raw match set minus whatever an earlier enabled `final` rule already claimed.
      const rawKeys = Object.keys(routeSourceBreakdown[rule.id] ?? {});
      const effectiveKeys = rule.disabled ? new Set<string>() : new Set(rawKeys.filter((k) => !claimedSourceKeys.has(k)));
      effectiveSourceKeysByRule.set(rule.id, effectiveKeys);
      if (!rule.disabled && rule.final) for (const k of effectiveKeys) claimedSourceKeys.add(k);

      const observedSourceIds = [...effectiveKeys].map((key) => inputIdByMetricsKey.get(key)).filter((id): id is string => id !== undefined).map((id) => `source:${id}`);

      // Per-row status: whether real, live traffic is currently attributed to *this* rule
      // specifically — not the shared Pipeline/Destination's own aggregate health, which reflects
      // every *other* rule using them too and reads healthy the instant any one of them has real
      // traffic, regardless of this one. Confirmed live: a rule whose own feeding Source is
      // disabled, sharing a Pipeline and a Destination with genuinely active rules, was rendering
      // green purely from their traffic — none of it its own. A rule with no real attribution
      // right now (`observedSourceIds` empty — its own Source disabled/idle, or its own matches
      // fully claimed by an earlier `final` rule) reads `nodata` outright, full stop. A rule *with*
      // real attribution still uses the worst of the components it dispatches through, since a
      // confirmed-active rule can still hit a genuinely blocked Destination downstream (Cribl
      // backpressure affects every sender to a blocked Destination, not just one rule's own path)
      // and that must still surface.
      const destinationNodeId = `destination:${ruleOutputId}`;
      const componentHealths = [
        nodes.get(pipeNodeId)?.health,
        // A real degradation occurring specifically in the chain target (not `rule.pipeline`
        // itself) should still surface in this rule's own status — chainEndPipeId === pipeNodeId
        // when there's no chain, so this is a no-op duplicate in that (common) case.
        chainEndPipeId !== pipeNodeId ? nodes.get(chainEndPipeId)?.health : undefined,
        targetOutput?.pipeline ? nodes.get(nextHopId)?.health : undefined,
        nodes.get(destinationNodeId)?.health,
      ].filter((h): h is HealthStatus => h !== undefined);
      routeRuleHealth[rule.id] =
        rule.disabled || observedSourceIds.length === 0 ? 'nodata' : componentHealths.length ? worstOf(componentHealths) : 'nodata';
      ruleHealthById.set(rule.id, routeRuleHealth[rule.id]);

      // A rule's attribution is only genuinely *unknown* (and thus left permissive/unrestricted,
      // per this app's established "don't hide when uncertain" philosophy) when there's truly no
      // signal either way. Every other empty case is *definitive*, not merely "no data yet," and
      // gets the same `UNREACHABLE_SOURCE_SENTINEL` treatment as Gap 1's own static-unreachability
      // case above (real data, when present, always wins over any of these — see each arm):
      //  - `rule.disabled`: never participates in real dispatch at all, regardless of what its own
      //    raw metrics report (Cribl reports live-looking numbers for disabled rules too —
      //    confirmed live, not assumed).
      //  - `rawKeys.length > 0 && observedSourceIds.length === 0`: this rule DID have real raw
      //    matches, but cascading (an earlier enabled `final` rule) claimed every one of them —
      //    the defining case this round's fix exists for (two enabled rules matching the same
      //    Source, the earlier one final).
      //  - `sawGuaranteedCatchAllRule`: Gap 1's own static proof that no event can structurally
      //    reach this rule at all, from config alone.
      const definitivelyEmpty = rule.disabled || (rawKeys.length > 0 && observedSourceIds.length === 0) || sawGuaranteedCatchAllRule;
      routeRuleSourceIds[rule.id] = observedSourceIds.length === 0 && definitivelyEmpty ? [UNREACHABLE_SOURCE_SENTINEL] : observedSourceIds;

      if (!rule.disabled && rule.final && isUnconditionalMatchFilter(rule.filter)) sawGuaranteedCatchAllRule = true;
    }

    nodes.set(`routes:${table.id}`, {
      id: `routes:${table.id}`,
      // A route table's own configured id (usually literally "default") is not a useful
      // heading — it reads as if it were naming a rule called "default", which is a different
      // thing. There's exactly one Routes stage per Worker Group in this model, so a static
      // label is both accurate and unambiguous.
      kind: 'routes',
      label: 'Routes',
      workerGroupId: groupId,
      health: worstOf(table.routes.map((r) => routeRuleHealth[r.id])),
      metrics: {},
      configPath: criblConfigPath(groupId, 'routes', table.id),
      raw: table,
      routeRuleSourceIds,
      ruleCount: table.routes.length,
      routeRuleHealth,
    });

    for (const rule of table.routes) {
      const totals = routeTotals[rule.id] ?? ZERO_TOTALS;
      const health = routeRuleHealth[rule.id];
      const { pipeNodeId, chainEndPipeId, nextHopId, hasPostPipeline, ruleOutputId } = resolvedByRule.get(rule.id)!;
      const sourceIds = routeRuleSourceIds[rule.id];

      // One FlowSummary row per (Source, this rule's destination) pair, for Flow Matrix/Explorer.
      // Skipped for disabled rules — no real traffic flows through one, so accumulating its
      // (necessarily zero, but possibly stale) breakdown would only risk phantom rows.
      if (!rule.disabled) {
        const eventBreakdown = routeSourceBreakdownEvents[rule.id] ?? {};
        const byteBreakdown = routeSourceBreakdownBytes[rule.id] ?? {};
        // Matches Signal Path's own chain-propagation model (`lib/topologyConfigOnlyMetrics.ts`)
        // exactly, so the two views' numbers reconcile for the same Source/Destination pair: a
        // source's own OUT share, per stage, is its IN scaled by *that stage's own real observed
        // ratio* — the main Pipeline's real `pipe.out_events/pipe.in_events`, then the optional
        // Post-Processing Pipeline's own ratio on top — not the rule's own
        // `route.out_events/route.in_events`. The two aren't guaranteed to agree when one
        // Pipeline is shared by more than one rule (each rule's own route-level ratio can differ
        // slightly from the pipeline's true aggregate one, since `route.*` is measured per rule
        // while `pipe.*` is measured per pipeline), which is what let this page's own numbers
        // drift from Signal Path's; reading the same real metric here is what keeps them aligned.
        const mainPipelineTotals = pipelineTotals[rule.pipeline] ?? ZERO_TOTALS;
        const mainPipelineEventRatio = mainPipelineTotals.in > 0 ? mainPipelineTotals.out / mainPipelineTotals.in : 0;
        // If `rule.pipeline` chains into one or more further pipelines, each hop's own real
        // `pipe.out_events/pipe.in_events` ratio scales the share further, in order — mirroring
        // Signal Path's own `propagateChain` exactly (each stage's IN is the previous stage's OUT,
        // so the net effect of a multi-hop chain is each hop's own ratio multiplied together). A
        // chain hop with no real pipe.* data of its own is treated as fully unmeasured (ratio 0),
        // the same conservative default `mainPipelineEventRatio` itself uses just above.
        const chainHops = chainHopsFrom(rule.pipeline);
        const chainEventRatio = chainHops.reduce((acc, hopPid) => {
          const hopTotals = pipelineTotals[hopPid] ?? ZERO_TOTALS;
          return acc * (hopTotals.in > 0 ? hopTotals.out / hopTotals.in : 0);
        }, 1);
        const postPipelineId = outputsById.get(ruleOutputId)?.pipeline;
        const postPipelineTotals = postPipelineId ? (pipelineTotals[postPipelineId] ?? ZERO_TOTALS) : undefined;
        const postPipelineEventRatio = postPipelineTotals && postPipelineTotals.in > 0 ? postPipelineTotals.out / postPipelineTotals.in : 1;
        const effectiveKeys = effectiveSourceKeysByRule.get(rule.id);
        for (const key of new Set([...Object.keys(eventBreakdown), ...Object.keys(byteBreakdown)])) {
          const sourceId = inputIdByMetricsKey.get(key);
          if (!sourceId) continue;
          // Same FINAL-cascading correction as `observedSourceIds` above — a source already
          // claimed by an earlier enabled `final` rule never reaches this one for real, so it gets
          // no FlowSummary row here either, regardless of what the raw per-rule breakdown reports.
          if (effectiveKeys && !effectiveKeys.has(key)) continue;
          const inEventsShare = eventBreakdown[key] ?? 0;
          const inBytesShare = byteBreakdown[key] ?? 0;
          // A genuinely stuck Destination (see `stuckDestinationIds`'s own doc comment above)
          // overrides both derived figures below — real per-worker status already confirms
          // nothing is actually leaving, a stronger signal than either estimate.
          const ruleStuck = stuckDestinationIds.has(ruleOutputId);
          const outEventsShare = ruleStuck ? 0 : inEventsShare * mainPipelineEventRatio * chainEventRatio * postPipelineEventRatio;
          // `pipe.*_bytes` doesn't exist anywhere in Cribl's metrics catalog (confirmed live, see
          // `lib/topologyConfigOnlyMetrics.ts`'s own doc comment) — there's no real per-pipeline
          // byte ratio to scale by, so bytes follow that same file's own established convention
          // for exactly this gap: a Destination's own per-source OUT is its IN, copied verbatim,
          // rather than a route-level-ratio guess with no equivalent real signal behind it.
          const outBytesShare = ruleStuck ? 0 : inBytesShare;
          flowSummaries.add({
            sourceId: `source:${sourceId}`,
            destinationId: `destination:${ruleOutputId}`,
            workerGroupId: groupId,
            inEvents: inEventsShare,
            outEvents: outEventsShare,
            inBytes: inBytesShare,
            outBytes: outBytesShare,
            flowLabel: rule.name,
            routeId: rule.id,
            pipelineId: rule.pipeline,
            chainPipelineIds: chainHops.length > 0 ? chainHops : undefined,
            prePipelineId: inputsById.get(sourceId)?.pipeline,
            postPipelineId,
          });
        }
      }

      edges.add({
        fromId: `routes:${table.id}`,
        toId: pipeNodeId,
        kind: 'flow',
        metricValue: totals.in,
        health,
        routeId: rule.id,
        observedSourceIds: sourceIds,
        disabled: rule.disabled,
      });

      edges.add({
        // If `rule.pipeline` chains into another pipeline, the events it hands off downstream
        // really leave from the chain's real end (`chainEndPipeId`, resolved above) — the
        // intermediate `chain`-kind edge(s) connecting `pipeNodeId` to it already exist (built
        // by `ensurePipelineNode`'s own recursive chain-following), so this just continues from
        // the real last hop rather than drawing a second, topologically-wrong edge straight from
        // `rule.pipeline` past its own chain target.
        fromId: chainEndPipeId,
        toId: nextHopId,
        kind: 'flow',
        metricValue: totals.out,
        health,
        routeId: rule.id,
        // Same real per-rule source attribution as the routes->pipeline edge above, carried one
        // hop further downstream — this is what lets `directionalReach` (lib/reachability.ts)
        // correctly narrow a hover/search highlight when this same Pipeline is *also* referenced
        // by a different rule with a different Destination: without this, the highlight walk
        // loses rule-level granularity the instant it passes through a shared Pipeline node and
        // fans back out to every one of that Pipeline's own downstream edges, not just the one
        // actually attributable to the hovered Source/rule.
        observedSourceIds: sourceIds,
        disabled: rule.disabled,
      });

      if (hasPostPipeline) {
        edges.add({
          fromId: nextHopId,
          toId: `destination:${ruleOutputId}`,
          kind: 'flow',
          metricValue: totals.out,
          health,
          routeId: rule.id,
          // Same reasoning as the edge above — a Post-Processing Pipeline can equally be shared
          // across rules with different final Destinations.
          observedSourceIds: sourceIds,
          disabled: rule.disabled,
        });
      }
    }

    // Cribl's own real behavior (confirmed against its documentation — see CLAUDE.md): any event
    // that reaches the end of this table without ever matching an enabled `final:true` rule
    // guaranteed to match everything remaining implicitly falls through to the group's own
    // "default" output. Modeled as "endRoute" — a real, dedicated, always-last row on the Routes
    // card (see `GraphNode.endRoute`) whose own connections behave exactly like a real rule's (a
    // normal `routeId`-tagged `flow` edge, normal hover/highlight, a real `routeRuleHealth` entry)
    // rather than a visually-special one, per explicit direction. Deliberately a *separate* concept
    // from Cribl's own literal pre-built "default" Route rule some orgs ship with (an ordinary
    // entry in `table.routes`, unaffected by any of this) — see this node's own `endRoute` doc
    // comment for the distinction.
    //
    // Always shown whenever the group has a real "default" output configured — an admin can
    // rename or delete it, so that's never assumed, but its *presence* is never conditioned on
    // whether some other rule (named "default" or anything else) happens to also be a guaranteed
    // catch-all. An earlier round tied endRoute's own visibility to `sawGuaranteedCatchAllRule`
    // (the same flag that marks *later rules* as structurally unreachable — a real, correct, and
    // still-unchanged use of that flag, see `definitivelyEmpty` above), reasoning that if some
    // earlier rule already claims 100% of traffic, nothing can ever structurally reach endRoute
    // either. That reasoning was sound in isolation, but per explicit direction endRoute and any
    // real Route rule — including a literal "default" one — are independent concepts: endRoute
    // always exists as a structural feature of the table itself, and its own real health/volume
    // (derived from the resolved destination's own real traffic, not rule config) is what honestly
    // reflects whether anything is actually reaching it, not whether the row is shown at all.
    const defaultOutput = outputsById.get('default');
    if (defaultOutput) {
      // The "default" output is itself a pointer, not a real terminus (its own `defaultId` names
      // the real Destination it forwards to — see `resolveOutputId`'s own doc comment) — so
      // "endRoute"'s own destination is that resolved target, not the "default" output node
      // itself, per explicit direction. Same shared resolution every other dispatch target
      // ("default" as a Route rule's own `output`, a QuickConnect connection, an Output Router
      // rule) already goes through, reused here rather than a second, possibly-drifting copy of
      // the same ternary this used to duplicate inline.
      const resolvedDefaultId = resolveOutputId('default');
      const endRouteDestNodeId = `destination:${resolvedDefaultId}`;
      const resolvedDefaultOutput = outputsById.get(resolvedDefaultId)!;
      // Routes through the resolved Destination's own configured Post-Processing Pipeline, if
      // any — that config applies to every event reaching the output regardless of which rule (or
      // lack of one) sent it there, the same reasoning `hasPostPipeline` already applies to real
      // rules.
      const endRouteNextHopId = resolvedDefaultOutput.pipeline ? ensurePipelineNode(resolvedDefaultOutput.pipeline, 'postPipeline') : endRouteDestNodeId;
      // The resolved Destination's own already-computed health (from its real total.out_events,
      // regardless of what mechanism is delivering to it) — a real, if coarse, signal: nonzero
      // traffic reaching it despite no rule explicitly claiming credit is itself evidence this
      // implicit path is actively catching real fallthrough right now.
      const endRouteHealth = nodes.get(endRouteDestNodeId)?.health ?? 'nodata';
      routeRuleHealth[END_ROUTE_ID] = endRouteHealth;
      // Cribl reports no live attribution for "events that matched no rule" (only real per-rule
      // matches), so *which specific* Sources genuinely reach the fallthrough is unknowable from
      // live data alone. But that's not the same as knowing *nothing* — `claimedSourceKeys` (built
      // across the rule loop above) is a complete, deterministic record of every Source a `final`
      // rule has already claimed, and a claimed Source can *never* structurally reach here, full
      // stop, regardless of live data. A real, previously-shipped bug, found live: leaving this as
      // a genuinely empty array left the edge with no `observedSourceIds` at all, which the
      // reachability walk's own "no attribution data → stay permissive" fallback (correct for a
      // rule with truly unknown data) then treated as "connected to every Source" — so hovering
      // *any* Source, including one already fully claimed by an earlier `final` rule, always lit up
      // endRoute too. Fixed by building a real, positive candidate list instead: every Source that
      // actually feeds this table's own Routes (`sendToRoutes !== false` — one that bypasses Routes
      // entirely, e.g. QuickConnect-only, was never a candidate to begin with) *minus* whatever
      // `claimedSourceKeys` proves is already spoken for. A Source in this list is still only a
      // *possible* fallthrough (staying permissive there, same philosophy as everywhere else in
      // this app) — but a Source that's provably claimed is now correctly excluded outright, not
      // just left to an accidental default.
      const endRouteSourceIds = inputs
        .filter((input) => input.sendToRoutes !== false && !claimedSourceKeys.has(metricsKey(input.type, input.id)))
        .map((input) => `source:${input.id}`);
      routeRuleSourceIds[END_ROUTE_ID] = endRouteSourceIds.length === 0 ? [UNREACHABLE_SOURCE_SENTINEL] : endRouteSourceIds;
      edges.add({
        fromId: `routes:${table.id}`,
        toId: endRouteNextHopId,
        kind: 'flow',
        // Same reasoning as the health above — no real metric exists to weight this by.
        metricValue: 0,
        health: endRouteHealth,
        routeId: END_ROUTE_ID,
        observedSourceIds: routeRuleSourceIds[END_ROUTE_ID],
      });
      if (endRouteNextHopId !== endRouteDestNodeId) {
        edges.add({
          fromId: endRouteNextHopId,
          toId: endRouteDestNodeId,
          kind: 'flow',
          metricValue: 0,
          health: endRouteHealth,
          routeId: END_ROUTE_ID,
          observedSourceIds: routeRuleSourceIds[END_ROUTE_ID],
        });
      }
      const routesNode = nodes.get(`routes:${table.id}`);
      if (routesNode) {
        routesNode.endRoute = {
          health: endRouteHealth,
          destinationLabel: nodes.get(endRouteDestNodeId)?.label ?? resolvedDefaultId,
          // Real node ids, not just the display label — Flow Explorer's own synthetic-row logic
          // (`FlowExplorerTable.tsx`, a Source with no real `flowSummaries` entry) needs these to
          // build an accurate resolved chain for a Source that only reaches its destination via
          // this implicit fallthrough, the same way every other flow's real Post-Processing
          // Pipeline is resolved.
          destinationId: endRouteDestNodeId,
          postPipelineId: resolvedDefaultOutput.pipeline,
        };
        routesNode.health = worstOf([routesNode.health, endRouteHealth]);
      }
    }
  }

  // Cribl has no `pipe.*_bytes` counter (confirmed live against the metrics catalog — pipe.* is
  // events-only at every level), but Route -> Pipeline is a deterministic 1:1 structural link, so
  // summing each contributing rule's real `route.in_bytes`/`route.out_bytes` (grouped by target
  // pipeline id, accumulated above) gives an exact, not estimated, Pipeline byte figure. Only the
  // main "pipeline" role gets this: route.in/out_bytes bookends the *whole* dispatch chain
  // (pre-dispatch through final send), so attributing the same numbers to a pre/post-Pipeline too
  // would double-count one measurement across two nodes. pre/post-Pipelines have no comparably
  // clean byte checkpoint of their own, so they stay genuinely "n/a for bytes" rather than showing
  // a number that looks precise but isn't.
  for (const [pid, vol] of pipelineByteVolume) {
    const node = nodes.get(`pipeline:${pid}`);
    if (node) {
      node.metrics.inBytes = vol.in;
      node.metrics.outBytes = vol.out;
    }
  }

  // Per-segment edge coloring: a link's color must say "is this specific hop healthy," not
  // "is the rule/flow it belongs to healthy somewhere else." Recompute each edge's displayed
  // health from its own two endpoint nodes — e.g. a Pipeline -> Destination hop where both ends
  // are green renders green even if the Route rule feeding the Pipeline is degraded elsewhere.
  //
  // Any edge carrying real `routeIds` (Routes -> Pipeline, Pipeline -> next hop, next hop ->
  // Destination — every real Route-rule edge, regardless of which hop) is part of one or more
  // specific rules' own dispatch chain, and gets that rule's own health via `ruleHealthById`
  // (mirroring each table's own `routeRuleHealth`, indexed across every table so a non-Routes hop
  // can look it up too) — deliberately *not* just the two endpoint nodes' own shared aggregate
  // health, which reflects every *other* rule using that same Pipeline/Destination too and reads
  // healthy the instant any one of them has real traffic. Confirmed live: a rule whose own
  // feeding Source is disabled, sharing both its Pipeline and its Destination with genuinely
  // active rules, rendered every one of its own edges green purely from their traffic — not a
  // Routes-only symptom, since the *second* and *third* hops (Pipeline -> Destination) used to
  // fall straight through to the generic endpoint-aggregate branch below with no rule-awareness
  // at all. Two or more rules can legitimately share the same physical edge (same Pipeline, same
  // next hop) — worst of every contributing rule's own health, excluding one that's simply
  // unobserved (`nodata`) unless *every* contributing rule is unobserved, so a healthy rule
  // sharing an edge with an idle one still shows its own real status rather than being masked by
  // (or dragging down) the idle one. Falls back to the endpoint-aggregate formula only if a
  // contributing id genuinely has no entry (shouldn't normally happen).
  //
  // Edges *arriving* at Routes use just the upstream node's health, since a Source's traffic
  // isn't attributable to one rule until after dispatch. Every other edge (Source -> Pre-
  // Processing, QuickConnect, chain, Output Router rule) has no `routeIds` at all and keeps the
  // plain two-endpoint-aggregate formula, which is exactly right for those — nothing rule-shaped
  // to prefer instead.
  const builtEdges = edges.build().map((edge) => {
    const fromNode = nodes.get(edge.fromId);
    const toNode = nodes.get(edge.toId);
    if (!fromNode || !toNode) return edge;

    if (toNode.kind === 'routes') return { ...edge, health: fromNode.health };

    if (edge.routeIds && edge.routeIds.length > 0) {
      const allHealths = edge.routeIds.map((id) => ruleHealthById.get(id)).filter((h): h is HealthStatus => h !== undefined);
      const observedHealths = allHealths.filter((h) => h !== 'nodata');
      const ruleHealth =
        observedHealths.length > 0 ? worstOf(observedHealths) : allHealths.length > 0 ? worstOf(allHealths) : worstOf([fromNode.health, toNode.health]);
      return { ...edge, health: worstOf([ruleHealth, toNode.health]) };
    }

    if (fromNode.kind === 'routes') return { ...edge, health: fromNode.health };

    return { ...edge, health: worstOf([fromNode.health, toNode.health]) };
  });

  return {
    workerGroupId: groupId,
    nodes: [...nodes.values()],
    edges: builtEdges,
    flowSummaries: flowSummaries.build(nodes, unit),
    generatedAt: Date.now(),
  };
}

/** Strips the `${lane}:` prefix a node id was constructed with, recovering the raw Cribl id.
 *  Only correct for a non-merged graph — see `realRawIdOf` for the version that also handles a
 *  `mergeFlowGraphs` ("All Worker Groups") node, whose `id` is Worker-Group-scoped instead. */
function rawIdOf(node: { id: string; kind: string }): string {
  return node.id.slice(node.kind.length + 1);
}

/**
 * The real, un-prefixed Cribl id for this node — use this (never bare `rawIdOf`) anywhere the id
 * is about to feed a real Cribl API call (a metrics filter, a per-worker status lookup), since a
 * node from `mergeFlowGraphs`'s merged graph has a Worker-Group-scoped `id` that isn't a real
 * Cribl id at all. Falls back to `rawIdOf(node)` for every node that was never merged (`unscopedId`
 * unset), so this is always safe to use in place of `rawIdOf` at those call sites.
 */
export function realRawIdOf(node: GraphNode): string {
  return node.unscopedId ?? rawIdOf(node);
}

/**
 * Combines multiple Worker Groups' own `FlowGraph`s into one, for the "All Worker Groups" option
 * on Signal Path / Flow Matrix / Flow Explorer. Every id that's scoped to a single Cribl config
 * object within one group — node ids, `routeRuleHealth` keys, `routerRuleIds`, every
 * `FlowSummary`/`IndividualFlow` cross-reference — is re-prefixed with that graph's own Worker
 * Group id: two groups can easily have a Source or Destination configured with the exact same id
 * (e.g. both literally named `local_splunk`), and without this, their nodes/edges would silently
 * collide in the merged graph's own id-keyed maps (`nodesById.get(...)`, `workerStatusByDestination
 * .get(...)`, etc.) instead of appearing as the two distinct components they really are. Node and
 * flow *labels* are left as the bare configured name plus a "(Group Name)" suffix — readable
 * disambiguation for a human, not a machine lookup key, so no prefix noise there.
 *
 * `chainedPipelineId` is deliberately left un-prefixed (display-only text, "chains → x", never
 * used as a lookup key after construction — confirmed via a full grep of every reader).
 */
export function mergeFlowGraphs(entries: { graph: FlowGraph; groupName: string }[]): FlowGraph {
  if (entries.length === 1) return entries[0].graph;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const flowSummaries: FlowSummary[] = [];

  for (const { graph, groupName } of entries) {
    const groupId = graph.workerGroupId;
    const scope = (rawId: string) => `${groupId}::${rawId}`;
    const idMap = new Map<string, string>();
    for (const node of graph.nodes) {
      idMap.set(node.id, `${node.kind}:${scope(rawIdOf(node))}`);
    }

    for (const node of graph.nodes) {
      nodes.push({
        ...node,
        id: idMap.get(node.id)!,
        unscopedId: rawIdOf(node),
        label: `${node.label} (${groupName})`,
        routerRuleIds: node.routerRuleIds?.map(scope),
        routeRuleHealth: node.routeRuleHealth
          ? Object.fromEntries(Object.entries(node.routeRuleHealth).map(([ruleId, health]) => [scope(ruleId), health]))
          : undefined,
        // Both the keys (rule ids) *and* the values (Source node ids) need re-scoping here —
        // unlike `routeRuleHealth`'s values (a plain `HealthStatus` string, scope-independent),
        // these values are themselves node ids that just got re-prefixed above.
        routeRuleSourceIds: node.routeRuleSourceIds
          ? Object.fromEntries(
              Object.entries(node.routeRuleSourceIds).map(([ruleId, sourceIds]) => [scope(ruleId), sourceIds.map((sid) => idMap.get(sid) ?? sid)]),
            )
          : undefined,
      });
    }

    for (const edge of graph.edges) {
      const fromId = idMap.get(edge.fromId);
      const toId = idMap.get(edge.toId);
      if (!fromId || !toId) continue; // Defensive only — every edge endpoint is always a real node.
      edges.push({
        ...edge,
        id: `${groupId}::${edge.id}`,
        fromId,
        toId,
        routeIds: edge.routeIds?.map(scope),
        observedSourceIds: edge.observedSourceIds?.map((id) => idMap.get(id) ?? id),
      });
    }

    for (const summary of graph.flowSummaries) {
      const sourceId = idMap.get(summary.sourceId) ?? summary.sourceId;
      const destinationId = idMap.get(summary.destinationId) ?? summary.destinationId;
      flowSummaries.push({
        ...summary,
        id: `${sourceId}=>${destinationId}`,
        sourceId,
        destinationId,
        sourceLabel: `${summary.sourceLabel} (${groupName})`,
        destinationLabel: `${summary.destinationLabel} (${groupName})`,
        routeIds: summary.routeIds.map(scope),
        pipelineIds: summary.pipelineIds.map(scope),
        prePipelineId: summary.prePipelineId ? scope(summary.prePipelineId) : undefined,
        postPipelineId: summary.postPipelineId ? scope(summary.postPipelineId) : undefined,
        flows: summary.flows.map((flow) => ({
          ...flow,
          routeId: flow.routeId ? scope(flow.routeId) : undefined,
          pipelineId: flow.pipelineId ? scope(flow.pipelineId) : undefined,
        })),
      });
    }
  }

  return {
    workerGroupId: ALL_GROUPS_ID,
    nodes,
    edges,
    flowSummaries,
    generatedAt: Math.min(...entries.map((e) => e.graph.generatedAt)),
  };
}

/**
 * Real Cribl metrics-store keys (`type:id`, matching `metricsKey()`) for every Destination/Output
 * Router that's both (1) actually reachable right now — at least one real edge in the graph points
 * into it, from a Route rule, a QuickConnect connection, or an Output Router rule — and (2) fed by
 * an upstream node (whatever that edge's own `fromId` resolves to — a Pipeline, a Source, an
 * Output Router) that itself shows real observed volume in the selected window.
 *
 * Built for the Overview page's own "Blocked" count/chart, per direct request, after a live
 * investigation turned up a real, confirmed gap: Cribl's `blocked.outputs` metric is emitted by
 * some connector types (confirmed live: `tcpjson`) purely from periodic failed reconnect attempts,
 * with zero real event data behind them — a Destination that isn't wired into any live Route or
 * QuickConnect at all can still accumulate a real, steadily-climbing `blocked.outputs` count this
 * way (confirmed live: +1/minute, matching a reconnect cadence, not a data-throughput one), which
 * reads as far more alarming than it actually is. Filtering to only destinations that are both
 * genuinely reachable and genuinely fed removes exactly that class of noise, without touching the
 * Source-side `total.blocked_eps` half of the same "Blocked" figure — that signal has no equivalent
 * "orphaned" failure mode (a Source can only report it by actually, currently trying and failing to
 * push into Routes, which already requires real activity), so it's left unfiltered.
 *
 * Deliberately checks the upstream *node's* own aggregate volume, not per-edge attribution — a
 * Pipeline shared by multiple rules could in principle show real volume from a sibling rule while
 * this one specific edge carries none, which this simpler node-level check wouldn't catch. Good
 * enough for the reported problem (a wholly orphaned Destination, no edges at all); worth revisiting
 * with edge-level attribution if a shared-Pipeline false positive is ever reported.
 */
export function connectedAndFedDestinationKeys(graph: FlowGraph | undefined): Set<string> | undefined {
  if (!graph) return undefined;
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const keys = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind !== 'destination' && node.kind !== 'outputRouter') continue;
    const type = node.refType;
    if (!type) continue;
    const fedByRealData = graph.edges.some((e) => {
      if (e.toId !== node.id) return false;
      const upstream = nodesById.get(e.fromId);
      return upstream !== undefined && ((upstream.metrics.inEvents ?? 0) > 0 || (upstream.metrics.outEvents ?? 0) > 0);
    });
    if (fedByRealData) keys.add(metricsKey(type, realRawIdOf(node)));
  }
  return keys;
}
