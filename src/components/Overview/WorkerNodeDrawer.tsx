import { useEffect, useState } from 'react';
import { Drawer, IconButton, Spinner, Text } from '@capra/core';
import { CloseOutlined } from '@capra/icons';
import type { WorkerFleetRow } from '../../lib/workerHealth';
import { fetchWorkerRawMetricsTrend, type WorkerNodeTrendPoint } from '../../api/workerInfo';
import { listOutputs } from '../../api/topology';
import { metricsKey } from '../../lib/topology';
import { formatBytes, formatMetric, formatUptime } from '../../lib/format';
import type { GroupProductFilter, VolumeUnit } from '../../lib/types';
import { WORKER_NOUN } from '../../lib/productTerms';
import { TrendChart, type TrendSeries } from '../TrendChart';
import './WorkerNodeDrawer.css';

/** A trend point's own field, filtered down to just the points that actually carry it and mapped
 *  to `TrendSeries`' own plain `{t, v}` shape — a bucket missing one series (e.g. a `cpuPct` read
 *  that failed to parse for one interval) just doesn't contribute a point there, rather than
 *  plotting a fabricated zero. */
function seriesFrom(points: WorkerNodeTrendPoint[], key: keyof WorkerNodeTrendPoint, id: string, label: string): TrendSeries | undefined {
  const series = points.filter((p) => p[key] !== undefined).map((p) => ({ t: p.t, v: p[key] as number }));
  return series.length >= 2 ? { id, label, points: series } : undefined;
}

/** One series per real Destination this node has ever reported a `blocked.outputs` count for
 *  (`WorkerNodeTrendPoint.blockedByOutput`, keyed by the raw `type:id` metrics dimension) —
 *  resolved to a real, bare display label via `labelByKey` (built from `listOutputs()`, falling
 *  back to the raw key itself if a Destination was since removed/renamed). Deliberately excludes a
 *  Destination that's never actually had a nonzero blocked count in this window — an always-clean
 *  Destination contributes a flat, uninformative line to a chart that's specifically about *blocks*,
 *  and would otherwise burn one of the chart's own 10 real color slots for nothing.
 *
 *  Also excludes a Destination that isn't in `connectedAndFedKeys` (`undefined` skips this check
 *  entirely — the flow graph hasn't loaded yet) — the same real, live-confirmed noise this app's
 *  "Blocked" count itself now filters (`lib/topology.ts`'s `connectedAndFedDestinationKeys`): some
 *  connector types report a real, climbing `blocked.outputs` count purely from periodic failed
 *  reconnect attempts, even for a Destination with no live Route/QuickConnect wiring and zero real
 *  data ever passing through it. */
function blockedSeriesFrom(points: WorkerNodeTrendPoint[], labelByKey: Map<string, string>, connectedAndFedKeys: Set<string> | undefined): TrendSeries[] {
  const outputKeys = new Set<string>();
  for (const p of points) {
    if (p.blockedByOutput) for (const key of Object.keys(p.blockedByOutput)) outputKeys.add(key);
  }
  const series: TrendSeries[] = [];
  for (const key of outputKeys) {
    if (connectedAndFedKeys && !connectedAndFedKeys.has(key)) continue;
    const seriesPoints = points.filter((p) => p.blockedByOutput?.[key] !== undefined).map((p) => ({ t: p.t, v: p.blockedByOutput![key] }));
    if (seriesPoints.length < 2 || !seriesPoints.some((p) => p.v > 0)) continue;
    series.push({ id: key, label: labelByKey.get(key) ?? key, points: seriesPoints });
  }
  return series;
}

interface WorkerNodeDrawerProps {
  /** `undefined` closes the drawer — same "selection drives open state" shape this app's other
   *  drawers (Signal Path's `NodeDetailPanel`) already use. */
  row: WorkerFleetRow | undefined;
  /** The row's own Worker Group's real, currently-deployed config version — `undefined` if that
   *  group's own `configVersion` wasn't resolved (an older org, a permissions gap), in which case
   *  the config-drift check is shown as unknown rather than a false "up to date"/"stale" verdict. */
  groupConfigVersion: string | undefined;
  unit: VolumeUnit;
  onClose: () => void;
  /** This node's own real product ('stream'/'edge'), resolved by `OverviewPage.tsx` from
   *  `groupInfoById` via `row.group`. Defaults to `'stream'` when omitted, this component's own
   *  prior always-"Worker" behavior. */
  product?: GroupProductFilter;
  /** From `OverviewPage.tsx`'s own `connectedAndFedDestinationKeys(flowGraph)` — real Destinations
   *  that are both actually reachable and actually fed, used to filter the "Blocked (by
   *  destination)" chart's own series the same way the roster's "Blocked" count already is (see
   *  `blockedSeriesFrom`'s own doc comment). `undefined` while the flow graph hasn't loaded yet. */
  connectedAndFedOutputKeys?: Set<string>;
}

/**
 * Per-node detail — deployed config vs. the group's own real target (a genuine drift check, not
 * just informational), license limits, any node-reported messages, and build/OS identity, all read
 * straight off the same `/system/info` snapshot already fetched for the roster's own CPU/mem/disk
 * columns (`row.nodeInfo` — no second fetch needed for any of that). The one thing that *is*
 * fetched fresh on open is the best-effort historical trend (`fetchWorkerRawMetricsTrend`) — kept
 * lazy and drawer-only per explicit direction, since its own payload is multi-megabyte per node.
 *
 * The Trend section — heading included, not just its own content — only ever renders while a real
 * fetch is pending or has actually returned something plottable (`showTrendSection` below); any
 * failure (org doesn't expose this undocumented internal endpoint, it's been changed/discontinued,
 * a reshaped response) or a technically-successful-but-empty result both resolve to rendering
 * nothing at all for Trend, by explicit direction — a labeled section with an explanatory "not
 * available" message still reads as something broken worth investigating, and this data source is
 * neither documented nor guaranteed to keep working the same way indefinitely. Every other section
 * in this drawer is unaffected either way.
 *
 * "Blocked (by destination)" is the same Trend section's own last chart, one series per real
 * Destination this node has ever reported a nonzero `blocked.outputs` count for in the fetched
 * window — built from the exact same `fetchWorkerRawMetricsTrend()` response every other chart
 * here reads, not a second fetch. Deliberately built on this per-node raw-metrics endpoint rather
 * than the aggregated metrics store (`api/workerMetrics.ts`'s `fetchWorkerBlockedTotals`, which
 * backs this node's own "Blocked" count in the roster): confirmed live that `blocked.outputs` is
 * never aggregated into that store for an Edge Fleet at all (not even without a per-worker split —
 * see `WorkerNodeTrendPoint.blockedByOutput`'s own doc comment), so this chart would otherwise
 * silently never render for Edge. Reusing this already-working, per-node endpoint instead — the
 * same one CPU/Mem/Disk/Volume above already depend on for the identical reason — gives real parity
 * for both products. Its own series are filtered by `connectedAndFedOutputKeys` the same way the
 * roster's own "Blocked" count now is — see `blockedSeriesFrom`'s own doc comment.
 */
export function WorkerNodeDrawer({ row, groupConfigVersion, unit, onClose, product = 'stream', connectedAndFedOutputKeys }: WorkerNodeDrawerProps) {
  const nodeNoun = WORKER_NOUN[product];
  const [trend, setTrend] = useState<WorkerNodeTrendPoint[] | undefined>(undefined);
  const [trendStatus, setTrendStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');

  const workerId = row?.id;
  useEffect(() => {
    setTrend(undefined);
    setTrendStatus(row ? 'loading' : 'idle');
    if (!row) return;
    let cancelled = false;
    fetchWorkerRawMetricsTrend(row.id).then((points) => {
      if (cancelled) return;
      setTrend(points);
      setTrendStatus(points ? 'ready' : 'unavailable');
    });
    return () => {
      cancelled = true;
    };
    // `workerId` stands in for `row` here: only a genuinely different worker (or the drawer
    // closing) should re-trigger the trend fetch, not `row` gaining a new object identity on
    // every fleet refresh while still naming the same worker — the same established `xKey`
    // stand-in pattern this app already uses elsewhere (e.g. `useWorkerFleet.ts`'s `groupIdsKey`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerId]);

  // Real Destination ids/types for this node's own Worker Group — resolved once per group (not
  // per worker; switching between two rows in the same group doesn't need a second fetch) purely
  // to turn the Blocked chart's own raw `type:id` metrics keys into real, bare display labels. A
  // lookup failing (an older org, a permissions gap) just falls back to the raw key itself in
  // `blockedSeriesFrom` — never blocks the chart from rendering.
  const [outputLabelByKey, setOutputLabelByKey] = useState<Map<string, string>>(new Map());
  const groupId = row?.group;
  useEffect(() => {
    if (!groupId) {
      setOutputLabelByKey(new Map());
      return;
    }
    let cancelled = false;
    listOutputs(groupId)
      .then((outputs) => {
        if (!cancelled) setOutputLabelByKey(new Map(outputs.map((o) => [metricsKey(o.type, o.id), o.id])));
      })
      .catch(() => {
        if (!cancelled) setOutputLabelByKey(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  const info = row?.nodeInfo;
  const conf = info?.conf;
  const configDrift =
    groupConfigVersion !== undefined && conf?.confVersion !== undefined ? groupConfigVersion !== conf.confVersion : undefined;

  const cpuSeries = trend ? seriesFrom(trend, 'cpuPct', 'cpu', `CPU (${nodeNoun.toLowerCase()} processes)`) : undefined;
  const memSeries = trend ? seriesFrom(trend, 'memUsedBytes', 'mem', 'Memory used') : undefined;
  const diskSeries = trend ? seriesFrom(trend, 'diskUsedBytes', 'disk', 'Disk used') : undefined;
  const blockedSeries = trend ? blockedSeriesFrom(trend, outputLabelByKey, connectedAndFedOutputKeys) : [];
  const volumeSeries =
    trend &&
    [seriesFrom(trend, 'inEvents', 'in', 'In'), seriesFrom(trend, 'outEvents', 'out', 'Out')].filter((s): s is TrendSeries => s !== undefined);
  const hasTrendContent = Boolean(
    cpuSeries ?? memSeries ?? diskSeries ?? (volumeSeries && volumeSeries.length > 0 ? volumeSeries : undefined) ?? (blockedSeries.length > 0 ? blockedSeries : undefined),
  );
  // The whole section — heading included — only ever renders while a real answer is pending or
  // has actually arrived. This best-effort data source (an undocumented internal endpoint — see
  // this component's own doc comment) failing, or succeeding with nothing plottable, both resolve
  // to the identical "no Trend section at all" outcome: a labeled-but-empty panel would read as a
  // real, ongoing failure a user might reasonably go looking for a cause for, when the honest
  // situation is just "this optional data source has nothing right now" — and if Cribl ever
  // changes or removes this endpoint outright, the drawer should quietly stop offering a Trend
  // section rather than permanently show one that's visibly broken.
  const showTrendSection = trendStatus === 'loading' || (trendStatus === 'ready' && hasTrendContent);

  return (
    <Drawer
      isOpen={row !== undefined}
      onClose={onClose}
      width={520}
      closable={false}
      title={
        <div className="ov-node-drawer-header-row">
          <div className="ov-node-drawer-header-titles">
            <Drawer.Heading>{row?.hostname ?? ''}</Drawer.Heading>
            <Text as="span" variant="body-xs-normal" color="subtle">
              {row?.group}
            </Text>
          </div>
          <IconButton variant="tertiary" appearance="neutral" size="sm" icon={CloseOutlined} aria-label="Close drawer" onClick={onClose} />
        </div>
      }
    >
      {row && (
        <div className="ov-node-drawer-body">
          <div className="ov-node-drawer-section">
            <span className="ov-node-drawer-section-title">Deployed config</span>
            <div className="ov-node-drawer-panel">
              {conf ? (
                <>
                  <div className="ov-node-drawer-kv-grid">
                    <span>Pipelines</span>
                    <span className="ov-mono">{conf.pipelines ?? '—'}</span>
                    <span>Routes</span>
                    <span className="ov-mono">{conf.routes ?? '—'}</span>
                    <span>Inputs</span>
                    <span className="ov-mono">{conf.inputs ?? '—'}</span>
                    <span>Outputs</span>
                    <span className="ov-mono">{conf.outputs ?? '—'}</span>
                    <span>Config version</span>
                    <span className="ov-mono">{conf.confVersion ?? '—'}</span>
                  </div>
                  {configDrift === undefined && (
                    <Text as="p" variant="body-xs-normal" color="subtle" FORCE__className="ov-node-drawer-drift-note">
                      Group's own current config version isn't known — can't confirm whether this node is up to date.
                    </Text>
                  )}
                  {configDrift === false && (
                    <span className="ov-node-drawer-drift ov-node-drawer-drift--ok">Up to date with the group's current config.</span>
                  )}
                  {configDrift === true && (
                    <span className="ov-node-drawer-drift ov-node-drawer-drift--stale">
                      Hasn't picked up the group's latest deploy yet (group is on {groupConfigVersion}).
                    </span>
                  )}
                </>
              ) : (
                <span className="ov-node-drawer-na">Config info unavailable for this node.</span>
              )}
            </div>
          </div>

          <div className="ov-node-drawer-section">
            <span className="ov-node-drawer-section-title">Build &amp; platform</span>
            <div className="ov-node-drawer-panel">
              <div className="ov-node-drawer-kv-grid">
                <span>Version</span>
                <span className="ov-mono">{info?.BUILD?.VERSION ?? '—'}</span>
                <span>Platform</span>
                <span className="ov-mono">
                  {info?.os?.platform ?? '—'} / {info?.os?.arch ?? '—'}
                </span>
                <span>OS release</span>
                <span className="ov-mono">{info?.os?.release ?? '—'}</span>
                <span>Uptime</span>
                <span className="ov-mono">{formatUptime(info?.uptime)}</span>
                <span>{nodeNoun} processes</span>
                <span className="ov-mono">{row.workerProcesses}</span>
              </div>
            </div>
          </div>

          {info?.license && (
            <div className="ov-node-drawer-section">
              <span className="ov-node-drawer-section-title">License</span>
              <div className="ov-node-drawer-panel">
                <div className="ov-node-drawer-kv-grid">
                  <span>Type</span>
                  <span className="ov-mono">{info.license.type ?? '—'}</span>
                  <span>Registered</span>
                  <span className="ov-mono">{info.license.isRegistered ? 'Yes' : 'No'}</span>
                  {info.license.limits &&
                    Object.entries(info.license.limits).flatMap(([k, v]) => [
                      <span key={`${k}-label`}>{k}</span>,
                      <span key={`${k}-value`} className="ov-mono">
                        {v}
                      </span>,
                    ])}
                </div>
              </div>
            </div>
          )}

          <div className="ov-node-drawer-section">
            <span className="ov-node-drawer-section-title">Messages</span>
            <div className="ov-node-drawer-panel">
              {info?.messages && info.messages.length > 0 ? (
                <ul className="ov-node-drawer-messages">
                  {info.messages.map((m, i) => (
                    <li key={i}>{typeof m === 'string' ? m : JSON.stringify(m)}</li>
                  ))}
                </ul>
              ) : (
                <span className="ov-node-drawer-na">No messages reported.</span>
              )}
            </div>
          </div>

          {showTrendSection && (
            <div className="ov-node-drawer-section">
              <span className="ov-node-drawer-section-title">Trend</span>
              <div className="ov-node-drawer-panel">
                {trendStatus === 'loading' && <Spinner size="sm" title="Loading historical trend…" />}
                {trendStatus === 'ready' && (
                  <div className="ov-node-drawer-trend-grid">
                    {cpuSeries && (
                      <div className="ov-node-drawer-trend-cell">
                        <span className="ov-node-drawer-trend-label">CPU</span>
                        <TrendChart series={[cpuSeries]} formatValue={(v) => `${v.toFixed(0)}%`} />
                      </div>
                    )}
                    {memSeries && (
                      <div className="ov-node-drawer-trend-cell">
                        <span className="ov-node-drawer-trend-label">Memory used</span>
                        <TrendChart series={[memSeries]} formatValue={(v) => formatBytes(v)} />
                      </div>
                    )}
                    {diskSeries && (
                      <div className="ov-node-drawer-trend-cell">
                        <span className="ov-node-drawer-trend-label">Disk used</span>
                        <TrendChart series={[diskSeries]} formatValue={(v) => formatBytes(v)} />
                      </div>
                    )}
                    {volumeSeries && volumeSeries.length > 0 && (
                      <div className="ov-node-drawer-trend-cell">
                        <span className="ov-node-drawer-trend-label">Volume</span>
                        <TrendChart series={volumeSeries} formatValue={(v) => formatMetric(v, unit === 'bytes' ? 'events' : unit)} />
                      </div>
                    )}
                    {blockedSeries.length > 0 && (
                      <div className="ov-node-drawer-trend-cell">
                        <span className="ov-node-drawer-trend-label">Blocked (by destination)</span>
                        <TrendChart series={blockedSeries} formatValue={(v) => Math.round(v).toLocaleString()} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
