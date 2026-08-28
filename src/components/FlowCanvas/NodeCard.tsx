import { forwardRef } from 'react';
import { Text, IconButton, Tooltip } from '@capra/core';
import { ArrowUpRightFromSquare, LinkOutlined, WarningOutlined } from '@capra/icons';
import type { GraphNode, GroupProductFilter } from '../../lib/types';
import { END_ROUTE_ID } from '../../lib/topology';
import { HEALTH_APPEARANCE, HEALTH_LABEL } from '../../lib/health';
import { formatMetric } from '../../lib/format';
import type { ComponentStats } from '../../lib/topologyConfigOnlyMetrics';
import type { FunctionErrorLogEntry } from '../../api/logs';
import type { WorkerStatusRow } from '../../api/workers';
import { healthFromWorkerRows } from '../../hooks/useWorkerStatus';
import { FunctionErrorHover } from '../FunctionErrorHover';
import { NodeCardWorkerAlertBadge } from './NodeCardWorkerAlertBadge';
import './NodeCard.css';
import './FlowCanvas.css';

// Only these three kinds have any real op-status signal to show at all (a real per-worker
// connector status endpoint) — every other kind (Pipeline roles, Routes) stays the plain neutral
// `node-card--default` it always has, since nothing here can ever confirm they're healthy or not.
// Exported so `FlowCanvas.tsx` can use the identical set for its own "Unhealthy" status-filter
// option, rather than a second, possibly-drifting copy of the same list.
export const OP_STATUS_KINDS = new Set(['source', 'destination', 'outputRouter']);

/** `in`/`out` on an Enabled card default to 0 rather than a blank/"n/a" — per explicit direction,
 *  the card's own compact headline always shows a number. (The drawer, opened by clicking the
 *  card, keeps its own more precise "n/a" for a genuine structural gap vs. a real, honest zero;
 *  this simpler card-level rule doesn't distinguish the two, by request.) */
function cardValue(stats: ComponentStats | undefined, direction: 'in' | 'out', unit: 'events' | 'bytes'): number {
  const key = `${direction}${unit === 'events' ? 'Events' : 'Bytes'}` as keyof ComponentStats;
  const v = stats?.[key];
  return typeof v === 'number' ? v : 0;
}

// Bytes are shown only on Source/Destination cards, as a small secondary line under each of their
// events figures — every other kind is events-only now, no bytes anywhere on its card.
const BYTES_KINDS = new Set(['source', 'destination']);

function reductionPct(inValue: number, outValue: number): number {
  return inValue > 0 ? ((inValue - outValue) / inValue) * 100 : 0;
}

export interface RuleLike {
  id: string;
  name: string;
  filter?: string;
  final?: boolean;
  disabled?: boolean;
}

function connectorTypeOf(node: GraphNode): string | undefined {
  if (node.kind !== 'source' && node.kind !== 'destination' && node.kind !== 'outputRouter') return undefined;
  return (node.raw as { type?: string } | undefined)?.type;
}

export interface NodeCardProps {
  node: GraphNode;
  /** Opens the detail drawer for this node. Not called at all for a `routes` node — see
   *  `onSelectRule` below, which is what Routes uses instead (each rule row is its own component
   *  for this page's purposes, not the Routes card as a whole — it has no single in/out/attribution
   *  of its own to show). */
  onSelect?: (node: GraphNode) => void;
  /** Routes only: opens the detail drawer for one specific rule row. */
  onSelectRule?: (rule: RuleLike) => void;
  /** Real in/out events (and, for Source/Destination, bytes too) for this node — `undefined`
   *  while metrics haven't arrived yet, in which case every figure below reads 0 the same as a
   *  genuinely-zero component (see `cardValue`'s own doc comment). `undefined` for a `routes`
   *  node, which has no card-level stats of its own. */
  stats?: ComponentStats;
  /** Pipeline-role nodes only, and only once `stats.errEvents` is actually nonzero — see
   *  `useFunctionErrors`. */
  functionErrors?: FunctionErrorLogEntry[];
  /** Routes only — restricts which rule rows render, when the Routes lane's own search box has a
   *  real query typed into it. `undefined` means no restriction (show every rule, as before). */
  visibleRuleIds?: Set<string>;
  /** Source/Destination directly, Output Router rolled up from its real targets — see
   *  `workerRowsForNode`/`useWorkerStatus`. `undefined` for every other kind, which has no
   *  real op-status signal at all. */
  workerRows?: WorkerStatusRow[];
  /** This node's own real product ('stream' | 'edge'), resolved by `FlowCanvas` from
   *  `node.workerGroupId` against `state.workerGroups` — picks "Worker"/"Workers" vs. "Node"/
   *  "Nodes" wherever `workerRows` is described (the alert badge's own aria-label/table column,
   *  `explainWorkerRows`'s own sentence). Defaults to `'stream'` (this component's own prior,
   *  always-"Worker" behavior) when omitted. */
  product?: GroupProductFilter;
  /** Real per-source-attribution end-to-end hover highlight — 'none' when nothing's hovered
   *  anywhere (the plain, everyday look), 'highlighted' when this card shares a real attributed
   *  Source with whatever's currently hovered, 'dimmed' when something else is hovered and this
   *  card doesn't share one. Computed by `FlowCanvas` (`nodeHighlightState`), which has the
   *  full graph/metrics context this component itself never needs. */
  highlightState?: 'none' | 'highlighted' | 'dimmed';
  /** Routes only — per-rule-row version of `highlightState` above, keyed by rule id (including
   *  `END_ROUTE_ID` when relevant). A rule id absent from this map, while a hover *is* active
   *  elsewhere, reads as 'dimmed' the same as `highlightState` would — see the render below. */
  ruleHighlightStates?: Map<string, 'highlighted' | 'dimmed'>;
  /** Routes only — each rule's own real status as a colored left edge (`route-rule-row--*`, the
   *  real Signal Path page's own established convention, already defined in the shared, read-only
   *  `NodeCard.css`). A rule id absent from this map (shouldn't normally happen) renders with no
   *  status class at all, the same plain neutral border the base `.route-rules-list li` rule
   *  already sets. */
  ruleHealthStates?: Map<string, 'success' | 'default'>;
  /** Reports hover start/end up to `FlowCanvas`, which owns the actual highlight computation
   *  (it has the graph-wide metrics context; this component only ever reports "it's me/a specific
   *  rule" and renders whatever state comes back down). */
  onNodeHoverStart?: (nodeId: string) => void;
  onNodeHoverEnd?: () => void;
  onRuleHoverStart?: (ruleId: string) => void;
  onRuleHoverEnd?: () => void;
  /** Real display name of the Worker Group `node.chainsToGroupId` resolves to — undefined means
   *  either this isn't a cross-deployment hop at all, or it is one but resolved to a group the top
   *  bar's own picker can't select (see `SignalPathPage.tsx`'s `groupNameById`), in which case this
   *  renders as a plain Destination with no chain affordance. */
  chainGroupName?: string;
  /** Pivots the top bar to `node.chainsToGroupId` — only ever passed when `chainGroupName` is set. */
  onChainClick?: () => void;
}

export const NodeCard = forwardRef<HTMLDivElement, NodeCardProps>(function NodeCard(
  {
    node,
    onSelect,
    onSelectRule,
    stats,
    functionErrors,
    visibleRuleIds,
    workerRows,
    product = 'stream',
    highlightState = 'none',
    ruleHighlightStates,
    ruleHealthStates,
    onNodeHoverStart,
    onNodeHoverEnd,
    onRuleHoverStart,
    onRuleHoverEnd,
    chainGroupName,
    onChainClick,
  },
  ref,
) {
  const connectorType = connectorTypeOf(node);
  const routeTable = node.kind === 'routes' ? (node.raw as { routes: RuleLike[] } | undefined) : undefined;
  const isPipelineRole = node.kind === 'pipeline' || node.kind === 'prePipeline' || node.kind === 'postPipeline';
  const showBytes = BYTES_KINDS.has(node.kind);
  const inValue = cardValue(stats, 'in', 'events');
  const outValue = cardValue(stats, 'out', 'events');
  const inBytesValue = cardValue(stats, 'in', 'bytes');
  const outBytesValue = cardValue(stats, 'out', 'bytes');
  const reduction = reductionPct(inValue, outValue);
  const errEvents = stats?.errEvents;

  // Every node kind has an Enabled/Disabled status — Source/Destination/Output Router read it
  // straight from real config (`RawInput.disabled`/`RawOutput.disabled`); Pipeline/Routes have no
  // such config field at all, so they're always Enabled (nothing can ever mark them otherwise).
  const enabled = !node.disabled;

  // Real op-status, ported from the real Signal Path card's own per-worker escalation — the same
  // `Green`/`Yellow`/`Red` signal already used for the drawer's Per-worker status table, now also
  // driving the card's own left-border color. Pipeline-role cards have no per-worker connector
  // status of their own (they aren't connectors), so they instead reuse the same `hasVolume`
  // convention already established for Route rule rows: 'good' (green) once real, currently-
  // observed traffic exists, 'nodata' (plain neutral) otherwise — real data, not config.
  const hasRealVolume = inValue > 0 || outValue > 0;
  const health = OP_STATUS_KINDS.has(node.kind) ? healthFromWorkerRows(workerRows) : isPipelineRole ? (hasRealVolume ? 'good' : 'nodata') : 'nodata';
  const appearance = OP_STATUS_KINDS.has(node.kind) || isPipelineRole ? HEALTH_APPEARANCE[health] : 'default';

  const clickable = node.kind !== 'routes' && Boolean(onSelect);
  const classNames = [
    'node-card',
    `node-card--${appearance}`,
    node.disabled && 'node-card--disabled',
    highlightState === 'highlighted' && 'node-card--highlighted',
    highlightState === 'dimmed' && 'node-card--dimmed',
    chainGroupName && 'node-card--cross-deployment',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={ref}
      className={classNames}
      role="group"
      aria-label={`${node.label} — ${enabled ? 'Enabled' : 'Disabled'}`}
      title={HEALTH_LABEL[health]}
      data-node-id={node.id}
      onMouseEnter={() => onNodeHoverStart?.(node.id)}
      onMouseLeave={() => onNodeHoverEnd?.()}
    >
      {/* A real, keyboard-focusable control stretched to cover the whole card — the primary way to
          open this node's detail drawer, matching the real Signal Path card's own fix for the same
          problem: nesting a real `<button>` (the redirect icon/error badge below) inside a
          `role="button"` container broke its own computed accessible name into a run-on sentence,
          a real axe-core `nested-interactive` failure. `.node-card-top` gets its own stacking
          context (NodeCard.css) so its buttons still paint, and stay independently clickable,
          above this one despite coming later in DOM order. Routes has none of this — its own card
          was never a single click target (only individual rule rows are, see below). */}
      {clickable && <button type="button" className="node-card-stretch-link" aria-label={`View ${node.label} details`} onClick={() => onSelect?.(node)} />}

      <div className={node.kind === 'routes' ? 'node-card-top node-card-top--routes' : 'node-card-top'}>
        <Text as="span" variant="body-sm-semibold" FORCE__className="node-card-label">
          {node.label}
        </Text>
        {/* One right-aligned group (`margin-left: auto` on the wrapper, not any individual child) —
            order matches the real Signal Path card's own: processing-error badge, blocked/degraded
            worker badge, the Enabled/Disabled square, then the redirect icon last. */}
        <div className="node-card-top-actions">
          {/* Real `pipe.err_events` — a genuine Function/processing error this Pipeline has thrown,
              distinct from an intentional volume drop, same reasoning the real Signal Path card
              uses for showing this as a badge rather than folding it into the stats area. */}
          {Boolean(errEvents) && (
            <FunctionErrorHover
              entries={functionErrors}
              ariaLabel={`${errEvents} processing error${errEvents === 1 ? '' : 's'} in this window — press Enter for details`}
              className="node-card-err-badge"
            >
              <WarningOutlined />
              {formatMetric(errEvents!, 'events')}
            </FunctionErrorHover>
          )}
          {/* Ported from the real Destination card's own blocked/degraded badge — now also shown
              for Source/Output Router, since all three kinds have a real per-worker signal here. */}
          {OP_STATUS_KINDS.has(node.kind) && <NodeCardWorkerAlertBadge rows={workerRows} product={product} />}
          {/* Enabled/Disabled, as a single letter in a colored square — same size as the redirect
              icon beside it, same green/grey color coding the old text tag used. Routes itself has
              no real `disabled` config field of its own (only its individual *rules* do — see each
              rule row's own copy of this same square, below), so `enabled` here would always read
              "E" regardless of anything real; skipped entirely for that one kind rather than show
              a meaningless always-on state. */}
          {node.kind !== 'routes' && (
            <span
              className={`node-card-status-square node-card-status-square--${enabled ? 'enabled' : 'disabled'}`}
              title={enabled ? 'Enabled' : 'Disabled'}
              aria-label={enabled ? 'Enabled' : 'Disabled'}
            >
              {enabled ? 'E' : 'D'}
            </span>
          )}
          {node.configPath && (
            <Tooltip title="Open in Cribl" placement="top">
              <IconButton
                icon={ArrowUpRightFromSquare}
                aria-label={`Open ${node.label} in Cribl`}
                size="sm"
                variant="tertiary"
                FORCE__className="node-card-open"
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(node.configPath, '_blank', 'noopener,noreferrer');
                }}
              />
            </Tooltip>
          )}
        </div>
      </div>
      {connectorType && (
        <Text as="span" variant="body-xs-normal" color="subtle" FORCE__className="node-card-type">
          {connectorType}
        </Text>
      )}
      {chainGroupName && (
        <button
          type="button"
          className="node-card-cross-deployment-link"
          onClick={(e) => {
            e.stopPropagation();
            onChainClick?.();
          }}
        >
          <ArrowUpRightFromSquare />
          <Text as="span" variant="body-xs-normal">
            continues in {chainGroupName}
          </Text>
        </button>
      )}

      {node.chainedPipelineId && (
        <div className="node-card-chain">
          <LinkOutlined />
          <Text as="span" variant="body-xs-normal" color="subtle">
            chains → {node.chainedPipelineId}
          </Text>
        </div>
      )}

      {isPipelineRole && node.functionCount !== undefined && (
        <Text as="span" variant="body-xs-normal" color="subtle">
          {node.functionCount} function{node.functionCount === 1 ? '' : 's'}
        </Text>
      )}

      {node.kind === 'outputRouter' && node.routerRuleIds && (
        <Text as="span" variant="body-xs-normal" color="subtle">
          routes to {node.routerRuleIds.length} destination{node.routerRuleIds.length === 1 ? '' : 's'}
        </Text>
      )}

      {node.kind !== 'routes' && (
        <div className="node-card-bottom node-card-bottom--io">
          <div className="node-card-io node-card-io--in">
            <Text as="span" variant="body-xs-normal" color="subtle">
              IN
            </Text>
            <Text as="span" variant="body-sm-semibold" FORCE__className="node-card-stat-value">
              {formatMetric(inValue, 'events')}
            </Text>
            {showBytes && (
              <Text as="span" variant="body-xs-normal" color="subtle" FORCE__className="node-card-stat-value">
                {formatMetric(inBytesValue, 'bytes')}
              </Text>
            )}
          </div>
          {isPipelineRole && (
            <div className="node-card-io node-card-io--reduction">
              <Text as="span" variant="body-xs-normal" color="subtle">
                REDUCTION
              </Text>
              <Text as="span" variant="body-sm-semibold" FORCE__className="node-card-stat-value">
                {reduction >= 0 ? `▼${Math.round(reduction)}%` : `▲${Math.round(Math.abs(reduction))}%`}
              </Text>
            </div>
          )}
          <div className="node-card-io node-card-io--out">
            <Text as="span" variant="body-xs-normal" color="subtle">
              OUT
            </Text>
            <Text as="span" variant="body-sm-semibold" FORCE__className="node-card-stat-value">
              {formatMetric(outValue, 'events')}
            </Text>
            {showBytes && (
              <Text as="span" variant="body-xs-normal" color="subtle" FORCE__className="node-card-stat-value">
                {formatMetric(outBytesValue, 'bytes')}
              </Text>
            )}
          </div>
        </div>
      )}

      {node.kind === 'routes' && (
        <>
          {visibleRuleIds &&
            (routeTable?.routes ?? []).every((r) => !visibleRuleIds.has(r.id)) &&
            !(node.endRoute && visibleRuleIds.has(END_ROUTE_ID)) && <div className="flow-lane-empty">No rules match the current filter</div>}
          <ol className="route-rules-list">
            {(routeTable?.routes ?? [])
              .filter((rule) => !visibleRuleIds || visibleRuleIds.has(rule.id))
              .map((rule, i) => (
              <li
                key={rule.id}
                data-rule-row-id={rule.id}
                className={[
                  rule.disabled ? 'is-disabled' : undefined,
                  'route-rule-clickable',
                  `route-rule-row--${ruleHealthStates?.get(rule.id) ?? 'default'}`,
                  ruleHighlightStates?.get(rule.id) === 'highlighted' && 'route-rule-highlighted',
                  ruleHighlightStates?.get(rule.id) === 'dimmed' && 'route-rule-dimmed',
                ]
                  .filter(Boolean)
                  .join(' ')}
                role="button"
                tabIndex={0}
                onClick={() => onSelectRule?.(rule)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectRule?.(rule);
                  }
                }}
                onMouseEnter={() => onRuleHoverStart?.(rule.id)}
                onMouseLeave={() => onRuleHoverEnd?.()}
              >
                <div className="route-rule-row-top">
                  <span className="route-rule-index">{i + 1}</span>
                  <span className="route-rule-name">{rule.name}</span>
                  {/* This rule's own real Enabled/Disabled state — a rule, not the Routes table as
                      a whole, is what's actually enabled or disabled, so this replaces the single
                      always-"E" square the top card used to show for every Routes card regardless
                      of any individual rule's real state (see the top card's own doc comment). One
                      shared wrapper (not `.route-rule-final`'s own `margin-left: auto`, a rule this
                      component never edits — that file's own file is real, shared, read-only) keeps
                      the square and Final adjacent and pushes the pair together to the row's own
                      far right edge, the same "wrap the whole right-aligned group" fix already used
                      for the top card's own actions row. */}
                  <span className="route-rule-row-actions">
                    <span
                      className={`node-card-status-square node-card-status-square--${rule.disabled ? 'disabled' : 'enabled'}`}
                      title={rule.disabled ? 'Disabled' : 'Enabled'}
                      aria-label={rule.disabled ? 'Disabled' : 'Enabled'}
                    >
                      {rule.disabled ? 'D' : 'E'}
                    </span>
                    {rule.final && <span className="route-rule-final">Final</span>}
                  </span>
                </div>
                <span className="route-rule-filter">{rule.filter || 'true'}</span>
              </li>
            ))}
          </ol>
          {node.endRoute && (!visibleRuleIds || visibleRuleIds.has(END_ROUTE_ID)) && (
            <ol className="route-rules-list route-rules-list--end-route">
              <li data-rule-row-id={END_ROUTE_ID}>
                <div className="route-rule-row-top">
                  <span className="route-rule-index route-rule-index--end-route" aria-hidden="true">
                    ↳
                  </span>
                  <span className="route-rule-name">endRoute</span>
                </div>
                <span className="route-rule-filter">unrouted events → {node.endRoute.destinationLabel}</span>
              </li>
            </ol>
          )}
        </>
      )}
    </div>
  );
});
