import { fetchEndpointVolumeTotals, fetchLastIngestTimes, fetchPipelineVolumeTotals, fetchRouteSourceBreakdown, fetchRouteVolumeTotals } from '../api/metrics';
import type { RawOutput, RawTopologyBundle } from '../api/topology';
import type { WorkerStatusRow } from '../api/workers';
import { isDestinationStuck } from './blockedOutput';
import { resolveOutputId, findChainTarget } from './topologyConfigOnly';
import type { FlowGraph } from './types';

/**
 * Signal Path's own metrics layer — a deliberately separate module from `lib/topology.ts`'s own
 * `buildFlowGraph` (used by Flow Explorer and Overview), which this file never imports from. The
 * rest of Signal Path's own graph (`topologyConfigOnly.ts`) is intentionally metrics-free; this
 * module is only pulled in once the drawer needs real numbers for whatever was clicked.
 *
 * **Source-chained propagation model** (per explicit direction — replacing the earlier "every
 * component fetches its own independent real metric" design): a Source's own real number is the
 * only true root. Every downstream component's IN, per source, is whatever that source's OUT was
 * at the component immediately upstream of it; a component's own OUT, per source, is that IN
 * scaled by *that component's own real, observed reduction ratio* (still a real Cribl metric —
 * `pipe.out_events / pipe.in_events` — just applied as a multiplier to the chained-in value rather
 * than trusted as an independent absolute number). A component's card/drawer headline is the SUM
 * of its own per-source rows, not a separately-fetched aggregate.
 *
 * Two exceptions, both explicit: a Source's own OUT is its IN, copied verbatim (no ratio — a
 * Source's own "in" already is what it hands onward). A Destination's own **headline** stays the
 * real, independently-measured `total.out_events`/`total.out_bytes` for that destination (not
 * chain-derived) — real per-destination data is strictly better than a chain-derived guess, and
 * this is also the only viable answer for a Destination reached only through an Output Router,
 * whose own internal fan-out has no per-source attribution Cribl can report at all. The
 * Destination's own Sources *table* is still chain-derived, independent of its headline (the two
 * numbers are not required to reconcile exactly — same "un-attributed remainder" tradeoff this
 * whole model already accepts elsewhere).
 *
 * A source reaching more than one downstream path (a non-final rule match, or two rules both
 * matching) gets its **full** upstream OUT value at *each* path, not a split share — genuine
 * Cribl duplication (the same events really are processed more than once), so a source's own
 * total no longer sums cleanly across every table it appears in app-wide, by design.
 *
 * **Bytes are scoped down to Source and Destination only** (their own aggregate headline, plus —
 * for Destination specifically — a real per-source breakdown, since `route.in_bytes` split by
 * `route`+`input` is the one place a genuine per-source bytes figure exists at all). Every other
 * component kind (Pre-Processing/Pipeline/Post-Processing/Route rule/Output Router) is
 * events-only now — bytes for those either don't exist (`pipe.*_bytes` is absent from Cribl's
 * catalog entirely, confirmed live) or aren't worth the added complexity of a second, less-real
 * derivation chain for what's now a de-emphasized unit.
 *
 * **Chain propagation** (`propagateChain`): a pipeline that hands off via the Chain function is a
 * mid-stream stage, not a real terminus (see `topologyConfigOnly.ts`'s own matching edge-redirect
 * for the graph-structure half of this). Its own chain target gets its own real `byNodeId` entry —
 * IN chained from the source pipeline's own OUT, same propagation rule as every other stage — and
 * every downstream reader (a Post-Processing Pipeline's own IN, a Destination's own Sources table)
 * reads `downstreamOutByPid` (the chain's real final OUT) rather than the chain-source pipeline's
 * own `pipelineOutByPid` entry directly, so a chained pipeline's own card stays showing its own
 * real stats while what it *hands downstream* correctly reflects the chain's actual end.
 */

function metricsKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function sum(record: Record<string, number>): number {
  return Object.values(record).reduce((s, v) => s + v, 0);
}

/** Filters a metrics-key-keyed record down to just the keys `effectiveKeys` allows — `undefined`
 *  (no cascading correction computed for this rule, shouldn't normally happen) passes the record
 *  through unchanged rather than silently zeroing it out. */
function filterByEffectiveKeys(record: Record<string, number>, effectiveKeys: Set<string> | undefined): Record<string, number> {
  if (!effectiveKeys) return record;
  const out: Record<string, number> = {};
  for (const key of Object.keys(record)) if (effectiveKeys.has(key)) out[key] = record[key];
  return out;
}

/** A component's own real, observed reduction ratio — 0 (not 1) when its own "in" is unknown or
 *  zero, so an unmeasured component never silently claims a fabricated 1:1 pass-through. Since the
 *  ratio only ever multiplies an already-zero chained-in value in that same case, the choice of
 *  0 vs. 1 has no numeric effect there — 0 is kept only for consistency with this file's own prior
 *  convention. */
function ratioOf(totals: { in?: number; out?: number } | undefined): number {
  return totals?.in ? (totals.out ?? 0) / totals.in : 0;
}

interface SourceShare {
  sourceNodeId: string;
  label: string;
  /** Chain-propagated IN for this source at this component — whatever the immediately-upstream
   *  component's own OUT was for this same source (or, for a Route rule row, the real
   *  `route.in_events` breakdown directly — rule rows are unchanged by this redesign). */
  inEvents: number;
  /** `inEvents` scaled by this component's own real ratio (`ratioOf`) — derived, never a directly
   *  measured per-source figure, since Cribl has no per-source breakdown on the output side of
   *  anything. */
  outEvents: number;
  /** Destination rows only — a real per-source bytes breakdown (`route.in_bytes` split by
   *  `route`+`input`, or a QuickConnect leg's own real `total.in_bytes`). `undefined` everywhere
   *  else — bytes are scoped to Source/Destination only, per explicit direction. */
  inBytes?: number;
  /** Destination rows only — copied from `inBytes` (a Destination's own OUT is its IN, same rule
   *  as the component-level headline), not independently derived. */
  outBytes?: number;
  /** 0-100, this source's share of the component's own total IN (events). */
  pctEvents: number;
  /** Destination rows only. */
  pctBytes?: number;
  /** This source's own last real ingest time within the selected window (bucket-resolution) —
   *  always derived from `total.in_events`, unit-independent. `undefined` if genuinely no observed
   *  traffic in the window. */
  lastEventMs?: number;
  /** Destination/Output Router rows only: which real Pipeline(s) this source's own traffic passed
   *  through to reach here. `undefined` for every other component kind. */
  pipelines?: string[];
  /** Set only on a synthetic "Multiple Sources (via <router>)" row (see the Output Router ->
   *  target-destination propagation pass below) — the real member source ids this row's own
   *  inferred volume could honestly be any mix of, since Cribl gives no per-target breakdown
   *  within a Router's own internal fan-out. `FlowCanvas.tsx`'s `sourceIdsOfNode` unions these
   *  in (instead of the row's own placeholder `sourceNodeId`) so the connecting line still colors
   *  correctly and a hover on any one of these real sources still includes this row's own
   *  destination — the same "don't hide a possibly-real connection just because it can't be
   *  pinned to one exact source" philosophy this app already applies elsewhere. `undefined` for
   *  every real, singly-attributed row (the normal case), which already matches correctly via its
   *  own `sourceNodeId` alone. */
  attributedSourceIds?: string[];
}

export interface ComponentStats {
  /** `undefined` means "no real (or derivable) metric applies here." Rendered as "n/a" in the
   *  drawer when genuinely `undefined` — the card's own simpler headline defaults a missing value
   *  to 0 instead, by separate explicit direction. */
  inEvents?: number;
  outEvents?: number;
  /** Source/Destination kinds only — `undefined` everywhere else, since bytes are no longer
   *  computed at all for Pre-Processing/Pipeline/Post-Processing/Route rule/Output Router. */
  inBytes?: number;
  outBytes?: number;
  /** Pipeline-role kinds only — real `pipe.err_events` (a genuine Function/processing error this
   *  Pipeline has thrown, distinct from an intentional volume drop). `undefined` for every other
   *  kind, which has no equivalent metric. */
  errEvents?: number;
  sources: SourceShare[];
}

export interface SignalPathMetrics {
  /** Keyed by real `GraphNode.id`. */
  byNodeId: Map<string, ComponentStats>;
  /** Keyed by real Route rule id (a rule row is its own component — see the connection-drawing
   *  rule this page already follows — but rows aren't `GraphNode`s of their own). */
  byRuleId: Map<string, ComponentStats>;
}

/** Builds one component's own per-source table, events only. `componentTotals` (already-computed
 *  chain-sum IN + ratio-derived OUT) drives each row's own OUT (`in * out/in`) and the Share %
 *  denominator. */
function shareRowsEvents(
  eventsByKey: Record<string, number>,
  inputIdByMetricsKey: Map<string, string>,
  lastEventByKey: Record<string, number>,
  componentTotals: { inEvents: number; outEvents: number },
): SourceShare[] {
  const ratio = componentTotals.inEvents > 0 ? componentTotals.outEvents / componentTotals.inEvents : 0;
  const rows: SourceShare[] = [];
  for (const key of Object.keys(eventsByKey)) {
    const sourceId = inputIdByMetricsKey.get(key);
    if (!sourceId) continue;
    const inEvents = eventsByKey[key] ?? 0;
    rows.push({
      sourceNodeId: `source:${sourceId}`,
      label: sourceId,
      inEvents,
      outEvents: inEvents * ratio,
      pctEvents: componentTotals.inEvents > 0 ? (inEvents / componentTotals.inEvents) * 100 : 0,
      lastEventMs: lastEventByKey[key],
    });
  }
  return rows.sort((a, b) => b.inEvents - a.inEvents);
}

/** Destination-only: builds the per-source table with both a chain-derived events figure (IN=OUT,
 *  the Destination's own copy-not-derive rule) and a real, directly-measured bytes breakdown. */
function shareRowsDestination(
  eventsByKey: Record<string, number>,
  bytesByKey: Record<string, number>,
  inputIdByMetricsKey: Map<string, string>,
  lastEventByKey: Record<string, number>,
  pipelinesByKey: Map<string, Set<string>>,
): SourceShare[] {
  const keys = new Set([...Object.keys(eventsByKey), ...Object.keys(bytesByKey)]);
  const totalEvents = sum(eventsByKey);
  const totalBytes = sum(bytesByKey);
  const rows: SourceShare[] = [];
  for (const key of keys) {
    const sourceId = inputIdByMetricsKey.get(key);
    if (!sourceId) continue;
    const inEvents = eventsByKey[key] ?? 0;
    const inBytes = bytesByKey[key] ?? 0;
    const pipelineSet = pipelinesByKey.get(key);
    rows.push({
      sourceNodeId: `source:${sourceId}`,
      label: sourceId,
      inEvents,
      outEvents: inEvents, // Destination OUT = IN, copied — same rule as its own headline.
      inBytes,
      outBytes: inBytes,
      pctEvents: totalEvents > 0 ? (inEvents / totalEvents) * 100 : 0,
      pctBytes: totalBytes > 0 ? (inBytes / totalBytes) * 100 : 0,
      lastEventMs: lastEventByKey[key],
      pipelines: pipelineSet ? [...pipelineSet].sort() : undefined,
    });
  }
  return rows.sort((a, b) => b.inEvents - a.inEvents);
}

/** Records, for one source metrics-key, that its traffic reached the current component via
 *  `pipelineId` — used to build the Destination table's own Pipeline column. */
function recordPipelineForKeys(target: Map<string, Set<string>>, keys: Iterable<string>, pipelineId: string) {
  for (const key of keys) {
    if (!target.has(key)) target.set(key, new Set());
    target.get(key)!.add(pipelineId);
  }
}

export async function fetchConfigOnlyMetrics(
  groupId: string,
  earliest: number,
  latest: number,
  bundle: RawTopologyBundle,
  graph: FlowGraph,
): Promise<SignalPathMetrics> {
  const [sourceEvents, sourceBytes, destEvents, destBytes, routeEvents, pipeEvents, breakdownEvents, breakdownBytes, lastIngest] = await Promise.all([
    fetchEndpointVolumeTotals({ groupId, splitBy: 'input', unit: 'events', earliest, latest }),
    fetchEndpointVolumeTotals({ groupId, splitBy: 'input', unit: 'bytes', earliest, latest }),
    fetchEndpointVolumeTotals({ groupId, splitBy: 'output', unit: 'events', earliest, latest }),
    fetchEndpointVolumeTotals({ groupId, splitBy: 'output', unit: 'bytes', earliest, latest }),
    fetchRouteVolumeTotals({ groupId, unit: 'events', earliest, latest }),
    fetchPipelineVolumeTotals({ groupId, earliest, latest }),
    fetchRouteSourceBreakdown({ groupId, unit: 'events', earliest, latest }),
    fetchRouteSourceBreakdown({ groupId, unit: 'bytes', earliest, latest }),
    fetchLastIngestTimes({ groupId, earliest, latest }),
  ]);

  const outputsById = new Map<string, RawOutput>(bundle.outputs.map((o) => [o.id, o]));
  const inputIdByMetricsKey = new Map(bundle.inputs.map((i) => [metricsKey(i.type, i.id), i.id]));
  const inputByMetricsKey = new Map(bundle.inputs.map((i) => [metricsKey(i.type, i.id), i]));
  const pipelinesById = new Map(bundle.pipelines.map((p) => [p.id, p]));

  const byNodeId = new Map<string, ComponentStats>();
  const byRuleId = new Map<string, ComponentStats>();

  // --- Real, per-rule FINAL cascading — ported from the real Signal Path page's own
  //     `lib/topology.ts` (`claimedSourceKeys`/`effectiveSourceKeysByRule`), never imported from
  //     directly (that file's own graph model is a different shape) but reproducing the identical
  //     logic against this file's own `breakdownEvents`. Cribl's raw `route.in_events` (split by
  //     route+input) reports, independently per rule, every Source whose events *match* that
  //     rule's own filter — not "how many events this rule actually received after real FINAL
  //     dispatch was applied." Two enabled rules can share or overlap a filter; a `final:true`
  //     earlier rule genuinely claims that Source's traffic and stops it from ever reaching a rule
  //     below, even though Cribl's own raw per-rule breakdown still shows it matching there too.
  //     `claimedSourceKeys` accumulates the metricsKey-format keys an earlier *enabled* `final`
  //     rule has already claimed (reset per table, matching Cribl's own per-table evaluation
  //     scope); every downstream use of a rule's own breakdown below — its own Sources table, the
  //     Pipeline/Post-Processing chain aggregation, the Destination Sources table — reads through
  //     `effectiveKeysByRule` instead of the raw breakdown directly. A disabled rule's own raw
  //     breakdown is discarded entirely the same way (Cribl reports live-looking numbers for a
  //     disabled rule too — confirmed live in the real page's own history — so without this, a
  //     disabled rule's phantom traffic would otherwise still propagate downstream). ---
  const claimedSourceKeys = new Set<string>();
  const effectiveKeysByRule = new Map<string, Set<string>>();
  for (const table of bundle.routeTables) {
    claimedSourceKeys.clear();
    for (const rule of table.routes) {
      const rawKeys = Object.keys(breakdownEvents[rule.id] ?? {});
      const effectiveKeys = rule.disabled ? new Set<string>() : new Set(rawKeys.filter((k) => !claimedSourceKeys.has(k)));
      effectiveKeysByRule.set(rule.id, effectiveKeys);
      if (!rule.disabled && rule.final) for (const k of effectiveKeys) claimedSourceKeys.add(k);
    }
  }

  // --- Sources: the chain's real root. OUT = IN, copied — a Source's own "in" already is what it
  //     hands onward, no separate counter exists. ---
  for (const input of bundle.inputs) {
    const key = metricsKey(input.type, input.id);
    const inE = sourceEvents[key]?.in;
    const inB = sourceBytes[key]?.in;
    byNodeId.set(`source:${input.id}`, { inEvents: inE, outEvents: inE, inBytes: inB, outBytes: inB, sources: [] });
  }

  // --- Destinations / Output Router headline: the real, independently-measured
  //     `total.out_events`/`bytes` — deliberately NOT chain-derived (see this file's own top
  //     doc comment for why). An Output Router has no real metric of its own — rolled up from its
  //     own real targets instead, same as before. ---
  for (const output of bundle.outputs) {
    if (output.type === 'default' && resolveOutputId(outputsById, output.id) !== output.id) continue;
    if (output.type === 'router') continue; // handled separately below, once every Destination node exists.
    const key = metricsKey(output.type, output.id);
    const events = destEvents[key]?.out;
    const bytes = destBytes[key]?.out;
    byNodeId.set(`destination:${output.id}`, { inEvents: events, outEvents: events, inBytes: bytes, outBytes: bytes, sources: [] });
  }
  for (const node of graph.nodes) {
    if (node.kind !== 'outputRouter' || !node.routerRuleIds) continue;
    let inE: number | undefined, outE: number | undefined, inB: number | undefined, outB: number | undefined;
    for (const targetId of node.routerRuleIds) {
      const target = byNodeId.get(`destination:${targetId}`);
      if (!target) continue;
      inE = (inE ?? 0) + (target.inEvents ?? 0);
      outE = (outE ?? 0) + (target.outEvents ?? 0);
      inB = (inB ?? 0) + (target.inBytes ?? 0);
      outB = (outB ?? 0) + (target.outBytes ?? 0);
    }
    byNodeId.set(node.id, { inEvents: inE, outEvents: outE, inBytes: inB, outBytes: outB, sources: [] });
  }

  // --- Route rule rows: unchanged by this redesign — Routes itself is a pure dispatch decision,
  //     not a transformation, so its own rows keep showing the real, directly-measured
  //     `route.in_events`/`route.out_events` and the real per-source breakdown, exactly as before.
  //     Events only now — bytes removed (rule rows aren't in the Source/Destination exception). ---
  for (const table of bundle.routeTables) {
    for (const rule of table.routes) {
      const ev = routeEvents[rule.id];
      const totals = { inEvents: ev?.in ?? 0, outEvents: ev?.out ?? 0 };
      const effectiveEvents = filterByEffectiveKeys(breakdownEvents[rule.id] ?? {}, effectiveKeysByRule.get(rule.id));
      byRuleId.set(rule.id, {
        inEvents: ev?.in,
        outEvents: ev?.out,
        sources: shareRowsEvents(effectiveEvents, inputIdByMetricsKey, lastIngest, totals),
      });
    }
  }

  // --- Chain propagation, in dependency order: Pre-Processing -> Pipeline -> Post-Processing ->
  //     Destination. Each stage's own IN, per source, is looked up via `upstreamOutFor`/the
  //     previous stage's own recorded OUT map — never re-derived from `route.in_events` directly
  //     (that metric is still used, but only to know *which* sources reach a given rule at all —
  //     the "structural attribution," unaffected by this redesign). ---

  const prePipelineOutByPid = new Map<string, Record<string, number>>();
  const prePipelineSources = new Map<string, { id: string; type: string }[]>();
  for (const input of bundle.inputs) {
    if (!input.pipeline) continue;
    if (!prePipelineSources.has(input.pipeline)) prePipelineSources.set(input.pipeline, []);
    prePipelineSources.get(input.pipeline)!.push(input);
  }
  for (const [pid, sources] of prePipelineSources) {
    const nodeId = `prePipeline:${pid}`;
    if (!graph.nodes.some((n) => n.id === nodeId)) continue;
    const ratio = ratioOf(pipeEvents[pid]);
    const evRecord: Record<string, number> = {};
    for (const s of sources) {
      const key = metricsKey(s.type, s.id);
      evRecord[key] = sourceEvents[key]?.in ?? 0; // Source's own OUT = its real IN, copied.
    }
    const inTotal = sum(evRecord);
    const outTotal = inTotal * ratio;
    byNodeId.set(nodeId, {
      inEvents: inTotal,
      outEvents: outTotal,
      errEvents: pipeEvents[pid]?.err,
      sources: shareRowsEvents(evRecord, inputIdByMetricsKey, lastIngest, { inEvents: inTotal, outEvents: outTotal }),
    });
    const outRecord: Record<string, number> = {};
    for (const [k, v] of Object.entries(evRecord)) outRecord[k] = v * ratio;
    prePipelineOutByPid.set(pid, outRecord);
  }

  /** Whatever reached Routes for this source — Pre-Processing's own derived OUT if configured
   *  (falling back to the Source's own OUT if that pipeline had no real data), otherwise the
   *  Source's own OUT directly. Routes itself never appears as a stage here — it's a pure
   *  pass-through, per explicit direction (no aggregate of its own needed). */
  function upstreamOutFor(key: string): number {
    const input = inputByMetricsKey.get(key);
    if (input?.pipeline) {
      const rec = prePipelineOutByPid.get(input.pipeline);
      if (rec && key in rec) return rec[key];
    }
    return sourceEvents[key]?.in ?? 0;
  }

  /** Walks a pipeline's own Chain-function hand-off (`chainedPipelineId`, via `findChainTarget`)
   *  hop by hop, giving each real chain-target pipeline its own real `byNodeId` entry — IN is
   *  whatever the immediately-upstream pipeline in the chain handed off (its own OUT), the exact
   *  same "whatever the previous stage's own OUT was" propagation rule every other stage in this
   *  file already follows; OUT is that IN scaled by the target's own real, observed `pipe.
   *  out_events / pipe.in_events` ratio. Without this, a pipeline reached *only* via chain (never
   *  directly configured as any rule's own `rule.pipeline`) never gets a `byNodeId` entry at all —
   *  its own card/drawer would show nothing, and `FlowCanvas.tsx`'s own `chain`-kind edge
   *  coloring (`edgeSourceIds`, which falls back to comparing both endpoints' real attributed
   *  sources for an edge with no `routeIds`) would always compute an empty intersection and render
   *  the chain link grey regardless of how much real data is actually flowing through it.
   *
   *  Returns the real final pipeline id in the chain (`pid` itself if it doesn't chain at all) and
   *  its own real per-source OUT record — callers use this in place of `pid`'s own OUT wherever
   *  they'd otherwise look up what `pid` hands to its own downstream stage (a Post-Processing
   *  Pipeline's own IN, a Destination's own Sources table), matching the identical redirect
   *  `topologyConfigOnly.ts`'s own `resolveChainEndPipeId` already applies to the edge itself. A
   *  cycle (a genuinely broken/circular chain config) just stops at whichever pipeline is first
   *  revisited, rather than looping forever. */
  function propagateChain(pid: string, outRecord: Record<string, number>): { finalPid: string; finalOut: Record<string, number> } {
    const visited = new Set<string>();
    let currentPid = pid;
    let currentOut = outRecord;
    while (!visited.has(currentPid)) {
      visited.add(currentPid);
      const pipeline = pipelinesById.get(currentPid);
      const target = pipeline ? findChainTarget(pipeline) : undefined;
      if (!target || target === currentPid) break;
      const nodeId = `pipeline:${target}`;
      if (!graph.nodes.some((n) => n.id === nodeId)) break;
      const ratio = ratioOf(pipeEvents[target]);
      const inTotal = sum(currentOut);
      const outTotal = inTotal * ratio;
      byNodeId.set(nodeId, {
        inEvents: inTotal,
        outEvents: outTotal,
        errEvents: pipeEvents[target]?.err,
        sources: shareRowsEvents(currentOut, inputIdByMetricsKey, lastIngest, { inEvents: inTotal, outEvents: outTotal }),
      });
      const nextOut: Record<string, number> = {};
      for (const [k, v] of Object.entries(currentOut)) nextOut[k] = v * ratio;
      currentPid = target;
      currentOut = nextOut;
    }
    return { finalPid: currentPid, finalOut: currentOut };
  }

  /** Every real pipeline id in `pid`'s own chain, `pid` itself first — a plain listing, no metrics
   *  side effects (unlike `propagateChain` above), used only to attribute a Destination's own
   *  Sources-table "Pipeline" column across the *whole* real chain a source's traffic passed
   *  through, not just its own first hop. */
  function chainPathFrom(pid: string): string[] {
    const path = [pid];
    const visited = new Set([pid]);
    let current = pid;
    while (true) {
      const pipeline = pipelinesById.get(current);
      const target = pipeline ? findChainTarget(pipeline) : undefined;
      if (!target || visited.has(target)) break;
      path.push(target);
      visited.add(target);
      current = target;
    }
    return path;
  }

  const pipelineToRules = new Map<string, { id: string }[]>();
  for (const table of bundle.routeTables) {
    for (const rule of table.routes) {
      if (!pipelineToRules.has(rule.pipeline)) pipelineToRules.set(rule.pipeline, []);
      pipelineToRules.get(rule.pipeline)!.push(rule);
    }
  }
  const pipelineOutByPid = new Map<string, Record<string, number>>();
  // What `pid` actually hands to its own *next* stage — identical to `pipelineOutByPid.get(pid)`
  // for a pipeline that doesn't chain, but the chain's real final OUT for one that does (see
  // `propagateChain` above). Every downstream reader (Post-Processing's own IN, a Destination's
  // own Sources table) reads this map, never `pipelineOutByPid` directly, so a chained pipeline's
  // own real stats (used for its own card) and what it propagates onward never get confused.
  const downstreamOutByPid = new Map<string, Record<string, number>>();
  for (const [pid, rules] of pipelineToRules) {
    const nodeId = `pipeline:${pid}`;
    if (!graph.nodes.some((n) => n.id === nodeId)) continue;
    const ratio = ratioOf(pipeEvents[pid]);
    const evAgg: Record<string, number> = {};
    for (const rule of rules) {
      const effectiveKeys = effectiveKeysByRule.get(rule.id);
      for (const key of Object.keys(breakdownEvents[rule.id] ?? {})) {
        // A source already claimed by an earlier enabled `final` rule never structurally reaches
        // this rule at all — its own upstream value shouldn't propagate into this Pipeline for a
        // rule it can't actually dispatch through.
        if (effectiveKeys && !effectiveKeys.has(key)) continue;
        // Full upstream value at every path this source reaches — genuine non-final duplication,
        // per explicit direction, not a proportional split.
        evAgg[key] = (evAgg[key] ?? 0) + upstreamOutFor(key);
      }
    }
    const inTotal = sum(evAgg);
    const outTotal = inTotal * ratio;
    byNodeId.set(nodeId, {
      inEvents: inTotal,
      outEvents: outTotal,
      errEvents: pipeEvents[pid]?.err,
      sources: shareRowsEvents(evAgg, inputIdByMetricsKey, lastIngest, { inEvents: inTotal, outEvents: outTotal }),
    });
    const outRecord: Record<string, number> = {};
    for (const [k, v] of Object.entries(evAgg)) outRecord[k] = v * ratio;
    pipelineOutByPid.set(pid, outRecord);
    downstreamOutByPid.set(pid, propagateChain(pid, outRecord).finalOut);
  }

  const postPipelineToRules = new Map<string, { id: string; pipeline: string }[]>();
  for (const table of bundle.routeTables) {
    for (const rule of table.routes) {
      const resolved = resolveOutputId(outputsById, rule.output);
      const target = outputsById.get(resolved);
      if (!target?.pipeline) continue;
      if (!postPipelineToRules.has(target.pipeline)) postPipelineToRules.set(target.pipeline, []);
      postPipelineToRules.get(target.pipeline)!.push(rule);
    }
  }
  const postPipelineOutByPid = new Map<string, Record<string, number>>();
  for (const [pid, rules] of postPipelineToRules) {
    const nodeId = `postPipeline:${pid}`;
    if (!graph.nodes.some((n) => n.id === nodeId)) continue;
    const ratio = ratioOf(pipeEvents[pid]);
    const evAgg: Record<string, number> = {};
    for (const rule of rules) {
      const mainOut = downstreamOutByPid.get(rule.pipeline) ?? {};
      const effectiveKeys = effectiveKeysByRule.get(rule.id);
      for (const key of Object.keys(breakdownEvents[rule.id] ?? {})) {
        if (effectiveKeys && !effectiveKeys.has(key)) continue;
        evAgg[key] = (evAgg[key] ?? 0) + (key in mainOut ? mainOut[key] : upstreamOutFor(key));
      }
    }
    const inTotal = sum(evAgg);
    const outTotal = inTotal * ratio;
    byNodeId.set(nodeId, {
      inEvents: inTotal,
      outEvents: outTotal,
      errEvents: pipeEvents[pid]?.err,
      sources: shareRowsEvents(evAgg, inputIdByMetricsKey, lastIngest, { inEvents: inTotal, outEvents: outTotal }),
    });
    const outRecord: Record<string, number> = {};
    for (const [k, v] of Object.entries(evAgg)) outRecord[k] = v * ratio;
    postPipelineOutByPid.set(pid, outRecord);
  }

  // --- Destination / Output Router Sources table: chain-derived events (IN=OUT, Destination's
  //     own copy rule) plus a real, directly-measured bytes breakdown — the one place besides
  //     Source itself that keeps bytes at all. Every rule resolving to this Destination directly
  //     (never fanned out through a router's own real targets — see this file's own top doc
  //     comment on why per-source attribution can't cross that boundary), plus any QuickConnect
  //     Source landing here directly (100% of its own real OUT, no rule involved). ---
  const destAgg = new Map<string, { events: Record<string, number>; bytes: Record<string, number>; pipelines: Map<string, Set<string>> }>();
  const ensureDestAgg = (id: string) => {
    if (!destAgg.has(id)) destAgg.set(id, { events: {}, bytes: {}, pipelines: new Map() });
    return destAgg.get(id)!;
  };
  for (const table of bundle.routeTables) {
    for (const rule of table.routes) {
      const resolved = resolveOutputId(outputsById, rule.output);
      const target = outputsById.get(resolved);
      const agg = ensureDestAgg(resolved);
      const upstream = target?.pipeline ? (postPipelineOutByPid.get(target.pipeline) ?? {}) : (downstreamOutByPid.get(rule.pipeline) ?? {});
      const effectiveKeys = effectiveKeysByRule.get(rule.id);
      const keys = Object.keys(breakdownEvents[rule.id] ?? {}).filter((k) => !effectiveKeys || effectiveKeys.has(k));
      const byteKeys = Object.keys(breakdownBytes[rule.id] ?? {}).filter((k) => !effectiveKeys || effectiveKeys.has(k));
      for (const key of keys) {
        agg.events[key] = (agg.events[key] ?? 0) + (key in upstream ? upstream[key] : upstreamOutFor(key));
      }
      for (const key of byteKeys) agg.bytes[key] = (agg.bytes[key] ?? 0) + (breakdownBytes[rule.id]?.[key] ?? 0);
      // The full real chain, not just `rule.pipeline`'s own first hop — a source whose traffic
      // passed through a Chain hand-off genuinely traveled through every pipeline in the chain.
      for (const pid of chainPathFrom(rule.pipeline)) {
        recordPipelineForKeys(agg.pipelines, keys, pid);
        recordPipelineForKeys(agg.pipelines, byteKeys, pid);
      }
    }
  }
  for (const input of bundle.inputs) {
    for (const conn of input.connections ?? []) {
      const resolved = resolveOutputId(outputsById, conn.output);
      const agg = ensureDestAgg(resolved);
      const key = metricsKey(input.type, input.id);
      agg.events[key] = (agg.events[key] ?? 0) + (sourceEvents[key]?.in ?? 0);
      agg.bytes[key] = (agg.bytes[key] ?? 0) + (sourceBytes[key]?.in ?? 0);
      if (conn.pipeline) {
        if (!agg.pipelines.has(key)) agg.pipelines.set(key, new Set());
        agg.pipelines.get(key)!.add(conn.pipeline);
      }
    }
  }
  for (const [destId, agg] of destAgg) {
    const nodeId = `destination:${destId}`;
    const existing = byNodeId.get(nodeId);
    if (!existing) continue;
    existing.sources = shareRowsDestination(agg.events, agg.bytes, inputIdByMetricsKey, lastIngest, agg.pipelines);
  }

  // --- Output Router -> its real targets: infer per-target source attribution from the residual
  //     between each target's own real, independently-measured headline (`inEvents`/`inBytes` —
  //     never chain-derived, so this is real ground truth, not an estimate) and whatever it
  //     already has explicitly attributed above (a direct Route rule/QuickConnect pointed at it,
  //     unrelated to the router). `destAgg` never walks a router's own real targets at all — its
  //     two loops only ever resolve `rule.output`/`conn.output` through `resolveOutputId`, which
  //     doesn't unwrap a `router`-type output to its own individual targets — so a Destination
  //     reached only through a Router would otherwise keep a permanently empty `sources` array
  //     despite a real, nonzero headline.
  //
  //     Two cases, per explicit direction:
  //     - The router itself has exactly ONE real source in its own attribution (`routerSources`,
  //       already computed above from `destAgg.get(routerId)` the same way any other Destination's
  //       rows are) — source identity is unambiguous regardless of how many targets the router has
  //       or how it splits between them, so the residual is attributed to that one real, named
  //       source exactly, including the real Pipeline(s) it passed through to reach the router.
  //     - More than one real source feeds the router — which one(s) specifically reached *this*
  //       target isn't knowable (Cribl has no per-target breakdown within a Router's own internal
  //       fan-out), so rather than guess a proportional split, this shows one honest, unattributed
  //       "Multiple Sources (via <router>)" row instead — Pipeline reads "N/A" (a target's traffic
  //       could have arrived via any of the router's own feeding pipelines, so no single one is
  //       attributable either) — with `attributedSourceIds` carrying every real member source, so
  //       the connecting line still colors correctly and a hover on any contributing source still
  //       includes this row (see that field's own doc comment).
  //
  //     Every row's own `outEvents`/`outBytes` defaults to the same value as `inEvents`/`inBytes`
  //     (as if healthy) — `applyBlockedDestinationCorrection` (below, run as a later pass once real
  //     per-worker status is available) already zeroes every row's own `outEvents`/`outBytes`
  //     uniformly, including these, the instant the target is confirmed genuinely stuck, so no
  //     separate blocked-check is needed here.
  //
  //     A residual that clamps to zero (explicit attribution already accounts for the whole real
  //     headline) adds no row at all — the same "don't render a phantom zero-data row" convention
  //     this app already follows everywhere else. A residual can also come out slightly negative
  //     from ordinary cross-metric measurement noise (the headline and the explicit breakdown are
  //     two independently-sampled real queries) — clamped to zero rather than shown as a
  //     nonsensical negative row.
  for (const node of graph.nodes) {
    if (node.kind !== 'outputRouter' || !node.routerRuleIds) continue;
    const routerSources = byNodeId.get(node.id)?.sources ?? [];
    if (routerSources.length === 0) continue;

    const lastEventMs = routerSources.reduce<number | undefined>(
      (max, s) => (s.lastEventMs === undefined ? max : max === undefined ? s.lastEventMs : Math.max(max, s.lastEventMs)),
      undefined,
    );

    for (const targetId of node.routerRuleIds) {
      const targetNodeId = `destination:${targetId}`;
      const targetStats = byNodeId.get(targetNodeId);
      if (!targetStats) continue;

      const explicitEvents = targetStats.sources.reduce((s, r) => s + r.inEvents, 0);
      const explicitBytes = targetStats.sources.reduce((s, r) => s + (r.inBytes ?? 0), 0);
      const residualEvents = Math.max(0, (targetStats.inEvents ?? 0) - explicitEvents);
      const residualBytes = Math.max(0, (targetStats.inBytes ?? 0) - explicitBytes);
      if (residualEvents <= 0 && residualBytes <= 0) continue;

      const routerRow: SourceShare =
        routerSources.length === 1
          ? { ...routerSources[0], inEvents: residualEvents, outEvents: residualEvents, inBytes: residualBytes, outBytes: residualBytes }
          : {
              sourceNodeId: `router-multi:${node.id}:${targetId}`,
              label: `Multiple Sources (via ${node.label})`,
              inEvents: residualEvents,
              outEvents: residualEvents,
              inBytes: residualBytes,
              outBytes: residualBytes,
              pctEvents: 0, // recomputed below, alongside every other row on this target.
              pctBytes: 0,
              lastEventMs,
              pipelines: undefined, // N/A -- more than one real source feeds the router, no single pipeline is attributable.
              attributedSourceIds: routerSources.map((s) => s.sourceNodeId),
            };

      // Once a router-derived row exists, every row on this target is re-expressed as "share of
      // the destination's own real total" (explicit rows + the new residual necessarily sum to
      // exactly that real total, by construction) — a more coherent Share % than the prior
      // explicit-only-sum denominator `shareRowsDestination` used when this destination had no
      // router involvement at all.
      const totalEvents = targetStats.inEvents ?? 0;
      const totalBytes = targetStats.inBytes ?? 0;
      const newSources = [...targetStats.sources, routerRow]
        .map((s) => ({
          ...s,
          pctEvents: totalEvents > 0 ? (s.inEvents / totalEvents) * 100 : s.pctEvents,
          pctBytes: totalBytes > 0 && s.inBytes !== undefined ? (s.inBytes / totalBytes) * 100 : s.pctBytes,
        }))
        .sort((a, b) => b.inEvents - a.inEvents);
      byNodeId.set(targetNodeId, { ...targetStats, sources: newSources });
    }
  }

  return { byNodeId, byRuleId };
}

/**
 * Real per-worker "is this Destination genuinely stuck" signal (`lib/blockedOutput.ts`, shared
 * read-only with the real Signal Path page — see that file's own doc comment for the exact
 * mechanism: real `Red` health *and* a buffered count that exactly equals a "sent" count Cribl
 * freezes right before a connection blocks), applied as a pure post-processing pass over an
 * already-fetched `SignalPathMetrics` rather than baked into `fetchConfigOnlyMetrics` itself. The real
 * page's own history found a genuine bug doing it the other way: per-worker status resolves on its
 * own independent timeline, separate from the metrics fetch — a correction baked into the fetch
 * itself would silently use whichever value happened to exist the moment the fetch *started*,
 * almost always before real worker status has arrived. Applying it here, as a cheap `useMemo` in
 * the page component, means it's always evaluated against the current value.
 *
 * Every metric this model can report for a Destination's own OUT figure reflects what was *handed
 * to* the output stage, not what actually left it — so a stuck Destination's own `outEvents`/
 * `outBytes` (its own card headline, and every one of its Sources-table rows) are zeroed, while
 * `inEvents`/`inBytes` (what was genuinely handed to it) are left alone. An Output Router rolled up
 * from its own real targets is re-summed from those targets' own (now-corrected) OUT values, in a
 * second pass once every real Destination has already been corrected — the same two-pass order
 * `fetchConfigOnlyMetrics` itself already uses to build that rollup in the first place.
 */
export function applyBlockedDestinationCorrection(
  metrics: SignalPathMetrics,
  graph: FlowGraph,
  workerStatusByNodeId: Map<string, WorkerStatusRow[]> | undefined,
): SignalPathMetrics {
  if (!workerStatusByNodeId || workerStatusByNodeId.size === 0) return metrics;

  const zeroOut = (stats: ComponentStats): ComponentStats => ({
    ...stats,
    outEvents: 0,
    outBytes: stats.outBytes !== undefined ? 0 : undefined,
    sources: stats.sources.map((s) => ({ ...s, outEvents: 0, outBytes: s.outBytes !== undefined ? 0 : undefined })),
  });

  const byNodeId = new Map(metrics.byNodeId);
  let changed = false;

  for (const node of graph.nodes) {
    if (node.kind !== 'destination') continue;
    const stats = byNodeId.get(node.id);
    if (!stats) continue;
    if (isDestinationStuck(workerStatusByNodeId.get(node.id))) {
      byNodeId.set(node.id, zeroOut(stats));
      changed = true;
    }
  }

  for (const node of graph.nodes) {
    if (node.kind !== 'outputRouter' || !node.routerRuleIds) continue;
    const stats = byNodeId.get(node.id);
    if (!stats) continue;
    let outE: number | undefined;
    let outB: number | undefined;
    let anyTarget = false;
    for (const targetId of node.routerRuleIds) {
      const target = byNodeId.get(`destination:${targetId}`);
      if (!target) continue;
      anyTarget = true;
      outE = (outE ?? 0) + (target.outEvents ?? 0);
      outB = target.outBytes !== undefined ? (outB ?? 0) + target.outBytes : outB;
    }
    if (anyTarget && (outE !== stats.outEvents || outB !== stats.outBytes)) {
      byNodeId.set(node.id, { ...stats, outEvents: outE, outBytes: outB });
      changed = true;
    }
  }

  return changed ? { byNodeId, byRuleId: metrics.byRuleId } : metrics;
}

