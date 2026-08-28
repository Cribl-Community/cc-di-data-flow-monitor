import { queryMetrics, groupWhere } from './metrics';
import type { VolumeUnit } from '../lib/types';

/**
 * Worker-level backpressure/throughput metrics for the Overview page, all confirmed live against
 * the real test org — each with its own real constraint worth remembering:
 *
 * - `blocked.outputs` (Destination-side) and `total.blocked_eps` (Source-side) both confirmed
 *   live and currently populated — real backpressure signals, previously unused anywhere in this
 *   app (see CLAUDE.md).
 * - `system.max_worker_process_heartbeat_lag` confirmed live — a real per-worker liveness signal.
 *
 * **All three functions below are confirmed live only for Stream Worker Groups.** Every one of
 * them splits by `__worker_node_hostname` — confirmed live this dimension is never tagged on
 * `blocked.outputs`/`total.blocked_eps`/`system.max_worker_process_heartbeat_lag`/`total.in_*`/
 * `total.out_*` for an Edge Fleet's own series at the aggregated-metrics-store level at all (a
 * query against `__worker_group == '<edge fleet>'` with this same splitBy returns either no rows
 * or rows with the hostname field silently omitted). For Edge, every value these three functions
 * produce is currently, honestly, always empty — `useWorkerFleet.ts`'s own rows fall back to `0`/
 * `undefined` for Blocked/Volume/heartbeat lag on an Edge node, same as before this file's own
 * CPU/mem/disk resource-reading function was replaced by the real, per-node `/system/info`-based
 * one (`api/workerInfo.ts`) — that gap was specific to `system.*` resource metrics and is now
 * closed; this one (backpressure/throughput attribution per Edge node) is a separate, still-open
 * gap, not attempted here per explicit scope (`api/workerInfo.ts`'s own best-effort raw-metrics
 * endpoint *does* carry real per-node volume totals, but is deliberately kept lazy/drawer-only,
 * not wired into this file's eager, whole-roster-on-every-refresh fetch shape).
 */

function numberOf(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function hostnameOf(row: Record<string, unknown>): string | undefined {
  const v = row.__worker_node_hostname;
  return typeof v === 'string' ? v : undefined;
}

/**
 * Confirmed live: a two-dimension `splitBys` query against `/system/metrics/query` (e.g.
 * `['input', '__worker_node_hostname']`) can return an extra rollup row per hostname that omits
 * the *other* split field entirely — its own value is exactly the sum of that hostname's other,
 * fully-split rows, not a distinct data point. Summing indiscriminately by hostname alone (as this
 * file did before this was found) silently double-counts: the rollup row adds the same volume a
 * second time on top of the real per-component rows. Every multi-dimension query in this file
 * needs to require the *other* split field is also present before trusting a row, the same defense
 * `fetchRouteSourceBreakdown` (api/metrics.ts) already had for its own `route`+`input` split —
 * this just brings the rest of this file up to that same standard. */
function hasDim(row: Record<string, unknown>, key: string): boolean {
  return typeof row[key] === 'string';
}

/** `system.max_worker_process_heartbeat_lag`, per worker hostname (seconds). */
export async function fetchWorkerHeartbeatLag(opts: { groupId: string; earliest: number; latest: number }): Promise<Record<string, number>> {
  const { groupId, earliest, latest } = opts;
  const res = await queryMetrics({
    where: groupWhere(groupId),
    earliest,
    latest,
    aggs: { aggregations: ['avg("system.max_worker_process_heartbeat_lag").as("lag")'], splitBys: ['__worker_node_hostname'], cumulative: true },
  });
  const out: Record<string, number> = {};
  for (const row of res.results) {
    const hostname = hostnameOf(row);
    if (hostname) out[hostname] = numberOf(row, 'lag');
  }
  return out;
}

export interface WorkerBlockedTotals {
  /** Real per-Destination `blocked.outputs` count, keyed by the raw `output` metrics dimension
   *  (a `type:id` value, matching `metricsKey()`) — unfiltered/raw. Confirmed live this metric can
   *  be genuinely nonzero for a Destination with no live Route/QuickConnect wiring at all and zero
   *  real event data ever passing through it (some connector types, e.g. `tcpjson`, emit a sample
   *  purely from a periodic failed reconnect attempt, not from real backed-up data) — callers that
   *  want to exclude that noise should filter this map themselves against `lib/topology.ts`'s
   *  `connectedAndFedDestinationKeys()` before summing, rather than trusting every entry here as a
   *  meaningful "this Destination is really blocked" signal on its own. */
  byOutput: Record<string, number>;
  /** `total.blocked_eps` (this worker's Sources unable to push downstream), pre-summed across every
   *  Source — left unfiltered regardless of the Destination-side caveat above, since a Source can
   *  only report this by actually, currently trying and failing to push into Routes, which already
   *  requires real activity (no equivalent "orphaned" false-positive mode). */
  sourceSide: number;
}

/**
 * `blocked.outputs` (this worker's Destinations refusing events), kept broken down per real
 * Destination, plus `total.blocked_eps` (this worker's Sources unable to push downstream), pre-
 * summed across every Source — two separate real signals (different metrics, different split
 * dimensions), returned as `WorkerBlockedTotals` per hostname rather than one flat number, so a
 * caller can apply its own per-Destination filtering (see that type's own doc comment) before
 * deciding what counts as "really blocked."
 */
export async function fetchWorkerBlockedTotals(opts: { groupId: string; earliest: number; latest: number }): Promise<Record<string, WorkerBlockedTotals>> {
  const { groupId, earliest, latest } = opts;
  const [outputsRes, sourcesRes] = await Promise.all([
    queryMetrics({
      where: groupWhere(groupId),
      earliest,
      latest,
      aggs: { aggregations: ['sum("blocked.outputs").as("v")'], splitBys: ['output', '__worker_node_hostname'], cumulative: true },
    }),
    queryMetrics({
      where: groupWhere(groupId),
      earliest,
      latest,
      aggs: { aggregations: ['sum("total.blocked_eps").as("v")'], splitBys: ['input', '__worker_node_hostname'], cumulative: true },
    }),
  ]);
  const out: Record<string, WorkerBlockedTotals> = {};
  const forHost = (hostname: string): WorkerBlockedTotals => (out[hostname] ??= { byOutput: {}, sourceSide: 0 });
  for (const row of outputsRes.results) {
    const hostname = hostnameOf(row);
    if (!hostname || !hasDim(row, 'output')) continue;
    const output = row.output as string;
    const entry = forHost(hostname);
    entry.byOutput[output] = (entry.byOutput[output] ?? 0) + numberOf(row, 'v');
  }
  for (const row of sourcesRes.results) {
    const hostname = hostnameOf(row);
    if (!hostname || !hasDim(row, 'input')) continue;
    forHost(hostname).sourceSide += numberOf(row, 'v');
  }
  return out;
}

export interface WorkerVolume {
  in: number;
  out: number;
}

/** Real per-worker throughput — `total.in_events`/`total.out_events` (or the byte-unit siblings)
 *  split by `input`/`output` *and* `__worker_node_hostname` together (confirmed live this
 *  double-split works), summed across every Source/Destination that worker touches. This is what
 *  makes a real load-balance comparison across workers possible — previously this app only ever
 *  split these metrics by component, never by worker. */
export async function fetchWorkerVolumeTotals(opts: {
  groupId: string;
  unit: VolumeUnit;
  earliest: number;
  latest: number;
  /** Called once per raw per-destination-per-worker OUT row, before it's summed into that
   *  worker's own total — return `true` to exclude it (e.g. because real per-worker status
   *  confirms that specific Destination is genuinely stuck on that specific worker, so its own
   *  `total.out_*` figure reflects what was handed to the output stage, not what actually left —
   *  see `lib/blockedOutput.ts`). `output` is the raw `type:id` metrics dimension value, exactly
   *  as Cribl reports it (see `metricsKey`). Omitted entirely keeps this function's own
   *  long-standing raw-sum behavior, unaffected. */
  excludeOutputRow?: (output: string, hostname: string) => boolean;
}): Promise<Record<string, WorkerVolume>> {
  const { groupId, unit, earliest, latest, excludeOutputRow } = opts;
  const [inRes, outRes] = await Promise.all([
    queryMetrics({
      where: groupWhere(groupId),
      earliest,
      latest,
      aggs: { aggregations: [`sum("total.in_${unit}").as("v")`], splitBys: ['input', '__worker_node_hostname'], cumulative: true },
    }),
    queryMetrics({
      where: groupWhere(groupId),
      earliest,
      latest,
      aggs: { aggregations: [`sum("total.out_${unit}").as("v")`], splitBys: ['output', '__worker_node_hostname'], cumulative: true },
    }),
  ]);
  const out: Record<string, WorkerVolume> = {};
  for (const row of inRes.results) {
    const hostname = hostnameOf(row);
    if (!hostname || !hasDim(row, 'input')) continue;
    (out[hostname] ??= { in: 0, out: 0 }).in += numberOf(row, 'v');
  }
  for (const row of outRes.results) {
    const hostname = hostnameOf(row);
    if (!hostname || !hasDim(row, 'output')) continue;
    const output = row.output as string;
    if (excludeOutputRow?.(output, hostname)) continue;
    (out[hostname] ??= { in: 0, out: 0 }).out += numberOf(row, 'v');
  }
  return out;
}
