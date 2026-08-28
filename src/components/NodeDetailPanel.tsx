import { useEffect, useState } from 'react';
import { Spinner, Text, IconButton, Tooltip, CustomTooltipTrigger } from '@capra/core';
import { ArrowUpRightFromSquare } from '@capra/icons';
import { formatBytes, formatMetric, formatTimestamp } from '../lib/format';
import { fetchTrend, escapeFilterLiteral } from '../api/metrics';
import { WORKER_HEALTH_APPEARANCE, type WorkerStatusRow } from '../api/workers';
import { HEALTH_APPEARANCE, HEALTH_LABEL } from '../lib/health';
import { explainWorkerRows, healthFromWorkerRows, worstWorkerRow } from '../hooks/useWorkerStatus';
import { criblEdgeNodeInfoPath } from '../lib/criblLinks';
import type { ComponentStats } from '../lib/topologyConfigOnlyMetrics';
import { realRawIdOf } from '../lib/topologyConfigOnlyMerge';
import { WORKER_NOUN } from '../lib/productTerms';
import type { GraphNode, GroupProductFilter } from '../lib/types';
import type { RawPipelineFunction, RawTopologyBundle } from '../api/topology';
import type { FunctionErrorLogEntry } from '../api/logs';
import { TrendChart, type TrendSeries } from './TrendChart';
import { FunctionErrorHover } from './FunctionErrorHover';
import { ReductionValue } from './ReductionValue';
import './NodeDetailPanel.css';

/** Signal Path's own node/rule detail drawer content. Reuses `NodeDetailPanel.css`'s generic
 *  `.node-detail-*` classes throughout — a few pieces directly (flags, function-error cells, the
 *  outer panel/section wrappers) and every real data table via its own `.node-detail-data-table`/
 *  `.node-detail-th-*`/`.node-detail-td-*` classes (modeled on the License page's own Top Sources
 *  table). Per-worker status is passed down as a prop (`workerRows`, from `SignalPathPage.tsx`'s
 *  own eager `useWorkerStatus` fetch) rather than fetched here on-demand — avoids a redundant
 *  second round trip every time a Source/Destination/Output Router drawer is opened, since the
 *  page already has the data on hand for card coloring. Trend fetching below stays on generic,
 *  pure `api/metrics.ts` pieces (`fetchTrend`) rather than `lib/topology.ts`, matching this page's
 *  own config-only graph (`topologyConfigOnly.ts`/`topologyConfigOnlyMetrics.ts`). */

function statCell(value: number | undefined, unit: 'events' | 'bytes'): string {
  return value !== undefined ? formatMetric(value, unit) : 'n/a';
}

/** Rounds a set of percentages that should sum to ~100 into integers that sum to *exactly* the
 *  same real total, instead of each row's own independent `Math.round()` drifting by a point or
 *  two (three rows at 33.33% each round to 33+33+33 = 99, not 100; two at 45.5%/54.5% round to
 *  46+55 = 101). Largest-remainder method: floor every value, then hand the leftover whole points
 *  to whichever values had the largest fractional part, in order — the standard, deterministic way
 *  to round a set of real shares back to a fixed whole with the least distortion. `undefined`
 *  passes through unrounded (an "n/a" row has nothing to allocate). */
function allocateWholePercent(values: (number | undefined)[]): (number | undefined)[] {
  const real = values.filter((v): v is number => v !== undefined);
  if (real.length === 0) return values;
  const target = Math.round(real.reduce((a, b) => a + b, 0));
  const floors = values.map((v) => (v === undefined ? undefined : Math.floor(v)));
  const flooredSum = floors.reduce<number>((a, b) => a + (b ?? 0), 0);
  let remaining = target - flooredSum;
  const order = values
    .map((v, i) => ({ i, frac: v === undefined ? -1 : v - Math.floor(v) }))
    .filter((o) => o.frac >= 0)
    .sort((a, b) => b.frac - a.frac);
  const result = [...floors];
  for (let k = 0; k < order.length && remaining > 0; k++, remaining--) {
    result[order[k].i]! += 1;
  }
  return result;
}

const PIPELINE_KINDS = new Set(['pipeline', 'prePipeline', 'postPipeline']);
// Bytes are scoped to Source and Destination only — every other kind is events-only now, both in
// the Volume section and (implicitly, since only Destination rows ever carry `inBytes`) the
// Sources table below.
const BYTES_KINDS = new Set(['source', 'destination']);

/** Single series for a Source or a Route rule row; a real per-source multi-series split (one line
 *  per row already listed in this component's own Sources table) for every other kind — the same
 *  shape the real Signal Path drawer uses. Deliberately a *simpler* per-source signal than that
 *  real drawer's own `route.in_events` (split by route+input, scoped to exactly this one path):
 *  each line here is that Source's own overall `total.in_events` trend, since this page's own Sources
 *  table doesn't carry which specific rule attributes each row (only which Pipeline(s), for
 *  Destination rows) — an honest, simpler substitute, not a precise per-path series. */
function useTrendSeries(
  node: GraphNode | undefined,
  ruleId: string | undefined,
  stats: ComponentStats | undefined,
  bundle: RawTopologyBundle | undefined,
  groupId: string | undefined,
  earliest: number,
  latest: number,
): TrendSeries[] {
  const [series, setSeries] = useState<TrendSeries[]>([]);
  const sourceKey = (stats?.sources ?? []).map((s) => s.sourceNodeId).join(',');

  useEffect(() => {
    setSeries([]);
    if (!groupId) return;
    let cancelled = false;

    async function run() {
      // 60 buckets, not `fetchTrend`'s own 30-bucket default — matches the real Signal Path
      // drawer's own established granularity increase for this same chart.
      const TREND_BUCKETS = 60;
      if (ruleId) {
        const points = await fetchTrend({
          metric: 'route.in_events',
          groupId: groupId!,
          dimFilter: `route=='${escapeFilterLiteral(ruleId)}'`,
          earliest,
          latest,
          buckets: TREND_BUCKETS,
        }).catch(() => []);
        if (!cancelled) setSeries([{ id: ruleId, label: 'Events', points }]);
        return;
      }
      if (!node) return;
      if (node.kind === 'source') {
        const type = node.refType;
        if (!type) return;
        const dimFilter = `input=='${escapeFilterLiteral(`${type}:${realRawIdOf(node.id)}`)}'`;
        const points = await fetchTrend({ metric: 'total.in_events', groupId: groupId!, dimFilter, earliest, latest, buckets: TREND_BUCKETS }).catch(() => []);
        if (!cancelled) setSeries([{ id: node.id, label: node.label, points }]);
        return;
      }
      const rows = stats?.sources ?? [];
      if (rows.length === 0) return;
      const inputTypeByRawId = new Map((bundle?.inputs ?? []).map((i) => [i.id, i.type]));
      const results = await Promise.all(
        rows.map(async (s): Promise<TrendSeries | undefined> => {
          const type = inputTypeByRawId.get(s.label);
          if (!type) return undefined;
          const dimFilter = `input=='${escapeFilterLiteral(`${type}:${s.label}`)}'`;
          const points = await fetchTrend({ metric: 'total.in_events', groupId: groupId!, dimFilter, earliest, latest, buckets: TREND_BUCKETS }).catch(() => []);
          return { id: s.sourceNodeId, label: s.label, points };
        }),
      );
      if (!cancelled) setSeries(results.filter((r): r is TrendSeries => r !== undefined));
    }

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sourceKey` stands in for `stats.sources`.
  }, [node?.id, node?.kind, ruleId, groupId, earliest, latest, sourceKey, bundle]);

  return series;
}

/**
 * A Destination's own real `blocked.outputs` trend — single series, "own blocks only" per direct
 * instruction, a separate chart from the Trend section's own volume series above. Reuses the same
 * generic `fetchTrend`/`api/metrics.ts` mechanism the Trend chart already uses (the group-wide
 * aggregated metrics store, filtered to just this one Destination's own `output` dimension) rather
 * than the Overview page's own `WorkerNodeDrawer.tsx`/`fetchWorkerRawMetricsTrend` (a per-*worker*
 * raw-metrics endpoint) — this drawer isn't scoped to one specific worker the way that one is, and
 * this file's own established architecture deliberately stays on generic, pure `api/metrics.ts`
 * pieces (see this file's own top doc comment).
 *
 * Real, confirmed platform limitation, not a bug here: `blocked.outputs` genuinely works through
 * this same aggregated-store path for a Stream Destination, but is **never** aggregated into that
 * store for an Edge Fleet at all — confirmed live at every split, not just missing a per-worker
 * dimension (see `WorkerNodeTrendPoint.blockedByOutput`'s own doc comment in `api/workerInfo.ts`
 * for the live evidence). An Edge Destination's own fetch here always comes back empty as a real
 * consequence of that gap, not a fetch failure — resolved the same honest way as a Stream
 * Destination that's simply never been blocked: no real nonzero value anywhere in the window means
 * no section renders at all, rather than a permanently-empty "not enough data" placeholder on every
 * healthy Destination.
 *
 * A second, independent gate — `destinationIsConnectedAndFed`, computed where this hook's own
 * result is consumed — additionally hides the whole section for a Destination that's real but
 * genuinely unrouted: some connector types (confirmed live: `tcpjson`) report a real, nonzero
 * `blocked.outputs` count purely from periodic failed reconnect attempts, with no live Route/
 * QuickConnect wiring and zero real data behind it at all — this hook alone can't tell that case
 * apart from a genuinely blocked, connected Destination, since both produce real nonzero points.
 */
function useDestinationBlockedTrend(node: GraphNode | undefined, groupId: string | undefined, earliest: number, latest: number): TrendSeries[] {
  const [series, setSeries] = useState<TrendSeries[]>([]);

  useEffect(() => {
    setSeries([]);
    if (!node || node.kind !== 'destination' || !groupId) return;
    const type = node.refType;
    if (!type) return;
    let cancelled = false;
    const dimFilter = `output=='${escapeFilterLiteral(`${type}:${realRawIdOf(node.id)}`)}'`;
    fetchTrend({ metric: 'blocked.outputs', groupId, dimFilter, earliest, latest, buckets: 60 })
      .then((points) => {
        if (cancelled) return;
        setSeries(points.some((p) => p.v > 0) ? [{ id: node.id, label: 'Blocked', points }] : []);
      })
      .catch(() => {
        if (!cancelled) setSeries([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `node?.id`/`node?.kind`/`node?.refType` stand in for `node`, same as `useTrendSeries` above.
  }, [node?.id, node?.kind, node?.refType, groupId, earliest, latest]);

  return series;
}

export interface NodeDetailPanelProps {
  loading: boolean;
  stats: ComponentStats | undefined;
  /** Used for its `raw` config (pipeline functions), `kind` (which sections/units apply), and real
   *  id (worker status/trend fetches). `undefined` when a Route rule row is selected instead — see
   *  `ruleId`. */
  node?: GraphNode;
  /** Route rule selection only — `node` is `undefined` in that case (a rule row isn't a `GraphNode`
   *  of its own; see the connection-drawing rule this page already follows). */
  ruleId?: string;
  /** For resolving a Source's own real connector `type` (needed to build a real `input` dimension
   *  filter for the Trend chart) — the same bundle already fetched at the page level. */
  bundle?: RawTopologyBundle;
  groupId?: string;
  earliest: number;
  latest: number;
  /** Pipeline-role nodes only — real per-function processing-error log entries for this Pipeline,
   *  see `useFunctionErrors`. */
  functionErrors?: FunctionErrorLogEntry[];
  /** Source/Destination directly, Output Router rolled up from its real targets — computed once at
   *  the page level (`useWorkerStatus`/`workerRowsForNode`) and passed down here, rather than
   *  fetched again on every drawer open. `undefined` for a Route rule row or any other kind with no
   *  real op-status signal. */
  workerRows?: WorkerStatusRow[];
  /** This selection's own real product ('stream' | 'edge'), resolved by `SignalPathPage.tsx` from
   *  `groupId` against `state.workerGroups` — picks "Worker"/"Node" wherever `workerRows` is
   *  described (the "Per-worker status" heading, its own table's Worker/Node column, the Why box's
   *  own sentence). Defaults to `'stream'` when omitted, this component's own prior behavior. */
  product?: GroupProductFilter;
}

export function NodeDetailPanel({ loading, stats, node, ruleId, bundle, groupId, earliest, latest, functionErrors, workerRows, product = 'stream' }: NodeDetailPanelProps) {
  const [tableUnit, setTableUnit] = useState<'events' | 'bytes'>('events');
  const pipelineFunctions =
    node && PIPELINE_KINDS.has(node.kind) ? (node.raw as { conf: { functions?: RawPipelineFunction[] } } | undefined)?.conf.functions : undefined;
  const isPipelineRole = node !== undefined && PIPELINE_KINDS.has(node.kind);
  const showBytes = node !== undefined && BYTES_KINDS.has(node.kind);
  // Only a Destination's own Sources table ever has a real per-source bytes breakdown to switch
  // to (`route.in_bytes` split by route+input) — every other kind's rows never carry `inBytes` at
  // all, so the local switcher has nothing to do there.
  const sourcesHaveBytes = stats !== undefined && stats.sources.length > 0 && stats.sources[0].inBytes !== undefined;
  // Any row, not just the first — an Output Router "Multiple Sources" row (real Pipeline
  // genuinely not attributable — `pipelines: undefined`) can now sit alongside normal rows that
  // do carry one, in either sort position depending on volume.
  const showPipelineColumn = (stats?.sources ?? []).some((s) => s.pipelines !== undefined);
  // Only an Output Router's own rolled-up rows ever carry a `destinationLabel` (more than one real
  // target concatenated together) — a plain Source/Destination's own rows never do.
  const showDestinationColumn = (workerRows ?? []).some((r) => r.destinationLabel !== undefined);

  // Same two real conditions `lib/topology.ts`'s `connectedAndFedDestinationKeys` already gates
  // the Overview page's own "Blocked" count/chart on, re-derived here from this drawer's own
  // established data instead of that real-topology-graph helper (Signal Path's own config-only model — see this
  // file's top doc comment — has no `FlowGraph`/`GraphEdge` to walk). `stats.sources` (the same
  // rows the "Sources" table below already renders) is only ever non-empty for a Destination a
  // real Route rule or QuickConnect connection actually targets (built from `bundle.routeTables`/
  // `input.connections` — see `topologyConfigOnlyMetrics.ts`'s own `destAgg` pass; an unrouted
  // Destination never gets an entry there at all, so its `sources` stays permanently `[]`) — that
  // alone is condition 1. Condition 2 needs an explicit nonzero check on top: `shareRowsDestination`
  // includes a row for *every* real connection regardless of its own observed volume, so a
  // genuinely-connected-but-currently-idle Destination would otherwise still pass with an all-zero
  // row set.
  const destinationIsConnectedAndFed = (stats?.sources ?? []).some((s) => (s.inEvents ?? 0) > 0 || (s.inBytes ?? 0) > 0);

  const trendSeries = useTrendSeries(node, ruleId, stats, bundle, groupId, earliest, latest);
  const blockedTrendSeries = useDestinationBlockedTrend(node, groupId, earliest, latest);

  // The same real per-worker error/backlog data already driving `NodeCardWorkerAlertBadge`'s own
  // hover panel (a genuine problem — every worker's real, or nothing to report — no Why box for a
  // healthy component). Pipeline processing errors get their own, simpler explanation from the
  // same `stats.errEvents` figure the "Processing Errors" section below already shows — a real
  // failure, not the intentional-drop framing `ReductionValue` uses elsewhere in this drawer.
  const workerWhy = explainWorkerRows(workerRows, product);
  const pipelineWhy =
    stats && stats.errEvents !== undefined && stats.errEvents > 0
      ? `This Pipeline has thrown ${formatMetric(stats.errEvents, 'events')} of real processing errors in the selected window — a genuine failure, not an intentional drop.`
      : undefined;
  const why = workerWhy ?? pipelineWhy;
  // The box's own label reads the real status word driving it — the health behind `workerWhy`
  // when there is one, or a plain "Error" for `pipelineWhy` (processing errors have no equivalent
  // health state of their own in this app's vocabulary — see `NodeCard.tsx`'s own comment on
  // why `errEvents` never feeds `health`).
  const whyLabel = workerWhy ? HEALTH_LABEL[healthFromWorkerRows(workerRows)].toUpperCase() : pipelineWhy ? 'ERROR' : undefined;
  // The box's own background/label color, driven by that same real status — `warning` for a
  // degraded (partially blocked) worker set, `danger` for a fully blocked one or a genuine
  // Pipeline processing error (no equivalent "warning" tier for that case — a real thrown error
  // is always treated as the same severity the box's own default danger tint already implied).
  const whyAppearance = workerWhy ? HEALTH_APPEARANCE[healthFromWorkerRows(workerRows)] : pipelineWhy ? 'danger' : undefined;

  // "Blocked since" — the worst real worker's own `lastFlushTime` (confirmed live to be a sane,
  // comparable wall-clock value, unlike the same API's own unreliable `blockedSince` field — see
  // `WorkerStatusRow.blockedSince`'s own doc comment). Only shown for a genuinely Red worker; a
  // merely Yellow/degraded one has no real "blocked since" moment to report.
  const blockedWorker = (workerRows ?? []).find((r) => r.health === 'Red' && r.lastFlushTime !== undefined);
  const blockedSinceText = blockedWorker?.lastFlushTime !== undefined ? formatTimestamp(blockedWorker.lastFlushTime) : undefined;

  // The blocked/degraded Why box's own "Open in Cribl" link goes straight to that component's real
  // Status tab (`?tab=status`) — the tab that actually shows the per-worker Connected/Buffered/
  // Error detail this box is already summarizing — rather than the plain config page every other
  // redirect icon in this app opens. Only added for the worker-driven case (`workerWhy`, i.e. a
  // genuine Source/Destination/Output Router op-status problem — `OP_STATUS_KINDS`); a Pipeline's
  // own processing-error Why has no equivalent per-worker Status tab to send it to, so that case
  // keeps the plain `node.configPath`.
  //
  // Edge has no `?tab=status` (or any `/stream/m/...`-shaped page) at all — `node.configPath` is
  // always built Stream-shaped (`criblConfigPath`), which 404s for a Fleet. The real Edge
  // equivalent of "this worker's own live connection detail" is that specific Node's own info
  // page (`criblEdgeNodeInfoPath`), keyed by the worst real worker's own id, not the Fleet/group id
  // `node.configPath` is scoped to — so this is a different URL shape entirely, not just a
  // different query string.
  const worstWorker = product === 'edge' ? worstWorkerRow(workerRows) : undefined;
  const configPath =
    product === 'edge' && workerWhy && worstWorker && groupId
      ? criblEdgeNodeInfoPath(groupId, worstWorker.workerId)
      : node?.configPath && workerWhy
        ? `${node.configPath}?tab=status`
        : node?.configPath;

  return (
    <div className="node-detail-panel">
      {loading && (
        <div style={{ padding: '16px 0' }}>
          <Spinner size="md" title="Loading real volume data…" />
        </div>
      )}

      {!loading && stats && (
        <>
          {why && (
            <div className={`node-detail-why-box node-detail-why-box--${whyAppearance}`}>
              <span className="node-detail-why-label">{whyLabel}</span>
              <p>{why}</p>
              {blockedSinceText && (
                <p className="node-detail-why-blocked-since">
                  Blocked since <span className="node-detail-why-blocked-since-value">{blockedSinceText}</span>
                </p>
              )}
              {configPath && (
                <div className="node-detail-why-actions">
                  <Tooltip title="Open in Cribl" placement="top">
                    <CustomTooltipTrigger>
                      <IconButton
                        icon={ArrowUpRightFromSquare}
                        aria-label="Open in Cribl"
                        size="sm"
                        variant="secondary"
                        onClick={() => window.open(configPath, '_blank', 'noopener,noreferrer')}
                      />
                    </CustomTooltipTrigger>
                  </Tooltip>
                </div>
              )}
            </div>
          )}

          <div className="node-detail-section">
            <div className="node-detail-section-head">
              <span className="node-detail-section-title">Volume</span>
            </div>
            <div className="node-detail-card">
              <div className="node-detail-card-body">
                <table className="node-detail-data-table">
                  <thead>
                    <tr>
                      <th className="node-detail-th-left" />
                      <th className="node-detail-th-num">In</th>
                      <th className="node-detail-th-num">Out</th>
                      {isPipelineRole && <th className="node-detail-th-num">Reduction</th>}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="node-detail-td-left">
                        <Text as="span" variant="body-xs-normal" color="subtle">
                          Events
                        </Text>
                      </td>
                      <td className="node-detail-td-num">{statCell(stats.inEvents, 'events')}</td>
                      <td className="node-detail-td-num">{statCell(stats.outEvents, 'events')}</td>
                      {isPipelineRole && (
                        <td className="node-detail-td-num">
                          <ReductionValue inValue={stats.inEvents ?? 0} outValue={stats.outEvents ?? 0} />
                        </td>
                      )}
                    </tr>
                    {showBytes && (
                      <tr>
                        <td className="node-detail-td-left">
                          <Text as="span" variant="body-xs-normal" color="subtle">
                            Bytes
                          </Text>
                        </td>
                        <td className="node-detail-td-num">{statCell(stats.inBytes, 'bytes')}</td>
                        <td className="node-detail-td-num">{statCell(stats.outBytes, 'bytes')}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Pipeline-role nodes only (`stats.errEvents` is `undefined` for every other kind).
              Shown even at 0, unlike the card's own compact badge, which only appears when
              there's something to flag — the drawer is where a user checks full detail, so a
              confirmed-clean "0" is useful information here, not clutter. */}
          {stats.errEvents !== undefined && (
            <div className="node-detail-section">
              <div className="node-detail-section-head">
                <span className="node-detail-section-title">Processing Errors</span>
              </div>
              <div className="node-detail-card">
                <div className="node-detail-card-body">
                  <Text
                    as="span"
                    variant="body-sm-semibold"
                    FORCE__className={`node-detail-status node-detail-status--${stats.errEvents > 0 ? 'danger' : 'success'}`}
                  >
                    {formatMetric(stats.errEvents, 'events')}
                  </Text>
                  <div style={{ marginTop: 6 }}>
                    <Text as="p" variant="body-xs-normal" color="subtle">
                      Function/processing errors this Pipeline has thrown in the selected window — a real error, not an intentional drop.
                    </Text>
                  </div>
                </div>
              </div>
            </div>
          )}

          {(node !== undefined || ruleId !== undefined) && (
            <div className="node-detail-section">
              <div className="node-detail-section-head">
                <span className="node-detail-section-title">Trend</span>
              </div>
              <div className="node-detail-card">
                <div className="node-detail-card-body">
                  <TrendChart series={trendSeries} formatValue={(v) => formatMetric(v, 'events')} />
                </div>
              </div>
            </div>
          )}

          {/* Destination only, only once there's a real nonzero blocked count somewhere in the
              window (see `useDestinationBlockedTrend`'s own doc comment for why a healthy
              Destination, or an Edge one this metric was never aggregated for at all, simply gets
              no section here rather than a permanently-empty placeholder), and only once the
              Destination is itself genuinely connected and fed (`destinationIsConnectedAndFed`
              above) — a real, live-confirmed platform gap means some connector types (e.g.
              `tcpjson`) report a real, climbing `blocked.outputs` count purely from periodic failed
              reconnect attempts, even for a Destination with no live wiring and zero real data ever
              passing through it. Without this check, opening that one Destination's own drawer
              would still show a "Blocked" chart even though the Overview page's own roster count
              and per-worker chart both already exclude it as noise — the same real signal, just
              read from this drawer's own data shape instead of a `FlowGraph`. */}
          {node?.kind === 'destination' && destinationIsConnectedAndFed && blockedTrendSeries.length > 0 && (
            <div className="node-detail-section">
              <div className="node-detail-section-head">
                <span className="node-detail-section-title">Blocked</span>
              </div>
              <div className="node-detail-card">
                <div className="node-detail-card-body">
                  <TrendChart series={blockedTrendSeries} formatValue={(v) => Math.round(v).toLocaleString()} />
                </div>
              </div>
            </div>
          )}

          <div className="node-detail-section">
            <div className="node-detail-section-head">
              <span className="node-detail-section-title">Sources ({stats.sources.length})</span>
              {sourcesHaveBytes && (
                <div className="segmented node-detail-card-actions" role="group" aria-label="Sources table metric">
                  <button type="button" className={tableUnit === 'events' ? 'active' : ''} aria-pressed={tableUnit === 'events'} onClick={() => setTableUnit('events')}>
                    Events
                  </button>
                  <button type="button" className={tableUnit === 'bytes' ? 'active' : ''} aria-pressed={tableUnit === 'bytes'} onClick={() => setTableUnit('bytes')}>
                    Bytes
                  </button>
                </div>
              )}
            </div>
            <div className="node-detail-card">
              <div className="node-detail-card-body">
                {stats.sources.length === 0 ? (
                  <span className="node-detail-empty">No source attribution observed for this component in the selected time range.</span>
                ) : (
                  <div className="node-detail-table-scroll">
                    <table className="node-detail-data-table">
                      <thead>
                        <tr>
                          <th className="node-detail-th-left">Source</th>
                          {/* Checked across every row, not just the first (sorted-by-volume) one —
                              a target reached partly via an Output Router's own honest "Multiple
                              Sources" row (real Pipeline genuinely not attributable — N/A) can now
                              sit alongside normal rows that do have a real Pipeline, and either one
                              can sort to the top depending on volume. */}
                          {showPipelineColumn && <th className="node-detail-th-left">Pipeline</th>}
                          <th className="node-detail-th-num">In</th>
                          <th className="node-detail-th-num">Out</th>
                          <th className="node-detail-th-num">Share</th>
                          <th className="node-detail-th-num">Last Event</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          const useBytes = sourcesHaveBytes && tableUnit === 'bytes';
                          // Allocated once across every row in the table, not per row independently
                          // — see `allocateWholePercent`'s own doc comment for why a plain per-row
                          // `Math.round()` can drift the displayed total a point or two off 100%.
                          const allocatedPcts = allocateWholePercent(stats.sources.map((s) => (useBytes ? s.pctBytes : s.pctEvents)));
                          return stats.sources.map((s, i) => {
                            const inValue = useBytes ? s.inBytes : s.inEvents;
                            const outValue = useBytes ? s.outBytes : s.outEvents;
                            const pct = allocatedPcts[i];
                            return (
                              <tr key={s.sourceNodeId}>
                                <td className="node-detail-td-left">{s.label}</td>
                                {showPipelineColumn && (
                                  <td className="node-detail-td-left">{s.pipelines === undefined ? 'N/A' : s.pipelines.length > 0 ? s.pipelines.join(', ') : '—'}</td>
                                )}
                                <td className="node-detail-td-num">{inValue !== undefined ? formatMetric(inValue, useBytes ? 'bytes' : 'events') : 'n/a'}</td>
                                <td className="node-detail-td-num">{outValue !== undefined ? formatMetric(outValue, useBytes ? 'bytes' : 'events') : 'n/a'}</td>
                                <td className="node-detail-td-num">{pct !== undefined ? `${pct}%` : 'n/a'}</td>
                                <td className="node-detail-td-right">{s.lastEventMs !== undefined ? formatTimestamp(s.lastEventMs) : '—'}</td>
                              </tr>
                            );
                          });
                        })()}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>

          {pipelineFunctions && (
            <div className="node-detail-section">
              <div className="node-detail-section-head">
                <span className="node-detail-section-title">Functions ({pipelineFunctions.length})</span>
              </div>
              <div className="node-detail-card">
                <div className="node-detail-card-body">
                  {pipelineFunctions.length === 0 ? (
                    <span className="node-detail-empty">No functions configured.</span>
                  ) : (
                    <div className="node-detail-table-scroll">
                      <table className="node-detail-data-table">
                        <thead>
                          <tr>
                            <th className="node-detail-th-num">#</th>
                            <th className="node-detail-th-left">Function</th>
                            <th className="node-detail-th-left">Filter</th>
                            {/* Deliberately unnamed — a lone Final tag doesn't need a column header
                                to be self-explanatory, and a real label here would just repeat the
                                tag's own text right below it. */}
                            <th className="node-detail-th-left" aria-label="Final" />
                            <th className="node-detail-th-left">Flags</th>
                            <th className="node-detail-th-num">Errors</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pipelineFunctions.map((fn, i) => {
                            const fnErrors = (functionErrors ?? []).filter((e) => e.functionZeroIndex === i);
                            return (
                              <tr key={`${fn.id}-${i}`} className={fn.disabled ? 'is-disabled' : undefined}>
                                <td className="node-detail-td-num">{i + 1}</td>
                                <td className="node-detail-td-left">
                                  <Text as="span" variant="body-sm-semibold">
                                    {fn.id}
                                  </Text>
                                  {fn.id === 'chain' && fn.conf?.processor && (
                                    <Text as="span" variant="body-xs-normal" color="subtle">
                                      {' '}
                                      → {fn.conf.processor}
                                    </Text>
                                  )}
                                </td>
                                <td className="node-detail-td-left node-detail-function-filter-cell">{fn.filter && fn.filter !== 'true' ? fn.filter : '—'}</td>
                                <td className="node-detail-td-left">{fn.final && <span className="node-detail-flag node-detail-flag--final">Final</span>}</td>
                                <td className="node-detail-td-left">
                                  <div className="node-detail-function-flags">
                                    <span className="node-detail-flag node-detail-flag--disabled">{fn.disabled ? 'Disabled' : 'Enabled'}</span>
                                  </div>
                                </td>
                                <td className="node-detail-td-num node-detail-function-errors-cell">
                                  {fnErrors.length > 0 ? (
                                    <FunctionErrorHover
                                      entries={fnErrors}
                                      ariaLabel={`${fnErrors.length} error${fnErrors.length === 1 ? '' : 's'} for ${fn.id} — press Enter for details`}
                                      className="node-detail-function-errors-count node-detail-function-errors-count--danger"
                                    >
                                      {fnErrors.length}
                                    </FunctionErrorHover>
                                  ) : (
                                    <span className="node-detail-function-errors-count">0</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Persistent Queue detail — ported from the real Signal Path drawer, reading real per-
              worker PQ data that was already being fetched here for op-status (`WorkerStatusRow.pq`,
              populated by `fetchWorkerStatusesForInputs`/`fetchWorkerStatusesForOutputs`, the exact
              same shared, real functions the real page's own on-demand fetch uses) — no new fetch
              needed, only the section itself was missing. Unlike the real page, there's no separate
              group-scoped `node.pq` field here to anchor a top-level health line on (this page never
              fetches that endpoint at all) — gated purely on whether any real worker actually
              reports PQ data at all, i.e. PQ is enabled on this component. */}
          {node !== undefined && workerRows && workerRows.some((r) => r.pq) && (
            <div className="node-detail-section">
              <div className="node-detail-section-head">
                <span className="node-detail-section-title">Persistent Queue</span>
              </div>
              <div className="node-detail-card">
                <div className="node-detail-card-body">
                  <Text as="p" variant="body-xs-normal" color="subtle">
                    Cribl doesn't report a historical queue-depth series for persistent queues, so this can't be
                    plotted as a trend the way volume is above — each {WORKER_NOUN[product].toLowerCase()}'s own live
                    snapshot below (including current size/backlog, when Cribl reports one for this connector) is
                    shown as Metrics.
                  </Text>
                  <div className="node-detail-table-scroll">
                    <table className="node-detail-data-table node-detail-data-table--worker-status">
                      <thead>
                        <tr>
                          <th className="node-detail-th-left">{WORKER_NOUN[product]}</th>
                          <th className="node-detail-th-left">PQ Health</th>
                          <th className="node-detail-th-left">Metrics</th>
                          <th className="node-detail-th-left">Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workerRows
                          .filter((row) => row.pq)
                          .map((row, i) => {
                            const pqHealth = row.pq?.health !== undefined ? String(row.pq.health) : 'Unknown';
                            const appearance = WORKER_HEALTH_APPEARANCE[pqHealth] ?? 'default';
                            const metricsText = row.pq?.metrics
                              ? Object.entries(row.pq.metrics)
                                  .map(([k, v]) => `${k}: ${String(v)}`)
                                  .join(', ')
                              : undefined;
                            return (
                              <tr key={`${row.workerId}:${i}`} className={`node-detail-worker-row--${appearance}`} title={pqHealth}>
                                <td className="node-detail-td-left">{row.hostname ?? row.workerId}</td>
                                <td className="node-detail-td-left">
                                  <span className={`node-detail-pq-health node-detail-pq-health--${appearance}`}>{pqHealth}</span>
                                </td>
                                <td className="node-detail-td-left node-detail-function-filter-cell">{metricsText ?? '—'}</td>
                                <td className="node-detail-td-left node-detail-function-filter-cell">{row.pq?.error ?? '—'}</td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}

          {node !== undefined && (node.kind === 'source' || node.kind === 'destination' || node.kind === 'outputRouter') && workerRows && workerRows.length > 0 && (
            <div className="node-detail-section">
              <div className="node-detail-section-head">
                <span className="node-detail-section-title">
                  Per-{WORKER_NOUN[product].toLowerCase()} status ({workerRows.length})
                </span>
              </div>
              <div className="node-detail-card">
                <div className="node-detail-card-body">
                  <div className="node-detail-table-scroll">
                    <table className="node-detail-data-table node-detail-data-table--worker-status">
                      <thead>
                        <tr>
                          {showDestinationColumn && <th className="node-detail-th-left">Destination</th>}
                          <th className="node-detail-th-left">{WORKER_NOUN[product]}</th>
                          <th className="node-detail-th-left">Connected</th>
                          <th className="node-detail-th-left">Buffered</th>
                          <th className="node-detail-th-left">Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workerRows.map((row, i) => {
                          const appearance = row.health ? WORKER_HEALTH_APPEARANCE[row.health] : 'default';
                          return (
                            <tr key={`${row.destinationLabel ?? ''}:${row.workerId}:${i}`} className={`node-detail-worker-row--${appearance}`} title={row.health ?? 'Unknown'}>
                              {showDestinationColumn && <td className="node-detail-td-left">{row.destinationLabel ?? '—'}</td>}
                              <td className="node-detail-td-left">{row.hostname ?? row.workerId}</td>
                              <td className="node-detail-td-left">{row.connected === undefined ? '—' : row.connected ? 'Yes' : 'No'}</td>
                              <td className="node-detail-td-left">
                                {row.bufferedBytes !== undefined
                                  ? `${formatBytes(row.bufferedBytes)}${row.bufferedEvents !== undefined ? ` (${formatMetric(row.bufferedEvents, 'events')})` : ''}`
                                  : '—'}
                              </td>
                              <td className="node-detail-td-left node-detail-function-filter-cell">
                                {row.error ? (
                                  <div className="node-detail-worker-error">
                                    <span className="node-detail-worker-error-message">{row.error.message}</span>
                                    {row.error.detail && <span className="node-detail-worker-error-underlying">{row.error.detail}</span>}
                                  </div>
                                ) : (
                                  '—'
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
