import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listWorkers, fetchWorkerStatusesForOutputs, type RawWorker, type WorkerStatusRow } from '../api/workers';
import { fetchWorkerBlockedTotals, fetchWorkerHeartbeatLag, fetchWorkerVolumeTotals } from '../api/workerMetrics';
import { fetchWorkerSystemInfoForWorkers, cpuSampleFrom, computeCpuPct, type CpuTimesSample } from '../api/workerInfo';
import { listOutputs } from '../api/topology';
import { metricsKey } from '../lib/topology';
import { isDestinationStuck } from '../lib/blockedOutput';
import { timeRangeToWindow } from './useFlowGraph';
import type { WorkerFleetRow } from '../lib/workerHealth';
import type { TimeRangeOption, VolumeUnit } from '../lib/types';
import { PermissionError } from '../api/client';

export interface UseWorkerFleetResult {
  rows: WorkerFleetRow[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | undefined;
  isPermissionError: boolean;
  refresh: () => void;
}

async function fetchOneGroupFleet(
  groupId: string,
  allWorkers: RawWorker[],
  unit: VolumeUnit,
  earliest: number,
  latest: number,
  cpuSamples: Map<string, CpuTimesSample>,
): Promise<WorkerFleetRow[]> {
  const inGroup = allWorkers.filter((w) => w.group === groupId);
  if (inGroup.length === 0) return [];

  const [nodeInfoByWorkerId, blocked, heartbeat, outputs] = await Promise.all([
    fetchWorkerSystemInfoForWorkers(inGroup.map((w) => w.id)),
    fetchWorkerBlockedTotals({ groupId, earliest, latest }),
    fetchWorkerHeartbeatLag({ groupId, earliest, latest }),
    listOutputs(groupId).catch(() => []),
  ]);

  // Real per-worker, per-Destination "is this specific connection genuinely stuck" signal (see
  // `lib/blockedOutput.ts`) — excluded from `fetchWorkerVolumeTotals`'s own OUT sum below so a
  // blocked Destination's "handed to the output stage" volume doesn't inflate this worker's own
  // reported out-throughput past what it's actually delivering (the same root cause already fixed
  // for Signal Path's drawer and Flow Explorer's Trend column, ported here). Degrades to no
  // correction (not an error) if this org hasn't granted the `/master/workers` policy — the
  // existing raw volume totals still render regardless, same as every other on-demand worker-
  // status fetch in this app.
  const metricsKeyToId = new Map(outputs.map((o) => [metricsKey(o.type, o.id), o.id]));
  const workerStatusByDestination =
    outputs.length > 0
      ? await fetchWorkerStatusesForOutputs(
          groupId,
          outputs.map((o) => o.id),
        ).catch(() => new Map<string, WorkerStatusRow[]>())
      : new Map<string, WorkerStatusRow[]>();
  const stuckPairs = new Set<string>();
  for (const [destId, rows] of workerStatusByDestination) {
    for (const row of rows) {
      if (row.hostname && isDestinationStuck([row])) stuckPairs.add(`${destId}::${row.hostname}`);
    }
  }

  const volume = await fetchWorkerVolumeTotals({
    groupId,
    unit,
    earliest,
    latest,
    excludeOutputRow: (output, hostname) => {
      const destId = metricsKeyToId.get(output);
      return destId !== undefined && stuckPairs.has(`${destId}::${hostname}`);
    },
  });

  return inGroup.map((w): WorkerFleetRow => {
    const hostname = w.info?.hostname ?? w.id;
    const nodeInfo = nodeInfoByWorkerId.get(w.id);

    // CPU% via two-poll delta (see `computeCpuPct`'s own doc comment) — `cpuSamples` is owned by
    // the calling hook and persists across refreshes for the life of that hook instance, so the
    // *second* poll for a given worker (whether from a manual refresh or the auto-refresh
    // interval) always has a real prior sample to diff against, even though this one call only
    // ever sees "this poll's" reading in isolation.
    const currSample = nodeInfo ? cpuSampleFrom(nodeInfo) : undefined;
    const prevSample = cpuSamples.get(w.id);
    const loadPct = prevSample && currSample ? computeCpuPct(prevSample, currSample) : undefined;
    if (currSample) cpuSamples.set(w.id, currSample);

    const memTotal = nodeInfo?.memory?.total;
    const memFree = nodeInfo?.memory?.free;

    const blockedForHost = blocked[hostname];
    const blockedByOutput = blockedForHost?.byOutput ?? {};
    const blockedSourceSide = blockedForHost?.sourceSide ?? 0;

    return {
      id: w.id,
      group: groupId,
      hostname,
      // Real, live core count from this same poll when available, falling back to the
      // heartbeat-cached `/master/workers` figure (still real, just possibly a poll behind).
      cpus: nodeInfo?.cpus?.length ?? w.info?.cpus,
      disconnected: w.disconnected ?? false,
      workerProcesses: w.workerProcesses ?? 1,
      status: w.status,
      lastMsgTime: w.lastMsgTime,
      loadPct,
      memUsedBytes: memTotal !== undefined && memFree !== undefined ? memTotal - memFree : undefined,
      memTotalBytes: memTotal,
      diskUsedBytes: nodeInfo?.diskUsage?.bytesUsed,
      diskTotalBytes: nodeInfo?.diskUsage?.totalDiskSize,
      uptimeSeconds: nodeInfo?.uptime,
      nodeInfo,
      // Placeholder, unfiltered total — `useWorkerFleet`'s own wrapping `useMemo` re-derives the
      // real, final value against the live connectivity filter on every render, without a
      // network refetch; this raw sum is what a caller sees only until that memo first runs.
      blockedCount: blockedSourceSide + Object.values(blockedByOutput).reduce((sum, v) => sum + v, 0),
      blockedByOutput,
      blockedSourceSide,
      heartbeatLagSeconds: heartbeat[hostname],
      volumeIn: volume[hostname]?.in ?? 0,
      volumeOut: volume[hostname]?.out ?? 0,
    };
  });
}

/**
 * Real per-worker fleet data for the Overview page — `/master/workers` fetched once (unprefixed,
 * covers every group), then resource/blocked/heartbeat/volume metrics fetched per Worker Group in
 * `groupIds` in parallel (each metric query is scoped by a single `__worker_group` `where` clause,
 * so "All Worker Groups" means one call per real group, mirroring `useMultiGroupFlowGraph`'s own
 * per-group-then-merge shape rather than inventing a multi-group `where` expression). Keyed by each
 * worker's own real `id` (a stable guid) in the returned array, not hostname — a cross-group
 * hostname collision, while unlikely, would still produce two legitimately distinct rows rather
 * than silently merging.
 *
 * `connectedAndFedOutputKeys` (from `lib/topology.ts`'s `connectedAndFedDestinationKeys`,
 * `undefined` until the page's own flow graph has loaded) is deliberately *not* part of the fetch
 * effect's own dependency array — the raw network fetch (including each worker's real, unfiltered
 * `blockedByOutput` breakdown) doesn't need to change when it changes, only the final `blockedCount`
 * derived from that breakdown does, via the wrapping `useMemo` below. This avoids an unnecessary
 * real refetch from Cribl every time the flow graph refreshes independently of the fleet itself.
 */
export function useWorkerFleet(
  groupIds: string[],
  unit: VolumeUnit,
  timeRangeId: TimeRangeOption['id'],
  connectedAndFedOutputKeys: Set<string> | undefined,
): UseWorkerFleetResult {
  const [rawRows, setRawRows] = useState<WorkerFleetRow[]>([]);
  const [status, setStatus] = useState<UseWorkerFleetResult['status']>('idle');
  const [error, setError] = useState<string | undefined>(undefined);
  const [isPermissionError, setIsPermissionError] = useState(false);
  const [nonce, setNonce] = useState(0);
  const requestId = useRef(0);
  const groupIdsKey = groupIds.join(',');
  // Persists across every refresh for the life of this hook instance (never reset by the effect
  // below re-running) — the CPU%-via-delta computation (`computeCpuPct`) needs each worker's own
  // *previous* poll to diff the *current* one against; keeping this outside the effect is what
  // lets the second poll for a worker (a manual refresh, the auto-refresh interval, or switching
  // back to a group already visited this session) produce a real number instead of every single
  // poll starting from scratch.
  const cpuSamplesRef = useRef<Map<string, CpuTimesSample>>(new Map());

  useEffect(() => {
    if (groupIds.length === 0) {
      setStatus('idle');
      setRawRows([]);
      return;
    }

    const myRequestId = ++requestId.current;
    setStatus('loading');
    setError(undefined);
    setIsPermissionError(false);

    const { earliest, latest } = timeRangeToWindow(timeRangeId);

    listWorkers()
      .then((allWorkers) => Promise.all(groupIds.map((gid) => fetchOneGroupFleet(gid, allWorkers, unit, earliest, latest, cpuSamplesRef.current))))
      .then((perGroup) => {
        if (myRequestId !== requestId.current) return;
        setRawRows(perGroup.flat());
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (myRequestId !== requestId.current) return;
        setStatus('error');
        setIsPermissionError(err instanceof PermissionError);
        setError(err instanceof Error ? err.message : String(err));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `groupIdsKey` stands in for `groupIds`.
  }, [groupIdsKey, unit, timeRangeId, nonce]);

  // The real, final `blockedCount` per row — re-derived here, not refetched, every time the live
  // connectivity filter changes (see this hook's own doc comment). `undefined` (the flow graph
  // hasn't loaded yet) means "no filter data available," which deliberately falls back to each
  // row's own already-unfiltered placeholder total rather than showing a false `0` while real
  // topology data is still on its way in.
  const rows = useMemo(() => {
    if (!connectedAndFedOutputKeys) return rawRows;
    return rawRows.map((r) => {
      let filteredDestBlocked = 0;
      for (const [output, count] of Object.entries(r.blockedByOutput)) {
        if (connectedAndFedOutputKeys.has(output)) filteredDestBlocked += count;
      }
      return { ...r, blockedCount: r.blockedSourceSide + filteredDestBlocked };
    });
  }, [rawRows, connectedAndFedOutputKeys]);

  // Stable across renders (matching `useFlowGraph`'s own identical `refresh`) — callers that build
  // an auto-refresh `setInterval` keyed on this reference (see OverviewPage.tsx) need it to not be
  // a new closure every render, or the interval would be torn down and recreated constantly.
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { rows, status, error, isPermissionError, refresh };
}
