import type { RawTopologyBundle, RawOutput, RawPipeline } from '../api/topology';
import type { FlowGraph, GraphEdge, GraphNode } from './types';
import { criblConfigPath } from './criblLinks';
import { resolveChainTarget } from './crossDeploymentChain';

/**
 * Signal Path's own graph builder — deliberately separate from `buildFlowGraph` in `lib/topology.ts`,
 * which this file never imports from or modifies. Builds nodes and edges purely from the 6 static
 * config endpoints already fetched by `fetchTopologyBundle` (routes/pipelines/inputs/outputs) —
 * no metrics query, no live source attribution, no health/FINAL-cascading logic. Every node's
 * `health` is a fixed placeholder ('good') so `computeLaneOrder`'s own tiering treats every
 * enabled node uniformly; only `disabled` (a real config fact) affects layout tiering or styling.
 *
 * This exists to validate the "connections buildable from config alone" answer directly: every
 * edge below corresponds 1:1 to one row of that answer's own combination table.
 *
 * A pipeline that hands off via the Chain function (`chainedPipelineId`) is a mid-stream stage,
 * not a real terminus — per direct instruction, the edge leaving that stage toward whatever's
 * next (a Post-Processing Pipeline or the Destination) is redirected to originate from the real
 * last pipeline in the chain (`resolveChainEndPipeId`, walking multiple hops if needed), never
 * from the chain's own first pipeline. The dedicated `chain`-kind edge between the two pipelines
 * is unaffected — it still exists exactly as before, so the chain hand-off itself stays visible.
 */

const NODATA_METRICS = {};

/** Mirrors `resolveOutputId` in `lib/topology.ts` exactly (kept as an independent copy — this file
 *  deliberately never imports from that one) — the built-in "default" output resolves through its
 *  own `defaultId` to the real target it forwards to, falling back to itself if `defaultId` is
 *  unset or points at a Destination that no longer exists. */
export function resolveOutputId(outputsById: Map<string, RawOutput>, id: string): string {
  const output = outputsById.get(id);
  if (output?.type === 'default' && output.defaultId && outputsById.has(output.defaultId)) {
    return output.defaultId;
  }
  return id;
}

/** Mirrors `findChainTarget` in `lib/topology.ts`: the first enabled `chain` function's own
 *  target pipeline id, if any. Exported for `topologyConfigOnlyMetrics.ts`'s own chain-propagation
 *  pass — the one other file in this pair that needs to walk the same real Chain-function config,
 *  reused rather than duplicated a third time. */
export function findChainTarget(pipeline: RawPipeline): string | undefined {
  const fn = pipeline.conf.functions?.find((f) => f.id === 'chain' && !f.disabled);
  const target = fn?.conf?.processor;
  return typeof target === 'string' && target.length > 0 ? target : undefined;
}

let seq = 0;
function makeEdge(fromId: string, toId: string, kind: GraphEdge['kind'], routeId?: string, disabled?: boolean): GraphEdge {
  seq += 1;
  return {
    id: `${fromId}=>${toId}=>${kind}#${seq}`,
    fromId,
    toId,
    kind,
    health: 'good',
    metricValue: 0,
    routeIds: routeId ? [routeId] : undefined,
    disabled,
  };
}

export function buildConfigOnlyGraph(bundle: RawTopologyBundle, workerGroupByHostname: ReadonlyMap<string, string> = new Map()): FlowGraph {
  seq = 0;
  const { groupId, routeTables, pipelines, inputs, outputs } = bundle;
  const outputsById = new Map(outputs.map((o) => [o.id, o]));
  const pipelinesById = new Map(pipelines.map((p) => [p.id, p]));
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  function ensurePipelineNode(pid: string, kind: 'prePipeline' | 'pipeline' | 'postPipeline'): string {
    const id = `${kind}:${pid}`;
    if (!nodes.has(id)) {
      const pipeline = pipelinesById.get(pid);
      nodes.set(id, {
        id,
        kind,
        label: pid,
        workerGroupId: groupId,
        health: 'good',
        metrics: NODATA_METRICS,
        raw: pipeline,
        functionCount: pipeline?.conf.functions?.length,
        chainedPipelineId: pipeline ? findChainTarget(pipeline) : undefined,
        configPath: criblConfigPath(groupId, kind, pid),
      });
    }
    return id;
  }

  /** The real pipeline that actually forwards events onward from `pid` — `pid` itself if it
   *  doesn't chain at all, otherwise the pipeline at the far end of its own Chain-function hand-off
   *  (walking multiple hops if the chain is more than one link long). A pipeline that chains into
   *  another one is a genuine mid-stream hand-off, not a real terminus — Cribl's own dispatch
   *  continues processing in the *target* pipeline, so any edge leaving `pid`'s own stage toward
   *  whatever comes next (a Post-Processing Pipeline, or the Destination directly) belongs on the
   *  chain's real end, never on `pid` itself. A cycle (a genuinely broken/circular chain config)
   *  just stops at whichever pipeline is first revisited, rather than looping forever. Always
   *  resolves to a `'pipeline'`-kind node id — matching the one, already-established convention the
   *  standalone "Pipeline -> Pipeline (Chain function)" edge loop below already uses for every
   *  chain target, so this never creates a second, differently-kinded node for the same real
   *  pipeline. */
  function resolveChainEndPipeId(pid: string): string {
    const visited = new Set<string>();
    let current = pid;
    while (!visited.has(current)) {
      visited.add(current);
      const pipeline = pipelinesById.get(current);
      const target = pipeline ? findChainTarget(pipeline) : undefined;
      if (!target || target === current) break;
      current = target;
    }
    return current;
  }

  // --- Sources, and their direct wiring (config-only: Source -> Pre -> Routes, Source -> Routes
  //     direct, or the QuickConnect bypass — see the "Connections buildable from config alone"
  //     table for the exact field driving each case). ---
  for (const input of inputs) {
    const sourceId = `source:${input.id}`;
    nodes.set(sourceId, {
      id: sourceId,
      kind: 'source',
      label: input.id,
      workerGroupId: groupId,
      health: 'good',
      metrics: NODATA_METRICS,
      disabled: input.disabled,
      refType: input.type,
      raw: input,
      configPath: criblConfigPath(groupId, 'source', input.id, input.type),
    });

    const quickConnections = input.connections ?? [];
    if (quickConnections.length > 0) {
      for (const conn of quickConnections) {
        const resolvedOut = resolveOutputId(outputsById, conn.output);
        const destId = `destination:${resolvedOut}`;
        if (conn.pipeline) {
          const pipeId = ensurePipelineNode(conn.pipeline, 'pipeline');
          const chainEndPid = resolveChainEndPipeId(conn.pipeline);
          const chainEndPipeId = chainEndPid === conn.pipeline ? pipeId : ensurePipelineNode(chainEndPid, 'pipeline');
          edges.push(makeEdge(sourceId, pipeId, 'flow'));
          edges.push(makeEdge(chainEndPipeId, destId, 'flow'));
        } else {
          edges.push(makeEdge(sourceId, destId, 'flow'));
        }
      }
      continue; // QuickConnect Sources bypass Routes entirely.
    }

    if (input.sendToRoutes === false) continue;

    if (input.pipeline) {
      const preId = ensurePipelineNode(input.pipeline, 'prePipeline');
      edges.push(makeEdge(sourceId, preId, 'flow'));
      for (const table of routeTables) edges.push(makeEdge(preId, `routes:${table.id}`, 'flow'));
    } else {
      for (const table of routeTables) edges.push(makeEdge(sourceId, `routes:${table.id}`, 'flow'));
    }
  }

  // --- Destinations (incl. Output Router). The built-in "default" output never gets its own card
  //     when it resolves to a real target — see `resolveOutputId` above — matching the real app's
  //     own established behavior exactly, so every rule pointing at "default" lands on the real
  //     resolved Destination's card instead of a redundant "default (devnull)" one. ---
  for (const output of outputs) {
    if (output.type === 'default' && resolveOutputId(outputsById, output.id) !== output.id) continue;
    const destId = `destination:${output.id}`;
    const isRouter = output.type === 'router';
    const resolvedRuleTargets = [...new Set((output.rules ?? []).map((r) => resolveOutputId(outputsById, r.output)))];
    nodes.set(destId, {
      id: destId,
      kind: isRouter ? 'outputRouter' : 'destination',
      label: output.defaultId ? `${output.id} (${output.defaultId})` : output.id,
      workerGroupId: groupId,
      health: 'good',
      metrics: NODATA_METRICS,
      disabled: output.disabled,
      refType: output.type,
      raw: output,
      routerRuleIds: isRouter ? resolvedRuleTargets : undefined,
      configPath: criblConfigPath(groupId, isRouter ? 'outputRouter' : 'destination', output.id, output.type),
      chainsToGroupId: resolveChainTarget(output, groupId, workerGroupByHostname),
    });

    if (isRouter && output.rules) {
      for (const rule of output.rules) {
        const resolved = resolveOutputId(outputsById, rule.output);
        if (!outputsById.has(resolved)) continue; // Rule points at a Destination that no longer exists.
        edges.push(makeEdge(destId, `destination:${resolved}`, 'routerRule'));
      }
    }
  }

  // --- Route tables + rules: Routes -> Pipeline -> (Post-Processing Pipeline ->) Destination,
  //     plus the always-present "endRoute" implicit fallthrough to the resolved "default" output —
  //     unconditional on real Route config, exactly matching the real app's own established rule
  //     (endRoute's own existence never depends on whether some other rule happens to be a
  //     guaranteed catch-all; only on whether a real "default" output is configured at all). ---
  for (const table of routeTables) {
    const routesId = `routes:${table.id}`;
    nodes.set(routesId, {
      id: routesId,
      kind: 'routes',
      label: 'Routes',
      workerGroupId: groupId,
      health: 'good',
      metrics: NODATA_METRICS,
      raw: table,
      ruleCount: table.routes.length,
      configPath: criblConfigPath(groupId, 'routes', table.id),
    });

    for (const rule of table.routes) {
      const pipeId = ensurePipelineNode(rule.pipeline, 'pipeline');
      // A pipeline that chains into another one (the Chain function) isn't the real terminus of
      // this stage — the chain's own last pipeline is what actually hands off downstream, so the
      // *next* edge originates there, not on `rule.pipeline` itself. `pipeId` itself is untouched —
      // Routes really does dispatch to `rule.pipeline` first, chain or not.
      const chainEndPid = resolveChainEndPipeId(rule.pipeline);
      const chainEndPipeId = chainEndPid === rule.pipeline ? pipeId : ensurePipelineNode(chainEndPid, 'pipeline');
      const resolvedOut = resolveOutputId(outputsById, rule.output);
      const targetOutput = outputsById.get(resolvedOut);
      const nextHopId = targetOutput?.pipeline ? ensurePipelineNode(targetOutput.pipeline, 'postPipeline') : `destination:${resolvedOut}`;

      edges.push(makeEdge(routesId, pipeId, 'flow', rule.id, rule.disabled));
      edges.push(makeEdge(chainEndPipeId, nextHopId, 'flow', rule.id, rule.disabled));
      if (targetOutput?.pipeline) {
        edges.push(makeEdge(nextHopId, `destination:${resolvedOut}`, 'flow', rule.id, rule.disabled));
      }
    }

    const defaultOutput = outputsById.get('default');
    if (defaultOutput) {
      const resolvedDefaultId = resolveOutputId(outputsById, 'default');
      const resolvedDefaultOutput = outputsById.get(resolvedDefaultId);
      const endRouteNextHopId = resolvedDefaultOutput?.pipeline
        ? ensurePipelineNode(resolvedDefaultOutput.pipeline, 'postPipeline')
        : `destination:${resolvedDefaultId}`;
      edges.push(makeEdge(routesId, endRouteNextHopId, 'flow', '__end_route__'));
      if (resolvedDefaultOutput?.pipeline) {
        edges.push(makeEdge(endRouteNextHopId, `destination:${resolvedDefaultId}`, 'flow', '__end_route__'));
      }
      // Real destination/label so the endRoute row renders the same "unrouted events -> X" detail
      // the real app shows — read-only display data, not used for any inference.
      const routesNode = nodes.get(routesId)!;
      routesNode.endRoute = {
        health: 'good',
        destinationLabel: resolvedDefaultOutput?.id ?? resolvedDefaultId,
        destinationId: `destination:${resolvedDefaultId}`,
        postPipelineId: resolvedDefaultOutput?.pipeline,
      };
    }
  }

  // --- Pipeline -> Pipeline (Chain function). ---
  for (const pipeline of pipelines) {
    const target = findChainTarget(pipeline);
    if (!target) continue;
    const fromId = ensurePipelineNode(pipeline.id, 'pipeline');
    const toId = ensurePipelineNode(target, 'pipeline');
    edges.push(makeEdge(fromId, toId, 'chain'));
  }

  // Per explicit direction: a Route *row* is its own independent component for connection-mapping
  // purposes, so an edge leaving Routes is never merged with another row's — two different rows
  // pointing at the same Pipeline are two different connections (one line per row), even though
  // they share a next hop. Every other hop is between two genuine, singular components (Pipeline,
  // Post-Processing Pipeline, Destination, Output Router) — multiple rules/rows sharing the exact
  // same one of *those* connections is still just one real wire between two components, so those
  // duplicates merge into a single line (`routeIds` unioned; only shown disabled if *every*
  // contributing rule is disabled).
  const individual: GraphEdge[] = [];
  const merged = new Map<string, GraphEdge>();
  for (const edge of edges) {
    if (nodes.get(edge.fromId)?.kind === 'routes') {
      individual.push(edge);
      continue;
    }
    const key = `${edge.fromId}=>${edge.toId}=>${edge.kind}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, edge);
      continue;
    }
    existing.routeIds = [...new Set([...(existing.routeIds ?? []), ...(edge.routeIds ?? [])])];
    existing.disabled = existing.disabled && edge.disabled;
  }

  return { workerGroupId: groupId, nodes: [...nodes.values()], edges: [...individual, ...merged.values()], flowSummaries: [], generatedAt: Date.now() };
}
