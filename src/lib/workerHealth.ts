import type { GroupProductFilter, HealthStatus } from './types';
import type { RawWorkerSystemInfo } from '../api/workerInfo';

/** A worker's own real signals, once resolved from `/master/workers` + the various worker-metric
 *  queries — the input `deriveWorkerHealth`/the roster/the balance chart all read from. */
export interface WorkerFleetRow {
  id: string;
  group: string;
  hostname: string;
  cpus?: number;
  disconnected: boolean;
  workerProcesses: number;
  /** Cribl's own real, raw process-level status string from `/master/workers` (e.g. `"healthy"`)
   *  — distinct from `deriveWorkerHealth()` below, which is this app's own derived verdict from
   *  resource/backpressure signals. `undefined` if the field wasn't present in the response. */
  status?: string;
  /** Real per-node liveness — epoch ms of the Leader's own last-received heartbeat from this node
   *  (`/master/workers`' `lastMsgTime`, confirmed live to work identically for Stream Workers and
   *  Edge Nodes — see `RawWorker.lastMsgTime`'s own doc comment). `undefined` only if the field
   *  wasn't present in the response. */
  lastMsgTime?: number;
  /** CPU utilization %, computed from two successive `/system/info` polls' own cumulative tick
   *  counters (`api/workerInfo.ts`'s `computeCpuPct`) — real for both Stream and Edge nodes alike,
   *  replacing the earlier Stream-only `system.load_avg`-derived figure (which the metrics store
   *  can't attribute per-node for Edge at all). `undefined` until a second poll has happened for
   *  this worker in the current session — the roster shows a "—" placeholder for one refresh
   *  cycle rather than a fabricated number, since a single snapshot has no rate to report.
   */
  loadPct?: number;
  memUsedBytes?: number;
  memTotalBytes?: number;
  diskUsedBytes?: number;
  diskTotalBytes?: number;
  /** Real seconds since this one process last started — `undefined` only if `/system/info` failed
   *  for this worker (degrades gracefully, same as every other field sourced from it). */
  uptimeSeconds?: number;
  /** The full raw `/system/info` snapshot already fetched for the roster's own CPU/mem/disk/uptime
   *  figures above — kept in full (not trimmed to just those fields) so the detail drawer can read
   *  config-drift/license/messages/BUILD straight off it with no second fetch needed. `undefined`
   *  only if `/system/info` itself failed for this worker. */
  nodeInfo?: RawWorkerSystemInfo;
  /** The real, final "how much backpressure did this worker experience" total — Source-side
   *  (`blockedSourceSide`) plus whichever entries of `blockedByOutput` currently count as "really
   *  blocked" (see that field's own doc comment). Computed by `useWorkerFleet.ts`'s own wrapping
   *  `useMemo`, re-derived live against the current connectivity filter without a network refetch —
   *  not set directly by the raw per-worker fetch itself. */
  blockedCount: number;
  /** Real per-Destination `blocked.outputs` breakdown for this worker (`type:id` metrics keys),
   *  unfiltered/raw — `blockedCount` above is derived from this (filtered to only "connected and
   *  fed" destinations, see `lib/topology.ts`'s `connectedAndFedDestinationKeys`) plus
   *  `blockedSourceSide`. Kept on the row so that derivation always has real data to re-run against
   *  whenever the live connectivity filter changes, without needing to refetch from Cribl. */
  blockedByOutput: Record<string, number>;
  /** `total.blocked_eps`, pre-summed across every Source — the portion of `blockedCount` that never
   *  gets filtered (see `WorkerBlockedTotals.sourceSide`'s own doc comment for why). */
  blockedSourceSide: number;
  heartbeatLagSeconds?: number;
  volumeIn: number;
  volumeOut: number;
}

/**
 * A worker's own status, expressed in the same `HealthStatus` vocabulary every other status
 * pill/dot/filter in this app already uses — `good` ("Processing" in the roster's own wording),
 * `degraded`, `blocked`, `nodata` ("Idle") — so the shared top-bar status filter, `HEALTH_
 * APPEARANCE` colors, and `matchesStatusFilter` all apply to a worker exactly like they apply to
 * a Source/Destination/flow, no second filter mechanism needed.
 *
 * `blocked` (worst) covers a disconnected worker or one that's genuinely experiencing backpressure
 * right now (`blockedCount > 0`) — both real, unambiguous problems Cribl reports independently of
 * its own process-level `status` string. Otherwise, this is now driven directly by that same real,
 * raw `status` Cribl reports from `/master/workers` (`w.status`) — not a separate,
 * resource-threshold-derived verdict. An earlier version of this function additionally flagged
 * `degraded` from this app's own CPU/memory/disk/heartbeat-lag percentage thresholds, none of which
 * are Cribl-documented severity levels — a worker could cross one of those made-up thresholds while
 * Cribl's own `status` still read "healthy," which is exactly what caused the KPI card's "N need
 * attention" count to disagree with the Inventory panel's own Status column for the same worker
 * (that column has since been renamed "Last Seen" and shows heartbeat recency instead, colored by
 * the separate `lastSeenHealth()` below — this function's own verdict still backs the KPI row's
 * counts, the shared status filter, and this table's default sort, just no longer literally
 * displayed as text anywhere). `nodata` ("Idle") means no observed volume at all in the selected
 * window — not a problem, just nothing to report, checked only once `status` itself doesn't already
 * say otherwise. `good` ("Processing") is everything else, including a missing `status` (an org
 * that hasn't granted this field) with real observed volume.
 *
 * The `nodata` volume check is skipped entirely for Edge (`product === 'edge'`) — confirmed live
 * against the real test org that Cribl's metrics store does not tag per-node volume dimensions
 * (`__worker_node_hostname`) for Edge Fleets at all (a real query split by `input` +
 * `__worker_node_hostname` against an Edge Fleet's own real traffic came back with that dimension
 * entirely absent from every row, unlike the identical query shape against a Stream group, which
 * correctly includes it on every row). Without this skip, every genuinely healthy Edge worker
 * would read `nodata`/grey regardless of real activity, since `fetchWorkerVolumeTotals` can never
 * populate a per-worker entry for it. Stream is unaffected — real per-node volume data does exist
 * there, so requiring it for a `good` verdict stays meaningful.
 */
export function deriveWorkerHealth(w: WorkerFleetRow, product: GroupProductFilter = 'stream'): HealthStatus {
  if (w.disconnected || w.blockedCount > 0) return 'blocked';
  if (w.status !== undefined && w.status.trim().toLowerCase() !== 'healthy') return 'degraded';
  if (product !== 'edge' && w.volumeIn === 0 && w.volumeOut === 0) return 'nodata';
  return 'good';
}

/**
 * A worker's real heartbeat *staleness*, in the same `HealthStatus` vocabulary as
 * `deriveWorkerHealth()` above but deliberately answering a different, narrower question — per
 * direct instruction, the Node Inventory table's own "Last Seen" cell is now colored by how
 * recently the Leader last heard from this node, not by `deriveWorkerHealth()`'s own blocked-events/
 * backpressure verdict (which still drives the KPI row's counts, the shared status filter, and this
 * table's default sort, unaffected by this function). Works identically for Stream and Edge — both
 * confirmed live to report `lastMsgTime` on the same real cadence as their own configured heartbeat
 * period (see `RawWorker.lastMsgTime`'s own doc comment).
 *
 * `disconnected` always reads `blocked` (red) regardless of the raw age — it's Cribl's own real
 * "past its configured offline grace period" verdict, a stronger signal than a plain age threshold.
 * Short of that: `good` (<1 minute — normal for either product's own heartbeat cadence), `degraded`
 * (1–5 minutes — a heartbeat that's gone quiet this long without yet being marked disconnected is
 * itself worth flagging), `blocked` (5+ minutes). `nodata` only when the org hasn't granted
 * `lastMsgTime` at all.
 */
export function lastSeenHealth(w: Pick<WorkerFleetRow, 'lastMsgTime' | 'disconnected'>, nowMs: number = Date.now()): HealthStatus {
  if (w.disconnected) return 'blocked';
  if (w.lastMsgTime === undefined) return 'nodata';
  const ageMs = nowMs - w.lastMsgTime;
  if (ageMs < 60_000) return 'good';
  if (ageMs < 300_000) return 'degraded';
  return 'blocked';
}
