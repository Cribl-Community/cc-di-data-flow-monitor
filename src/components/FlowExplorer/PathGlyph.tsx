import type { FlowSummary, GraphNode } from '../../lib/types';
import { HEALTH_APPEARANCE, HEALTH_LABEL } from '../../lib/health';
import { workerAlertSeverity, withWorkerAlert } from '../../hooks/useDestinationWorkerAlerts';
import type { WorkerStatusRow } from '../../api/workers';
import { FLOW_STEP_KIND_ORDER, resolveFlowSteps } from './resolveFlowSteps';

interface PathGlyphProps {
  summary: FlowSummary;
  nodesById: Map<string, GraphNode>;
  routesNode: GraphNode | undefined;
  /** Real per-worker status for this flow's Destination — used to mark just that one dot with a
   *  real per-worker blocked signal the rest of this glyph's uniform coloring can't show (see the
   *  doc comment below). */
  destWorkerRows: WorkerStatusRow[] | undefined;
  /** Same real per-worker signal, Source side (`useSourceWorkerAlerts`) — marks the first dot the
   *  same way `destWorkerRows` marks the last one. */
  srcWorkerRows: WorkerStatusRow[] | undefined;
}

const WIDTH = 96;
const HEIGHT = 20;
const DOT_RADIUS = 4;
const DOT_STROKE_WIDTH = 2;
// The dot's rendered edge extends `strokeWidth / 2` past its own radius — using bare `DOT_RADIUS`
// as the position margin let the outermost dots' strokes bleed 1px past the svg's own viewport at
// each end, clipped by the browser exactly like the "cut off slightly at the start and end" it
// looked like. Margin has to account for the stroke too, not just the fill radius.
const EDGE_MARGIN = DOT_RADIUS + DOT_STROKE_WIDTH / 2;
// One fixed x per possible stage (`FLOW_STEP_KIND_ORDER`: Source/Pre/Routes/Pipeline/Post/
// Destination), spread evenly across the full width — computed once from the *maximum* possible
// stage count, not the current row's own step count. This is what makes a given kind (e.g. Routes)
// land at the same x on every row regardless of which *other* stages that particular flow happens
// to have, rather than each row independently justifying its own dots edge-to-edge (the previous
// behavior, which put Routes at a different x on a 2-dot QuickConnect row than on a 4-dot
// Route-based row — confusing to compare at a glance, per direct feedback). `resolveSteps` only
// ever emits at most one step per kind for a single flow (both the aggregate call, which per
// `ExpandedPath`'s own doc comment only actually renders for a single-flow summary, and the
// per-individual-flow call, which by construction has at most one route/pipeline id), so
// `indexOf` is a safe, unambiguous lookup — never two steps racing for the same slot.
const SLOT_COUNT = FLOW_STEP_KIND_ORDER.length;
const SLOT_X = FLOW_STEP_KIND_ORDER.map((_, i) => EDGE_MARGIN + (i / (SLOT_COUNT - 1)) * (WIDTH - EDGE_MARGIN * 2));

/**
 * The compact per-row abstraction of `resolveFlowSteps` — a hollow dot per real stage (Source,
 * Routes if this flow touches it, each Pipeline, Destination), all one color, matching the
 * reference mockup's own treatment exactly (a single status color per row, not a color per dot —
 * an earlier version of this component colored each dot by its own step health, which read as a
 * genuine style mismatch against the mockup once compared side by side). Dot *count* reflects this
 * flow's actual stage count rather than a fixed illustrative 5 — a QuickConnect row (no
 * `routeIds`, it never touches Routes) shows 2 dots, a Route-based row shows 4 — but each dot's
 * *position* is fixed per stage kind (see `SLOT_X` above), not spread evenly across whatever dots
 * happen to be present this row. A missing stage (e.g. no Pre-Processing) isn't skipped by
 * compressing its neighbors together — the single connecting `<line>` already spans straight from
 * the first present dot's slot to the last present dot's slot, so it naturally extends across a
 * missing stage's gap to the next real one, per direct feedback ("extend the line till the next
 * dot").
 *
 * The Source and Destination dots are the deliberate exceptions to "all one color": a real
 * per-worker blocked signal (see `useDestinationWorkerAlerts`/`useSourceWorkerAlerts`) is a genuine
 * fault this row's own volume-based `summary.health` can't represent, and coloring the *whole*
 * row's dots to reflect it would misrepresent every other stage as blocked too — only the
 * Source/Destination dots (the ones a real per-worker connector status actually exists for; Routes
 * and Pipelines have no equivalent endpoint) are marked, everything else keeps the uniform row
 * color.
 */
export function PathGlyph({ summary, nodesById, routesNode, destWorkerRows, srcWorkerRows }: PathGlyphProps) {
  const steps = resolveFlowSteps(summary, nodesById, routesNode);
  if (steps.length === 0) return null;

  const positions = steps.map((step) => SLOT_X[FLOW_STEP_KIND_ORDER.indexOf(step.kind)]);
  const title = steps.map((s) => s.label).join(' → ');
  const rowHealth = summary.health;
  const destSeverity = workerAlertSeverity(destWorkerRows);
  // `summary.health` can already read `'blocked'` for a reason that has nothing to do with a
  // genuine upstream problem: `topology.ts`'s own real per-worker "destination confirmed stuck"
  // correction zeroes this flow's own `outEvents` before `flowHealthFromVolume` ever sees it (a
  // deliberately *stronger* signal than the derived-ratio estimate it overrides — correct for the
  // Reduction/volume figures, which should honestly read the destination isn't receiving anything).
  // But that means the row's own "uniform" color — meant to represent genuine Source/Pipeline
  // health, with the destination's own real fault isolated to just its own dot via `destHealth`
  // below (see this component's own doc comment on why) — was itself already carrying that same
  // destination-only fault, repainting every middle dot and the connecting line red purely because
  // the very last hop is stuck. `destSeverity === 'all'` (every real worker reports this
  // Destination `Red`) is the same real signal `isDestinationStuck` is built from, so it's a
  // reliable proxy for "this block is the destination's own fault" without needing the
  // (unavailable here) pre-correction volume numbers — relaxes the uniform color back to `'good'`
  // in exactly that case, leaving every other cause of `'blocked'` (a real upstream drop, or a
  // destination that's merely `'partial'`ly down) to still read as blocked, unchanged.
  const midHealth = rowHealth === 'blocked' && destSeverity === 'all' ? 'good' : rowHealth;
  const appearance = HEALTH_APPEARANCE[midHealth];
  // Both endpoints escalate from `midHealth`, not raw `rowHealth` — for the destination dot this
  // makes no visible difference (`destSeverity === 'all'` forces `'blocked'` either way, via
  // `worseOf`), but for the Source dot it matters: with `rowHealth` as the base, a Source with no
  // real alert of its own (`severity === 'none'`, which leaves the base untouched) would still
  // inherit the same destination-caused `'blocked'` this component exists to *not* spread beyond
  // the one dot that's actually at fault.
  const destHealth = withWorkerAlert(midHealth, destSeverity);
  const destAppearance = HEALTH_APPEARANCE[destHealth];
  const srcHealth = withWorkerAlert(midHealth, workerAlertSeverity(srcWorkerRows));
  const srcAppearance = HEALTH_APPEARANCE[srcHealth];

  return (
    <svg width={WIDTH} height={HEIGHT} className="flow-explorer-path-glyph" role="img" aria-label={`${title} (${HEALTH_LABEL[rowHealth]})`}>
      <title>{title}</title>
      <line
        x1={positions[0]}
        y1={HEIGHT / 2}
        x2={positions[positions.length - 1]}
        y2={HEIGHT / 2}
        className={`flow-explorer-path-glyph-line flow-explorer-path-glyph-line--${appearance}`}
      />
      {steps.map((step, i) => {
        const isDest = step.kind === 'destination';
        const isSrc = step.kind === 'source';
        const stepHealth = isDest ? destHealth : isSrc ? srcHealth : rowHealth;
        const stepAppearance = isDest ? destAppearance : isSrc ? srcAppearance : appearance;
        return (
          <circle
            key={step.id}
            cx={positions[i]}
            cy={HEIGHT / 2}
            r={DOT_RADIUS}
            className={`flow-explorer-path-glyph-dot flow-explorer-path-glyph-dot--${stepAppearance}`}
          >
            {(isDest || isSrc) && stepHealth !== rowHealth && <title>{`${step.label} (${HEALTH_LABEL[stepHealth]})`}</title>}
          </circle>
        );
      })}
    </svg>
  );
}
