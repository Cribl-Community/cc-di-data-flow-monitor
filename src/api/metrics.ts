import { api } from './client';
import type { VolumeUnit } from '../lib/types';

// POST /system/metrics/query and /system/metrics/enum are Leader-level and unprefixed — group
// scoping happens via the `__worker_group` dimension in a `where` clause, not the URL. See
// CLAUDE.md for the full metric catalog confirmed live against the test org.

export interface MetricsQueryRequest {
  where?: string;
  earliest: string | number;
  latest: string | number;
  aggs: {
    aggregations: string[];
    splitBys?: string[];
    cumulative?: boolean;
    timeWindowSeconds?: number;
  };
  namespace?: string;
  alwaysBounds?: boolean;
}

export interface MetricsQueryResult {
  // Cumulative queries return one row with `_time`. Bucketed (non-cumulative) queries — confirmed
  // live — have **no `_time` field at all**; each bucket instead carries `starttime`/`endtime`
  // (both in seconds). Using `_time` for a bucketed result silently produces NaN timestamps.
  results: Array<Record<string, unknown> & { _time?: number; starttime?: number; endtime?: number }>;
}

export async function queryMetrics(req: MetricsQueryRequest): Promise<MetricsQueryResult> {
  return api.post<MetricsQueryResult>('/system/metrics/query', req);
}

/**
 * Escapes a raw value for safe interpolation into a single-quoted string literal within a Cribl
 * metrics-query filter expression (a `where`/`dimFilter` clause, Cribl's own small expression
 * language — not this app's own syntax to define). Every `'...'`-quoted literal built anywhere in
 * this app embeds a real identifier — a Worker Group id, a hostname, a Source/Destination/Route
 * id — that Cribl itself doesn't guarantee is free of quote characters; without this, a value
 * containing a stray `'` could break out of the intended literal and change what the filter
 * actually matches (a query-injection risk, the same class of bug as unescaped SQL string
 * interpolation, just against Cribl's own filter DSL instead of SQL). Backslash-escaped first —
 * otherwise an attacker-controlled literal backslash could neutralize the quote-escaping that
 * follows — then the delimiter itself, the standard order for this kind of escaping.
 */
export function escapeFilterLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Exported for `api/workerMetrics.ts` — the same `__worker_group` scoping every query in this
 *  file already uses, reused rather than duplicated now that the Overview page's worker-resource
 *  queries need it too. */
export function groupWhere(groupId: string, extra?: string): string {
  const base = `__worker_group == '${escapeFilterLiteral(groupId)}'`;
  return extra ? `${base} && (${extra})` : base;
}

/** `total.*` (Source-level in, Destination-level out/dropped) or `route.*` / `pipe.*` name stem. */
function volumeMetricName(stem: 'total' | 'route' | 'pipe', direction: 'in' | 'out', unit: VolumeUnit): string {
  // Pipeline volume has no byte-unit counters — see CLAUDE.md. Callers must not request
  // stem 'pipe' with unit 'bytes'; fetchPipelineVolume always uses events.
  return `${stem}.${direction}_${unit}`;
}

export interface NodeVolumeTotals {
  in: number;
  out: number;
  dropped: number;
  /** Pipeline-only (see `fetchPipelineVolumeTotals`) — `undefined` for every other caller of this
   *  shared shape, which never queries `pipe.err_events` at all. */
  err?: number;
}

/**
 * Cumulative in/out/dropped totals for the given time window, keyed by the split dimension's
 * value (a Source id for `splitBy: 'input'`, a Destination id for `splitBy: 'output'`).
 */
export async function fetchEndpointVolumeTotals(opts: {
  groupId: string;
  splitBy: 'input' | 'output';
  unit: VolumeUnit;
  earliest: string | number;
  latest: string | number;
}): Promise<Record<string, NodeVolumeTotals>> {
  const { groupId, splitBy, unit, earliest, latest } = opts;
  const inMetric = volumeMetricName('total', 'in', unit);
  const outMetric = volumeMetricName('total', 'out', unit);
  const aggregations = [`sum("${inMetric}").as("in")`, `sum("${outMetric}").as("out")`];
  if (splitBy === 'output') aggregations.push('sum("total.dropped_events").as("dropped")');

  const res = await queryMetrics({
    where: groupWhere(groupId),
    earliest,
    latest,
    aggs: { aggregations, splitBys: [splitBy], cumulative: true },
  });

  const out: Record<string, NodeVolumeTotals> = {};
  for (const row of res.results) {
    const key = row[splitBy];
    if (typeof key !== 'string') continue;
    out[key] = {
      in: Number(row.in ?? 0),
      out: Number(row.out ?? 0),
      dropped: Number(row.dropped ?? 0),
    };
  }
  return out;
}

/** Cumulative in/out/dropped totals per Route rule id. */
export async function fetchRouteVolumeTotals(opts: {
  groupId: string;
  unit: VolumeUnit;
  earliest: string | number;
  latest: string | number;
}): Promise<Record<string, NodeVolumeTotals>> {
  const { groupId, unit, earliest, latest } = opts;
  const res = await queryMetrics({
    where: groupWhere(groupId),
    earliest,
    latest,
    aggs: {
      aggregations: [
        `sum("${volumeMetricName('route', 'in', unit)}").as("in")`,
        `sum("${volumeMetricName('route', 'out', unit)}").as("out")`,
        `sum("route.dropped_events").as("dropped")`,
      ],
      splitBys: ['route'],
      cumulative: true,
    },
  });
  const out: Record<string, NodeVolumeTotals> = {};
  for (const row of res.results) {
    const key = row.route;
    if (typeof key !== 'string') continue;
    out[key] = { in: Number(row.in ?? 0), out: Number(row.out ?? 0), dropped: Number(row.dropped ?? 0) };
  }
  return out;
}

/**
 * Cumulative in/out/dropped/err event totals per Pipeline id. Events only — no byte-unit counters
 * exist for pipelines in the confirmed metric catalog.
 *
 * `pipe.err_events` (Function/processing errors a Pipeline has thrown) is real — confirmed live by
 * replaying the exact request the real Cribl Leader UI's own Pipelines page sends — but it's
 * absent from this app's own `/system/metrics/enum` catalog scan entirely, unlike `in`/`out`/
 * `dropped`. Cribl's query engine doesn't error on an aggregation with no matching data, it just
 * silently omits that field from the row — confirmed live across 1/7/30/90-day windows that this
 * test org has literally never recorded one (plausible for an all-`datagen` demo environment, not
 * evidence the metric itself doesn't exist), so `err` is read the same defensive way as the
 * others: `Number(row.err ?? 0)`, not left `undefined` just because the field happened to be
 * missing from a given response.
 */
export async function fetchPipelineVolumeTotals(opts: {
  groupId: string;
  earliest: string | number;
  latest: string | number;
}): Promise<Record<string, NodeVolumeTotals>> {
  const { groupId, earliest, latest } = opts;
  const res = await queryMetrics({
    where: groupWhere(groupId),
    earliest,
    latest,
    aggs: {
      aggregations: [
        `sum("pipe.in_events").as("in")`,
        `sum("pipe.out_events").as("out")`,
        `sum("pipe.dropped_events").as("dropped")`,
        `sum("pipe.err_events").as("err")`,
      ],
      splitBys: ['id'],
      cumulative: true,
    },
  });
  const out: Record<string, NodeVolumeTotals> = {};
  for (const row of res.results) {
    const key = row.id;
    if (typeof key !== 'string') continue;
    out[key] = { in: Number(row.in ?? 0), out: Number(row.out ?? 0), dropped: Number(row.dropped ?? 0), err: Number(row.err ?? 0) };
  }
  return out;
}

/**
 * The live-traffic source-attribution query: for each Route, which Sources actually fed it
 * during the window, and how much. This is what makes the Signal Path draw real fan-in lines
 * instead of assuming every Source reaches every Route.
 */
export async function fetchRouteSourceBreakdown(opts: {
  groupId: string;
  unit: VolumeUnit;
  earliest: string | number;
  latest: string | number;
}): Promise<Record<string, Record<string, number>>> {
  const { groupId, unit, earliest, latest } = opts;
  const res = await queryMetrics({
    where: groupWhere(groupId),
    earliest,
    latest,
    aggs: {
      aggregations: [`sum("${volumeMetricName('route', 'in', unit)}").as("v")`],
      splitBys: ['route', 'input'],
      cumulative: true,
    },
  });
  const out: Record<string, Record<string, number>> = {};
  for (const row of res.results) {
    const routeId = row.route;
    const sourceId = row.input;
    if (typeof routeId !== 'string' || typeof sourceId !== 'string') continue;
    const v = Number(row.v ?? 0);
    if (v <= 0) continue;
    (out[routeId] ??= {})[sourceId] = v;
  }
  return out;
}

export interface TrendPoint {
  t: number;
  v: number;
}

/** Bucketed rows carry `starttime` (seconds), not `_time` — see `MetricsQueryResult`. */
function bucketTimeMs(row: MetricsQueryResult['results'][number]): number {
  const seconds = row.starttime ?? row._time;
  return seconds === undefined ? NaN : seconds * 1000;
}

/**
 * The first and last bucket of any bucketed (non-cumulative) query are frequently partial — the
 * first because `earliest` can fall mid-bucket, the last because "now" is always mid-bucket for
 * the most recent one — and partial buckets under-report, which reads as the series artificially
 * dropping to (near) zero at both ends. Drop them rather than plot them as if they were real
 * measurements, as long as enough interior points remain to still show a trend.
 */
function trimPartialEdgeBuckets(points: TrendPoint[]): TrendPoint[] {
  return points.length > 4 ? points.slice(1, -1) : points;
}

/** A bucketed (non-cumulative) trend series for a single metric/dimension-value, for sparklines. */
export async function fetchTrend(opts: {
  metric: string;
  groupId: string;
  dimFilter?: string;
  earliest: number;
  latest: number;
  buckets?: number;
}): Promise<TrendPoint[]> {
  const { metric, groupId, dimFilter, earliest, latest, buckets = 30 } = opts;
  const timeWindowSeconds = Math.max(1, Math.floor((latest - earliest) / 1000 / buckets));
  const res = await queryMetrics({
    where: groupWhere(groupId, dimFilter),
    earliest,
    latest,
    aggs: {
      aggregations: [`sum("${metric}").as("v")`],
      cumulative: false,
      timeWindowSeconds,
    },
  });
  const points = res.results
    .map((row) => ({ t: bucketTimeMs(row), v: Number(row.v ?? 0) }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  return trimPartialEdgeBuckets(points);
}

/**
 * Real per-Source "when did this Source last actually ingest something." No API field gives this
 * directly — `/system/status/inputs` only exposes a shared status-snapshot timestamp, not a
 * per-source last-received time — so this derives it from a bucketed (non-cumulative)
 * `total.in_events` query split by `input`, taking each source's own latest non-zero bucket.
 * Resolution is bucket-sized, not to-the-second, same tradeoff `fetchTrend` already makes.
 *
 * Always `total.in_events`, never whichever unit is currently selected — matching this app's own
 * "health/timing signals stay unit-independent" principle (`deriveHealth`, `flowHealthFromVolume`):
 * a Source with real events but a genuine gap in its own bytes series (a confirmed, real case —
 * see `hasRealSourceBytes` in `lib/topology.ts`) shouldn't read as "never ingested" just because
 * Bytes happens to be the selected unit.
 */
export async function fetchLastIngestTimes(opts: {
  groupId: string;
  earliest: number;
  latest: number;
  buckets?: number;
}): Promise<Record<string, number>> {
  const { groupId, earliest, latest, buckets = 48 } = opts;
  const timeWindowSeconds = Math.max(1, Math.floor((latest - earliest) / 1000 / buckets));
  const res = await queryMetrics({
    where: groupWhere(groupId),
    earliest,
    latest,
    aggs: { aggregations: ['sum("total.in_events").as("v")'], splitBys: ['input'], cumulative: false, timeWindowSeconds },
  });
  const latestByInput: Record<string, number> = {};
  for (const row of res.results) {
    if (typeof row.input !== 'string') continue;
    if (Number(row.v ?? 0) <= 0) continue;
    const t = bucketTimeMs(row);
    if (!Number.isFinite(t)) continue;
    if (!(row.input in latestByInput) || t > latestByInput[row.input]) latestByInput[row.input] = t;
  }
  return latestByInput;
}

