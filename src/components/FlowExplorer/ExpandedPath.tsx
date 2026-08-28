import { Text } from '@capra/core';
import type { FlowSummary, GraphNode, GroupProductFilter, HealthStatus } from '../../lib/types';
import { HEALTH_APPEARANCE, HEALTH_LABEL, HEALTH_RANK, explainHealth } from '../../lib/health';
import { formatMetric } from '../../lib/format';
import { workerAlertSeverity, withWorkerAlert, type WorkerAlertSeverity } from '../../hooks/useDestinationWorkerAlerts';
import type { WorkerStatusRow } from '../../api/workers';
import { resolveFlowSteps, resolveIndividualFlowSteps, FLOW_STEP_KIND_LABEL, type FlowStep } from './resolveFlowSteps';
import { ReductionValue } from '../ReductionValue';
import { WorkerAlertBadge } from '../WorkerAlertBadge';

interface ExpandedPathProps {
  summary: FlowSummary;
  nodesById: Map<string, GraphNode>;
  routesNode: GraphNode | undefined;
  unit: 'events' | 'bytes';
  /** Real per-worker status for this flow's (shared) Destination — see `FlowExplorerTable.tsx`. */
  destWorkerRows: WorkerStatusRow[] | undefined;
  /** Same real per-worker signal, Source side — see `FlowExplorerTable.tsx`. */
  srcWorkerRows: WorkerStatusRow[] | undefined;
  /** This row's own real product ('stream'/'edge'), resolved by `FlowExplorerTable.tsx` from
   *  `summary.workerGroupId` — picks "Worker"/"Node" wherever a worker-alert badge or an
   *  `explainHealth` caption describes a real per-process signal. Defaults to `'stream'` when
   *  omitted, this component's own prior always-"Worker" behavior. */
  product?: GroupProductFilter;
}

/** Folds the real per-worker blocked signal into just one step's own displayed health — every
 *  other step is untouched, since this signal is specific to the one component (Source or
 *  Destination) it was fetched for, not the whole chain. Routes and Pipelines have no equivalent
 *  per-worker connector status in Cribl's API, so there's no third `kind` this ever applies to. */
function applyWorkerAlert(steps: FlowStep[], kind: 'source' | 'destination', severity: WorkerAlertSeverity): FlowStep[] {
  if (severity === 'none') return steps;
  return steps.map((step) => (step.kind === kind ? { ...step, health: withWorkerAlert(step.health, severity) } : step));
}

/** The single worst-health step in a chain — the one `captionFor` explains and the one an
 *  individual flow's own status dot should agree with (see `worstStepHealth` below). Pulled out
 *  on its own so there's exactly one definition of "worst" for a chain, not two that can drift
 *  apart — which is exactly how the status-dot/caption mismatch this replaces happened: the dot
 *  read `flow.health` (raw, un-escalated) while this reduce, driving the caption, read the real
 *  per-worker-escalated steps. */
function worstStep(steps: FlowStep[]): FlowStep | undefined {
  if (steps.length === 0) return undefined;
  return steps.reduce((a, b) => (HEALTH_RANK[b.health] > HEALTH_RANK[a.health] ? b : a));
}

/** The health an individual flow's own status dot should show — the worst step in its (already
 *  worker-alert-escalated) chain, falling back to the flow's own raw health only when the chain
 *  resolved to no steps at all (shouldn't happen in practice, but keeps this total). */
function worstStepHealth(steps: FlowStep[], fallback: HealthStatus): HealthStatus {
  return worstStep(steps)?.health ?? fallback;
}

/**
 * A real, one-sentence explanation of the worst step in the chain — reuses `explainHealth`
 * (already proven in the node detail drawer) for any step backed by a real `GraphNode`
 * (Source/Pipeline/Destination); the synthetic "Routes" step isn't one (it represents just the
 * specific rule(s) feeding *this* flow, not the whole Routes table `explainHealth`'s own
 * routes-shaped branch would describe), so it gets a short bespoke message instead.
 */
function captionFor(steps: FlowStep[], nodesById: Map<string, GraphNode>, product: GroupProductFilter = 'stream'): string {
  const worst = worstStep(steps);
  if (!worst) return 'No data available for this flow.';
  if (worst.health === 'good') return 'This flow is healthy end to end.';

  if (worst.id === 'routes') {
    switch (worst.health) {
      case 'blocked':
        return `"${worst.label}" is receiving events for this flow but is not forwarding them.`;
      case 'degraded':
        return `"${worst.label}" is dropping some events downstream.`;
      default:
        return `"${worst.label}" has no observed data for this flow in the selected time range.`;
    }
  }

  const realNode = nodesById.get(worst.id);
  const explanation = realNode && explainHealth(realNode, product);
  return explanation ? `"${worst.label}" — ${explanation}` : `"${worst.label}" is ${HEALTH_LABEL[worst.health].toLowerCase()}.`;
}

/** `srcWorkerRows`/`destWorkerRows` place a blocked-worker badge at each end of the chain — right
 *  where the Source/Destination boxes sit, since that's what each badge is actually about — rather
 *  than a separate header row, so both show up for the single-flow case too, not just the
 *  multi-flow breakdown. `WorkerAlertBadge` itself renders nothing when its own `rows` carry no
 *  real alert, so the Source-side badge only ever appears when that specific signal is real. */
function FlowChain({
  steps,
  srcWorkerRows,
  destWorkerRows,
  product = 'stream',
}: {
  steps: FlowStep[];
  srcWorkerRows: WorkerStatusRow[] | undefined;
  destWorkerRows: WorkerStatusRow[] | undefined;
  product?: GroupProductFilter;
}) {
  return (
    <div className="flow-explorer-path">
      {/* Explicit `--src`/`--dest` wrapper classes, not a bare `:first-child`/`:last-child` CSS
          selector — `WorkerAlertBadge` renders nothing at all when its own severity is `none`, so
          whichever one *is* present can end up being both the first and last `.worker-alert` in the
          DOM (e.g. only the Destination is blocked), which a position-based selector can't tell
          apart from "this is the Source badge." */}
      <span className="flow-explorer-path-badge flow-explorer-path-badge--src">
        <WorkerAlertBadge rows={srcWorkerRows} product={product} />
      </span>
      {steps.map((step, i) => (
        <div className="flow-explorer-path-step" key={step.id}>
          <div className={`flow-explorer-path-box flow-explorer-path-box--${HEALTH_APPEARANCE[step.health]}`} title={`${step.label} (${HEALTH_LABEL[step.health]})`}>
            <span className="flow-explorer-path-box-kind">{FLOW_STEP_KIND_LABEL[step.kind]}</span>
            <Text as="span" variant="body-sm-semibold" FORCE__className="flow-explorer-path-box-label">
              {step.label}
            </Text>
          </div>
          {i < steps.length - 1 && (
            <div className={`flow-explorer-path-connector flow-explorer-path-connector--${HEALTH_APPEARANCE[steps[i + 1].health]}`} />
          )}
        </div>
      ))}
      <span className="flow-explorer-path-badge flow-explorer-path-badge--dest">
        <WorkerAlertBadge rows={destWorkerRows} product={product} />
      </span>
    </div>
  );
}

/** Matches the reference mockup's "expanded inline" treatment: the real stage-by-stage chain
 *  (fixed-size boxes, each tagged with its stage — SRC/PRE/ROUTES/PIPE/POST/DEST — at a larger,
 *  more legible size than the compact `PathGlyph` column), and a caption pointing at whichever
 *  stage is actually responsible for the flow's current status. No heading naming the flow above
 *  it — the collapsed row's own Flow column already shows Source → Destination directly above
 *  this, so repeating it here was redundant.
 *
 *  When exactly one Route rule (or one QuickConnect connection) contributes to this Source-
 *  >Destination pair, that single chain + caption is the whole picture, so it's shown directly.
 *  When more than one rule shares the pair, showing an "aggregate" chain on top of the individual
 *  ones was redundant — the aggregate is never a *real* path, just a combined-totals row, so only
 *  the individual per-rule chains (each with its own real numbers and caption) are shown; the
 *  combined total already stays visible in the collapsed row above. */
export function ExpandedPath({ summary, nodesById, routesNode, unit, destWorkerRows, srcWorkerRows, product = 'stream' }: ExpandedPathProps) {
  const hasMultipleFlows = summary.flows.length > 1;
  const destSeverity = workerAlertSeverity(destWorkerRows);
  const srcSeverity = workerAlertSeverity(srcWorkerRows);
  // Only meaningful (and only rendered) in the single-flow branch below, but cheap enough to
  // compute unconditionally rather than branch twice over the same resolution logic.
  const steps = applyWorkerAlert(applyWorkerAlert(resolveFlowSteps(summary, nodesById, routesNode), 'destination', destSeverity), 'source', srcSeverity);

  return (
    <div className="flow-explorer-expand">
      {hasMultipleFlows ? (
        <div className="flow-explorer-individual-flows">
          {summary.flows.map((flow) => {
            const flowSteps = applyWorkerAlert(
              applyWorkerAlert(resolveIndividualFlowSteps(summary, flow, nodesById, routesNode), 'destination', destSeverity),
              'source',
              srcSeverity,
            );
            const inValue = unit === 'events' ? flow.inEvents : flow.inBytes;
            const outValue = unit === 'events' ? flow.outEvents : flow.outBytes;
            // The dot reads the same worker-alert-escalated health as `flowSteps`' own destination
            // box and the caption below — not the raw `flow.health` — so a partially-blocked flow
            // never shows a healthy-green dot next to a caption that says it's degraded (a real,
            // confirmed inconsistency: see the interface review).
            const dotHealth = worstStepHealth(flowSteps, flow.health);
            return (
              <div className="flow-explorer-individual-flow" key={flow.id}>
                {/* A 5-column grid — name, then a spacer sized to the parent table's combined
                    Count+Path+Trend column widths, then In/Out/Reduction at `--fe-col-num` each
                    (all defined once in FlowExplorerTable.css) — so these numbers land directly
                    under their In/Out/Reduction counterparts in the row above. Same number format
                    as the aggregate row, just visibly smaller/subtler (`size="sm"` + `color=
                    "subtle"`) to read as subordinate detail rather than a second aggregate. */}
                <div className="flow-explorer-individual-flow-header">
                  <div className="flow-explorer-individual-flow-name">
                    <span className={`flow-explorer-status-dot flow-explorer-status-dot--${HEALTH_APPEARANCE[dotHealth]}`} title={HEALTH_LABEL[dotHealth]} />
                    <Text as="span" variant="body-sm-semibold">
                      {flow.label}
                    </Text>
                  </div>
                  <span aria-hidden="true" />
                  <Text as="span" variant="body-xs-normal" color="subtle" FORCE__className="flow-explorer-mono flow-explorer-individual-flow-num">
                    {formatMetric(inValue, unit)}
                  </Text>
                  <Text as="span" variant="body-xs-normal" color="subtle" FORCE__className="flow-explorer-mono flow-explorer-individual-flow-num">
                    {formatMetric(outValue, unit)}
                  </Text>
                  <span className="flow-explorer-individual-flow-num">
                    <ReductionValue inValue={inValue} outValue={outValue} size="sm" />
                  </span>
                </div>
                <FlowChain steps={flowSteps} srcWorkerRows={srcWorkerRows} destWorkerRows={destWorkerRows} product={product} />
                <Text as="p" variant="body-sm-normal" color="subtle">
                  {captionFor(flowSteps, nodesById, product)}
                </Text>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <FlowChain steps={steps} srcWorkerRows={srcWorkerRows} destWorkerRows={destWorkerRows} product={product} />
          <Text as="p" variant="body-sm-normal" color="subtle">
            {captionFor(steps, nodesById, product)}
          </Text>
        </>
      )}
    </div>
  );
}
