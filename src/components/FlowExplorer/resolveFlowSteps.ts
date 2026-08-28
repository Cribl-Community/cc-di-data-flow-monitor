import type { FlowSummary, GraphNode, HealthStatus, IndividualFlow } from '../../lib/types';
import { END_ROUTE_ID } from '../../lib/topology';

export type FlowStepKind = 'source' | 'pre' | 'routes' | 'pipeline' | 'post' | 'destination';

export interface FlowStep {
  id: string;
  label: string;
  health: HealthStatus;
  kind: FlowStepKind;
}

/** Short, subtle stage tag shown above each step box — SRC/PRE/ROUTES/PIPE/POST/DEST. */
export const FLOW_STEP_KIND_LABEL: Record<FlowStepKind, string> = {
  source: 'SRC',
  pre: 'PRE',
  routes: 'ROUTES',
  pipeline: 'PIPE',
  post: 'POST',
  destination: 'DEST',
};

/** The one fixed stage order every resolved chain follows (a subset of these six, in this exact
 *  sequence — `resolveSteps` below only ever pushes steps in this order). `PathGlyph` uses this as
 *  a shared source of truth for its own fixed per-kind dot positions, so a given kind (e.g. Routes)
 *  lands at the same x position on every row regardless of which *other* stages that particular
 *  flow happens to have. */
export const FLOW_STEP_KIND_ORDER: FlowStepKind[] = ['source', 'pre', 'routes', 'pipeline', 'post', 'destination'];

interface StepInput {
  sourceId: string;
  destinationId: string;
  routeIds: string[];
  pipelineIds: string[];
  prePipelineId?: string;
  postPipelineId?: string;
}

/**
 * A component's raw `deriveHealth` (used everywhere else in this app, e.g. Signal Path)
 * marks *any* nonzero drop rate as `degraded`, regardless of whether that drop is an involuntary
 * failure or Cribl doing exactly what it's configured to do (trimming volume before a destination
 * to save on license/storage cost there). That distinction matters for Flow Explorer specifically:
 * this page's own `FlowSummary`/`IndividualFlow` health already deliberately has no `degraded`
 * state at all, precisely because a flow's own volume reduction isn't a health problem (see
 * `flowHealthFromVolume` in `topology.ts`) — but before this, the per-step boxes in the expanded
 * diagram still used the raw component health, so a flow whose row read "Healthy" with a plain
 * `▼15%` Reduction could expand into a diagram full of orange boxes for the exact same drops,
 * visually contradicting the row above it. Collapsing `degraded` into `good` here (Flow Explorer's
 * own diagram only — `deriveHealth` itself, and every other view built on it, is untouched) makes
 * the diagram consistent with the rest of this page's stance. `blocked` (real input, zero output)
 * and `nodata` stay meaningfully distinct — those are genuine problems, not expected trimming.
 */
function flowExplorerDisplayHealth(health: HealthStatus): HealthStatus {
  return health === 'degraded' ? 'good' : health;
}

/**
 * The real resolved chain for a flow — Source, an optional Pre-Processing Pipeline (only when the
 * Source's own config actually routes through one), Routes (skipped entirely for a QuickConnect
 * flow, which has no `routeIds` because it never touches Routes at all), every main Pipeline the
 * contributing rule(s) dispatch through, an optional Post-Processing Pipeline (only when the
 * Destination's own config runs one), and Destination — the same six stages Signal Path's own
 * topology uses, just linearized for one flow instead of laid out as a full diagram. Each step's
 * health comes from its own real `GraphNode` where one exists; the Routes step's health is the
 * worst of just the specific rule(s) in `routeIds`, via `routeRuleHealth`, not the whole table's
 * aggregate — the same "don't let one bad rule elsewhere repaint this" reasoning `buildFlowGraph`
 * already applies to Signal Path's own edges.
 */
function resolveSteps(input: StepInput, nodesById: Map<string, GraphNode>, routesNode: GraphNode | undefined): FlowStep[] {
  const sourceNode = nodesById.get(input.sourceId);
  const destinationNode = nodesById.get(input.destinationId);

  const steps: FlowStep[] = [];
  if (sourceNode) steps.push({ id: sourceNode.id, label: sourceNode.label, health: sourceNode.health, kind: 'source' });

  if (input.prePipelineId) {
    const node = nodesById.get(`prePipeline:${input.prePipelineId}`);
    steps.push({ id: `prePipeline:${input.prePipelineId}`, label: input.prePipelineId, health: node?.health ?? 'nodata', kind: 'pre' });
  }

  if (input.routeIds.length > 0 && routesNode) {
    const ruleHealths = input.routeIds.map((id) => routesNode.routeRuleHealth?.[id]).filter((h): h is HealthStatus => h !== undefined);
    const worst = ruleHealths.includes('blocked')
      ? 'blocked'
      : ruleHealths.includes('degraded')
        ? 'degraded'
        : ruleHealths.includes('nodata')
          ? 'nodata'
          : (ruleHealths[0] ?? 'nodata');
    // A generic "Routes" label was uninformative here: every flow that reaches this branch is
    // attributable to exactly one rule (the aggregate `resolveFlowSteps` call is only ever
    // actually rendered for a single-flow summary, which by definition has at most one route id;
    // `resolveIndividualFlowSteps` always passes exactly one) — so the box can show that rule's
    // own configured name instead, the same way a Pipeline box shows its own pipeline id rather
    // than a generic "Pipeline". `END_ROUTE_ID` isn't a real rule in `raw.routes` at all (see
    // `buildNoDataRow`'s own doc comment, `FlowExplorerTable.tsx`) — labeled "endRoute" directly,
    // matching Signal Path's own "↳ endRoute" row naming. Falls back to plain "Routes" only if
    // neither applies (more than one contributing rule, or the rule's own record isn't found)
    // rather than showing nothing.
    const raw = routesNode.raw as { routes: { id: string; name: string }[] } | undefined;
    const label =
      input.routeIds.length === 1 && input.routeIds[0] === END_ROUTE_ID
        ? 'endRoute'
        : (input.routeIds.length === 1 ? raw?.routes.find((r) => r.id === input.routeIds[0])?.name : undefined) ?? 'Routes';
    steps.push({ id: 'routes', label, health: worst, kind: 'routes' });
  }

  for (const pid of input.pipelineIds) {
    const node = nodesById.get(`pipeline:${pid}`);
    steps.push({ id: `pipeline:${pid}`, label: pid, health: node?.health ?? 'nodata', kind: 'pipeline' });
  }

  if (input.postPipelineId) {
    const node = nodesById.get(`postPipeline:${input.postPipelineId}`);
    steps.push({ id: `postPipeline:${input.postPipelineId}`, label: input.postPipelineId, health: node?.health ?? 'nodata', kind: 'post' });
  }

  if (destinationNode) steps.push({ id: destinationNode.id, label: destinationNode.label, health: destinationNode.health, kind: 'destination' });

  return steps.map((step) => ({ ...step, health: flowExplorerDisplayHealth(step.health) }));
}

/** The aggregate chain for a whole `FlowSummary` row (every contributing rule's Route/Pipeline ids
 *  folded together). */
export function resolveFlowSteps(summary: FlowSummary, nodesById: Map<string, GraphNode>, routesNode: GraphNode | undefined): FlowStep[] {
  return resolveSteps(
    {
      sourceId: summary.sourceId,
      destinationId: summary.destinationId,
      routeIds: summary.routeIds,
      pipelineIds: summary.pipelineIds,
      prePipelineId: summary.prePipelineId,
      postPipelineId: summary.postPipelineId,
    },
    nodesById,
    routesNode,
  );
}

/** The chain for just *one* contributing flow within a `FlowSummary` — the Source/Destination and
 *  pre/post Pipeline ids are shared with the parent summary (constant for a given pair), but the
 *  Route rule and main Pipeline are that one flow's own. */
export function resolveIndividualFlowSteps(
  summary: FlowSummary,
  flow: IndividualFlow,
  nodesById: Map<string, GraphNode>,
  routesNode: GraphNode | undefined,
): FlowStep[] {
  return resolveSteps(
    {
      sourceId: summary.sourceId,
      destinationId: summary.destinationId,
      routeIds: flow.routeId ? [flow.routeId] : [],
      pipelineIds: flow.pipelineId ? [flow.pipelineId, ...(flow.chainPipelineIds ?? [])] : (flow.chainPipelineIds ?? []),
      prePipelineId: summary.prePipelineId,
      postPipelineId: summary.postPipelineId,
    },
    nodesById,
    routesNode,
  );
}
