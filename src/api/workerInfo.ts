import { api, workerScoped, type ApiListResponse } from './client';

/**
 * `/w/:workerId/system/info` — confirmed live against the test org, for both a Stream Worker and
 * an Edge Node: a genuinely real-time, on-demand snapshot proxied through the Leader out to that
 * one specific process (not a cached heartbeat value — confirmed by polling twice, 4 seconds
 * apart, and observing `uptime`/`memory.free`/`cpus[].times` all move by a real, consistent
 * amount). Not documented in this project's own bundled `openapi.json` — found the same way
 * `/w/:wid/system/status/*` was (reading the real Leader UI's own JS bundle) — but unlike
 * `/system/metrics` below, it isn't flagged `x-cribl-internal` anywhere, and its response shape is
 * stable and directly analogous to Node's own `os` module output, so it's relied on here as a real
 * data source, not just a best-effort extra.
 *
 * This is the one call that resolves the "Edge nodes have no per-node CPU/mem/disk" gap noted in
 * this project's own research: the aggregated metrics store (`/system/metrics/query`) never tags
 * `system.*` resource metrics with `__worker_node_hostname` for Edge Fleets at all (confirmed
 * live), but this endpoint reads the number directly off the node itself, so it works for both
 * products identically — which is also why Stream's own resource stats were switched over to this
 * same path rather than kept on two different mechanisms per product.
 */
interface RawWorkerCpuCore {
  model?: string;
  speed?: number;
  times?: { user?: number; nice?: number; sys?: number; idle?: number; irq?: number };
}

export interface RawWorkerSystemInfo {
  hostname?: string;
  uptime?: number;
  /** `[1m, 5m, 15m]` load averages — confirmed live to always read `[0, 0, 0]` on a Windows-hosted
   *  node (Node.js's own `os.loadavg()` is a documented no-op on Windows, not a Cribl or Edge
   *  limitation) — real on Linux-hosted nodes, not used here since `cpus`' own tick counters give a
   *  real, cross-platform percentage instead (see `computeCpuPct`). */
  loadavg?: [number, number, number];
  memory?: { free?: number; total?: number };
  os?: { platform?: string; arch?: string; release?: string; type?: string };
  diskUsage?: { diskPath?: string; bytesUsed?: number; bytesAvailable?: number; totalDiskSize?: number };
  cpus?: RawWorkerCpuCore[];
  /** The node's own real, currently-deployed config — compared against the Worker Group's own
   *  `configVersion` (`WorkerGroupSummary`) to flag a node that hasn't picked up the latest push
   *  yet (a real, common state for an intermittently-connected Edge node). */
  conf?: { pipelines?: number; routes?: number; outputs?: number; inputs?: number; confVersion?: string; name?: string };
  license?: { type?: string; isRegistered?: boolean; limits?: Record<string, number> };
  /** Any node-reported warnings — an empty array is the common, healthy case, not `undefined`. */
  messages?: unknown[];
  BUILD?: { VERSION?: string; BRANCH?: string; TIMESTAMP?: string };
  guid?: string;
  workerProcesses?: number;
  distMode?: string;
  startTime?: number;
}

/** Resolves to `undefined` rather than throwing if this one node has nothing to report. */
async function fetchWorkerSystemInfo(workerId: string): Promise<RawWorkerSystemInfo | undefined> {
  const res = await api.get<ApiListResponse<RawWorkerSystemInfo>>(workerScoped(workerId, '/system/info'));
  return res.items[0];
}

/** Fetches every given worker's own `/system/info` in parallel, one call per worker (this endpoint
 *  has no multi-id batched form) — a single worker failing (an older/disconnected node, a
 *  permissions gap) doesn't blank out the rest, matching the established per-worker `try/catch`
 *  isolation `fetchWorkerStatusesForOutputs` already uses. */
export async function fetchWorkerSystemInfoForWorkers(workerIds: string[]): Promise<Map<string, RawWorkerSystemInfo>> {
  const entries = await Promise.all(
    workerIds.map(async (id): Promise<readonly [string, RawWorkerSystemInfo] | undefined> => {
      try {
        const info = await fetchWorkerSystemInfo(id);
        return info ? ([id, info] as const) : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return new Map(entries.filter((e): e is readonly [string, RawWorkerSystemInfo] => e !== undefined));
}

/** A worker's own cumulative CPU tick counters at one point in time, summed across every core —
 *  `RawWorkerCpuCore.times` are ever-increasing totals since boot (matching Node's own `os.cpus()`
 *  shape), not an instantaneous reading, so a single `/system/info` poll alone can never produce a
 *  percentage — only the *delta* between two polls can. */
export interface CpuTimesSample {
  sampledAtMs: number;
  idle: number;
  total: number;
}

export function cpuSampleFrom(info: RawWorkerSystemInfo): CpuTimesSample | undefined {
  const cpus = info.cpus;
  if (!cpus || cpus.length === 0) return undefined;
  let idle = 0;
  let total = 0;
  for (const core of cpus) {
    const t = core.times;
    if (!t) continue;
    idle += t.idle ?? 0;
    total += (t.user ?? 0) + (t.nice ?? 0) + (t.sys ?? 0) + (t.idle ?? 0) + (t.irq ?? 0);
  }
  if (total <= 0) return undefined;
  return { sampledAtMs: Date.now(), idle, total };
}

/**
 * Real CPU utilization %, computed from the delta between two samples' own cumulative tick
 * counters — standard `os.cpus()`-delta technique, the same one Node's own ecosystem uses for this
 * exact reason (a single reading has no rate to report). Returns `undefined` on the very first
 * sample taken for a worker in a given session (nothing to diff against yet — the roster shows a
 * "—" placeholder until the *next* refresh, not a wrong number), or if the two samples' own totals
 * didn't move at all (e.g. an unusually-idle node between two fast polls, or a node whose own
 * clock/counters reset between reads).
 */
export function computeCpuPct(prev: CpuTimesSample, curr: CpuTimesSample): number | undefined {
  const totalDelta = curr.total - prev.total;
  if (totalDelta <= 0) return undefined;
  const idleDelta = curr.idle - prev.idle;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

/**
 * `/w/:workerId/system/metrics` — the same raw internal metrics buffer this project's own earlier
 * research found (marked `x-cribl-internal: true`, absent from `openapi.json`'s documented public
 * surface, and previously untried worker-scoped) — confirmed live here to work once properly
 * scoped to one worker, returning a genuine bucketed time series (hours of real history, not a
 * single point) including exactly the per-node `system.*` resource and `total.*` volume series the
 * aggregated metrics store can't attribute per-node for Edge at all.
 *
 * Used strictly best-effort, per explicit direction: this is the *only* place in this app that
 * depends on it, it's fetched lazily (only when a node's own detail drawer is opened, never
 * eagerly for a whole roster — confirmed live the payload is multi-megabyte per node), and every
 * failure mode (404, a reshaped response, a network error, an org where this path is disabled)
 * resolves to `undefined` rather than surfacing as an error state — the drawer simply omits the
 * trend section, since every other statistic it shows comes from `/system/info` instead.
 *
 * Real, observed constraints, not assumed: `et`/`lt` query params were tried live and had no
 * effect on the returned window — this always returns whatever's currently in the node's own
 * internal buffer (~27 hours in the test org for a Stream Worker; ~302 buckets confirmed live for
 * an Edge Node), not a caller-controlled range. For most metrics, only the "whole node" reading is
 * extracted (the entry whose own `model` carries no per-component dimension — confirmed live this
 * is how a node-level rollup is distinguished from a per-Source/per-Destination breakdown row in
 * this same response) — a full per-connector trend isn't attempted for those. `blocked.outputs` is
 * the one exception: confirmed live it has no whole-node rollup row at all, only real per-
 * Destination rows (`model: {output: "type:id"}`), extracted below via `perOutputValues()` into
 * `WorkerNodeTrendPoint.blockedByOutput` — a genuine per-connector breakdown, since that's the
 * whole point of that one chart.
 */
export interface WorkerNodeTrendPoint {
  t: number;
  cpuPct?: number;
  memUsedBytes?: number;
  memTotalBytes?: number;
  diskUsedBytes?: number;
  diskTotalBytes?: number;
  inEvents?: number;
  outEvents?: number;
  /** `blocked.outputs`, keyed by the real `output` dimension (a `type:id` metrics-key, e.g.
   *  `"tcpjson:tcp_json_1"` — the same shape `metricsKey()` builds elsewhere in this app) — one
   *  entry per Destination this node has ever reported a blocked count for in this bucket, `0` for
   *  a Destination that's fine. Confirmed live this metric *is* present in this per-node raw buffer
   *  for both a Stream Worker and an Edge Node alike, unlike the aggregated metrics store
   *  (`/system/metrics/query`), which was separately confirmed live to carry **zero** `blocked.
   *  outputs` data for an Edge Fleet at any split (not just missing the `__worker_node_hostname`
   *  dimension the other `system.*`/`total.*` metrics are missing — this one metric family simply
   *  never reaches the aggregated store for Edge at all). This is the same reason `cpuPct`/
   *  `memUsedBytes`/etc. above already read from this endpoint instead of that one. */
  blockedByOutput?: Record<string, number>;
}

interface RawMetricValue {
  model?: Record<string, string>;
  val?: number;
}

type RawMetricBucket = Record<string, RawMetricValue[] | undefined>;

interface RawWorkerMetricsResponse {
  results?: {
    metrics?: RawMetricBucket[];
  };
}

/** The single global reading for a `system.*`-style metric — the entry whose own `model` has no
 *  dimension keys at all (confirmed live: `system.free_mem`/`system.disk_used`/etc. each report
 *  exactly one such entry, `model: {}`, alongside no other rows). */
function wholeNodeValue(bucket: RawMetricBucket, metric: string): number | undefined {
  const entries = bucket[metric];
  const entry = entries?.find((e) => e.model === undefined || Object.keys(e.model).length === 0);
  return typeof entry?.val === 'number' ? entry.val : undefined;
}

/** `system.cpu_perc` is keyed by `__worker_process`, not a single whole-node row — summed across
 *  every worker process on the node into one representative figure, since this app models a node
 *  as one entity, not per-process. */
function summedProcessValue(bucket: RawMetricBucket, metric: string): number | undefined {
  const entries = bucket[metric];
  if (!entries || entries.length === 0) return undefined;
  const withProcess = entries.filter((e) => e.model?.__worker_process !== undefined);
  if (withProcess.length === 0) return undefined;
  return withProcess.reduce((sum, e) => sum + (e.val ?? 0), 0);
}

/** `total.in_events`/`total.out_events`'s own node-level rollup row — the entry whose `model` has
 *  *only* the `__internal: "1"` key and nothing else (every per-Source/per-Destination breakdown
 *  row carries real `ci`/`input`/`co`/`output` dimensions alongside it, confirmed live). */
function internalRollupValue(bucket: RawMetricBucket, metric: string): number | undefined {
  const entries = bucket[metric];
  const entry = entries?.find((e) => e.model && Object.keys(e.model).length === 1 && e.model.__internal === '1');
  return typeof entry?.val === 'number' ? entry.val : undefined;
}

/** Every real per-Destination row for a metric whose own `model` carries an `output` dimension
 *  (confirmed live: `blocked.outputs`' own rows are shaped `{model: {output: "tcpjson:tcp_json_1"},
 *  val: N}`, one row per real Destination this node has ever reported this metric for — no separate
 *  "whole node" rollup row exists for this metric the way `total.in_events`/`system.*` have). */
function perOutputValues(bucket: RawMetricBucket, metric: string): Record<string, number> | undefined {
  const entries = bucket[metric];
  if (!entries || entries.length === 0) return undefined;
  const out: Record<string, number> = {};
  for (const e of entries) {
    const output = e.model?.output;
    if (typeof output === 'string' && typeof e.val === 'number') out[output] = e.val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function fetchWorkerRawMetricsTrend(workerId: string): Promise<WorkerNodeTrendPoint[] | undefined> {
  try {
    const res = await api.get<RawWorkerMetricsResponse>(workerScoped(workerId, '/system/metrics'));
    const buckets = res.results?.metrics;
    if (!Array.isArray(buckets) || buckets.length === 0) return undefined;

    const points: WorkerNodeTrendPoint[] = [];
    for (const bucket of buckets) {
      const timeEntry = bucket['_time']?.[0]?.val;
      if (typeof timeEntry !== 'number') continue;
      const memFree = wholeNodeValue(bucket, 'system.free_mem');
      const memTotal = wholeNodeValue(bucket, 'system.total_mem');
      points.push({
        t: timeEntry * 1000,
        cpuPct: summedProcessValue(bucket, 'system.cpu_perc'),
        memUsedBytes: memFree !== undefined && memTotal !== undefined ? memTotal - memFree : undefined,
        memTotalBytes: memTotal,
        diskUsedBytes: wholeNodeValue(bucket, 'system.disk_used'),
        diskTotalBytes: wholeNodeValue(bucket, 'system.total_disk'),
        inEvents: internalRollupValue(bucket, 'total.in_events'),
        outEvents: internalRollupValue(bucket, 'total.out_events'),
        blockedByOutput: perOutputValues(bucket, 'blocked.outputs'),
      });
    }
    points.sort((a, b) => a.t - b.t);
    return points.length >= 2 ? points : undefined;
  } catch {
    return undefined;
  }
}
