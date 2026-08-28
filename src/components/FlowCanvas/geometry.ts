// Edge path geometry. The core correctness property (verified here mathematically, not
// visually, since there's no browser in this environment): a cubic Bezier is always contained
// within the convex hull of its 4 control points. An "S-curve" built as
// `M x0,y0 C midX,y0 midX,y1 x1,y1` therefore has X monotonically spanning exactly [x0,x1] and Y
// exactly [min(y0,y1),max(y0,y1)] — nothing more. For a lane-skipping edge, routing through a
// shared "clear Y" that sits outside the Y range of every node it needs to skip — above them for
// most detours, below the Pre-Processing lane specifically for Source -> Routes edges (see
// FlowCanvas.tsx) — with the horizontal crossing confined to X between the departure and arrival
// lanes' edges, means the path is provably outside every node's bounding box: the two S-curve
// segments never leave the X range between their own two endpoints (so they can't re-enter a
// lane they've already left), and the horizontal crossing segment holds a constant Y outside
// every node's Y range by construction, whichever side of the canvas that Y sits on.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export function rightAnchor(r: Rect): Point {
  return { x: r.x + r.width, y: r.y + r.height / 2 };
}

export function leftAnchor(r: Rect): Point {
  return { x: r.x, y: r.y + r.height / 2 };
}

function sCurve(x0: number, y0: number, x1: number, y1: number): string {
  const midX = (x0 + x1) / 2;
  return `M ${x0},${y0} C ${midX},${y0} ${midX},${y1} ${x1},${y1}`;
}

export interface DetourOptions {
  /** X just past the departure lane's own column — the detour starts clearing obstacles here. */
  obstacleLeft: number;
  /** X just before the arrival lane's own column — the detour stops clearing obstacles here. */
  obstacleRight: number;
  /** A Y guaranteed to be outside every node's vertical span on the canvas. */
  clearY: number;
}

export function buildEdgePath(from: Point, to: Point, detour?: DetourOptions): string {
  if (!detour) return sCurve(from.x, from.y, to.x, to.y);

  const buffer = 16;
  const wp1x = Math.max(from.x + 1, detour.obstacleLeft - buffer);
  const wp2x = Math.max(wp1x + 1, detour.obstacleRight + buffer);
  const midA = (from.x + wp1x) / 2;
  const midC = (wp2x + to.x) / 2;

  return [
    `M ${from.x},${from.y}`,
    `C ${midA},${from.y} ${midA},${detour.clearY} ${wp1x},${detour.clearY}`,
    `L ${wp2x},${detour.clearY}`,
    `C ${midC},${detour.clearY} ${midC},${to.y} ${to.x},${to.y}`,
  ].join(' ');
}

/**
 * A "loopback" edge — a Chain (Pipeline -> Pipeline) or Output Router rule (Output Router ->
 * Destination) edge, where `from` and `to` sit in the *same* visual lane/column rather than two
 * different ones. `from.x` (the origin's right edge) is therefore always >= `to.x` (the
 * destination's left edge) — the opposite direction `buildEdgePath`'s own detour math assumes —
 * so this is a distinct shape, not a variant of the cross-lane one.
 *
 * Shaped as two "hooks" bracketing a flat middle: each hook leaves its own endpoint, bulges out to
 * a peak *strictly outside the column* (right of `from.x` for the departure hook, left of `to.x`
 * for the arrival one — nothing in this lane ever renders past either edge, so each hook's own
 * curve, confined by the convex-hull property to the X-range between its endpoint and its peak,
 * can never overlap a real card), and returns to the *same* X it started from, at `clearY`. The
 * flat middle then runs directly from `from.x` to `to.x` at that same `clearY` — safe for its
 * entire width since `clearY` is chosen (by the caller, see `gapClearYFor` in FlowCanvas.tsx) to
 * sit outside every relevant obstacle's own Y range, and every card in the lane shares this same
 * X-span regardless of which one it is.
 *
 * This specific shape (bulge-and-return, not bulge-and-continue) exists to keep the curve's own
 * tangent continuous at both hook/flat-segment junctions — a real, previously-shipped bug, found
 * live: an earlier version had each hook's own curve continue *past* its own endpoint's X into the
 * flat segment (mirroring `buildEdgePath`'s own left-to-right shape verbatim), but that shape's
 * incoming tangent at the transition point still pointed in the direction of the outward bulge —
 * away from the flat segment's own direction of travel, which is backward here (loopback travel is
 * right-to-left, the opposite of the cross-lane case that shape was designed for) — forcing an
 * instant, visually sharp reversal right at the junction. Returning to the *same* X the hook
 * started from means its own final tangent (control point to endpoint) already points in the flat
 * segment's own direction, matching smoothly with no reversal.
 */
export function buildLoopbackEdgePath(from: Point, to: Point, clearY?: number): string {
  if (clearY === undefined) return sCurve(from.x, from.y, to.x, to.y);

  // A fixed small buffer (matching `buildEdgePath`'s own 16px) reads fine there because the
  // cross-lane detour's horizontal excursion already spans several lane-widths, so 16px is a small
  // fraction of the whole curve. Here the horizontal budget per hook is only ever a modest bulge
  // past the column's own edge, while the *vertical* distance a loopback often has to cover (two
  // Pipelines/Destinations several rows apart) can be hundreds of pixels — a too-small bezier
  // control offset trying to bend that much Y in too little X reads as a tight, pinched curve
  // rather than a graceful one. Scaling each hook's own peak offset to a fraction of the vertical
  // distance it actually covers keeps every curve's *proportions* visually graceful regardless of
  // how far apart the two cards are, clamped so a short hop doesn't get an oversized bulge and a
  // very long one doesn't stretch implausibly wide.
  const bufferFor = (dy: number) => Math.min(64, Math.max(24, Math.abs(dy) * 0.25));
  const peak1x = from.x + bufferFor(from.y - clearY);
  const peak2x = to.x - bufferFor(to.y - clearY);

  return [
    `M ${from.x},${from.y}`,
    `C ${peak1x},${from.y} ${peak1x},${clearY} ${from.x},${clearY}`,
    `L ${to.x},${clearY}`,
    `C ${peak2x},${clearY} ${peak2x},${to.y} ${to.x},${to.y}`,
  ].join(' ');
}
