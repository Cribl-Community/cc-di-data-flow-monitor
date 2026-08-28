import { LANES, visualLaneOf, type FlowGraph, type GraphNode, type NodeKind } from './types';

export interface LaneColumn {
  lane: NodeKind;
  nodes: GraphNode[];
}

/**
 * Orders nodes within each lane to reduce edge crossings, using the standard barycenter
 * heuristic for layered graph drawing: a few alternating forward/backward sweeps, each pass
 * re-sorting a lane by the mean position of the nodes it connects to in the neighboring lane
 * from the previous pass. Isolated nodes (no edges yet placed) keep a stable alphabetical
 * fallback position so the layout doesn't jitter node order between refreshes.
 */
export function computeLaneOrder(graph: FlowGraph): LaneColumn[] {
  const nodesByLane = new Map<NodeKind, GraphNode[]>();
  for (const lane of LANES) nodesByLane.set(lane, []);
  for (const node of graph.nodes) {
    const bucket = nodesByLane.get(visualLaneOf(node.kind));
    if (bucket) bucket.push(node);
  }
  for (const lane of LANES) {
    nodesByLane.get(lane)!.sort((a, b) => a.label.localeCompare(b.label));
  }

  const positionOf = new Map<string, number>();
  const reindex = () => {
    positionOf.clear();
    for (const lane of LANES) {
      nodesByLane.get(lane)!.forEach((n, i) => positionOf.set(n.id, i));
    }
  };
  reindex();

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!outgoing.has(edge.fromId)) outgoing.set(edge.fromId, []);
    outgoing.get(edge.fromId)!.push(edge.toId);
    if (!incoming.has(edge.toId)) incoming.set(edge.toId, []);
    incoming.get(edge.toId)!.push(edge.fromId);
  }

  function barycenterSort(lane: NodeKind, neighborIds: (node: GraphNode) => string[]) {
    const nodes = nodesByLane.get(lane)!;
    const withKeys = nodes.map((node, fallbackIndex) => {
      const neighbors = neighborIds(node)
        .map((id) => positionOf.get(id))
        .filter((v): v is number => v !== undefined);
      const key = neighbors.length ? neighbors.reduce((a, b) => a + b, 0) / neighbors.length : fallbackIndex;
      return { node, key, fallbackIndex };
    });
    withKeys.sort((a, b) => a.key - b.key || a.fallbackIndex - b.fallbackIndex);
    nodesByLane.set(lane, withKeys.map((w) => w.node));
  }

  const PASSES = 3;
  for (let pass = 0; pass < PASSES; pass++) {
    // Forward sweep: order each lane by its predecessors' positions in the lane to its left.
    for (let i = 1; i < LANES.length; i++) {
      barycenterSort(LANES[i], (node) => incoming.get(node.id) ?? []);
      reindex();
    }
    // Backward sweep: order each lane by its successors' positions in the lane to its right.
    for (let i = LANES.length - 2; i >= 0; i--) {
      barycenterSort(LANES[i], (node) => outgoing.get(node.id) ?? []);
      reindex();
    }
  }

  // Final tiering pass, every lane except Routes (whose row order is functionally significant —
  // rule evaluation order — and must never be resorted). Within each lane, group nodes into
  // bands so the diagram reads top-to-bottom as "what needs attention first":
  //   0. (Sources only) feeds a Pre-Processing pipeline — closest to the lane it connects to.
  //   1. Configured and enabled, with a real status either way (healthy *or* unhealthy) — these
  //      two are treated as one combined band, not two, so barycenter can freely order a healthy
  //      node above or below an unhealthy one if that's what actually minimizes crossings; the
  //      point of tiering is separating "has signal" from "doesn't", not ranking health within it.
  //   2. Configured and enabled, but not processing any data right now.
  //   3. Disabled.
  // `Array.prototype.sort` is stable (guaranteed since ES2019), so barycenter's own
  // crossing-minimizing order from the passes above is preserved within each band.
  const kindById = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  const prePipelineFeederIds = new Set(
    graph.edges.filter((e) => kindById.get(e.toId) === 'prePipeline').map((e) => e.fromId),
  );
  function tierOf(node: GraphNode): number {
    if (node.kind === 'source' && prePipelineFeederIds.has(node.id)) return 0;
    if (node.disabled) return 3;
    if (node.health === 'nodata') return 2;
    return 1;
  }
  for (const lane of LANES) {
    if (lane === 'routes') continue;
    nodesByLane.set(
      lane,
      [...nodesByLane.get(lane)!].sort((a, b) => tierOf(a) - tierOf(b)),
    );
  }

  return LANES.map((lane) => ({ lane, nodes: nodesByLane.get(lane)! }));
}
