import { api, workerScoped, type ApiListResponse } from './client';

// Confirmed live against the test org (see CLAUDE.md's Thirtieth round): `/master/workers` is an
// ordinary, unprefixed endpoint (same family as `/master/groups`); each item's `id` is exactly
// the value the real Leader UI's own `/w/:workerId/...` calls use to scope to that one Worker
// process.
//
// `info` fields below (beyond the original `hostname`) were confirmed live for the Overview page
// — `conn_ip` (the connection-source IP as seen by the Leader; `os.addresses` supplements it with
// real local interface IPs on the one worker type that reported them, Edge/Windows), `cpus`/
// `totalmem`/`totalDiskSpace`/`freeDiskSpace` (configured resources), and top-level
// `workerProcesses`/`disconnected` (fleet identity/connectivity). None of this was previously read
// anywhere in this app.
export interface RawWorker {
  id: string;
  group?: string;
  status?: string;
  info?: {
    hostname?: string;
    platform?: string;
    cpus?: number;
    totalmem?: number;
    conn_ip?: string;
    os?: { addresses?: string[] };
    totalDiskSpace?: number;
    freeDiskSpace?: number;
  };
  workerProcesses?: number;
  disconnected?: boolean;
  /** Real per-node liveness signal, confirmed live on `/master/workers` for both Stream Workers and
   *  Edge Nodes alike (`MasterWorkerEntry`'s own schema: "Timestamp (in Unix time) when the Leader
   *  last received a message from the node") — a genuine heartbeat, not a cached/derived value.
   *  Confirmed by direct comparison against the real test org: a Stream worker (10s heartbeat
   *  period) and an Edge node (60s heartbeat period) both reported a `lastMsgTime` within their own
   *  configured period of the request's own real time. This is the field `disconnected` is itself
   *  derived from server-side — surfaced here directly so the UI can show *how* recently a node was
   *  last heard from, not just a binary connected/disconnected verdict. Epoch milliseconds. */
  lastMsgTime?: number;
}

export async function listWorkers(): Promise<RawWorker[]> {
  const res = await api.get<ApiListResponse<RawWorker>>('/master/workers');
  return res.items;
}

/** Per-worker persistent-queue detail — `WorkerPQStatus` in this project's own `openapi.json`.
 *  `health` is documented there as a bare `number`, not the `Green`/`Yellow`/`Red` string enum the
 *  group-scoped `pq.health` uses — kept as `unknown` rather than guessed/narrowed, since no
 *  component in the test org currently has PQ enabled to confirm a real value against live.
 *  `metrics` is `additionalProperties: true` in the schema (no field names declared at all), so
 *  it's read and displayed generically rather than assuming specific keys this app hasn't
 *  actually observed. */
interface RawWorkerPqStatus {
  health?: unknown;
  error?: { message?: string };
  metrics?: Record<string, unknown>;
  timestamp?: number;
}

/** Cribl's own error shape on a per-worker status entry — `message` is a stable, human-written
 *  summary ("connection error") present for any failure type; `details` is an unstructured,
 *  connector-specific bag with no fixed/documented shape (confirmed live: its own fields vary),
 *  so only its own `error` field is read, defensively, and only when it's actually a string. When
 *  present, `details.error` carries the real underlying failure text Cribl's own `message` doesn't
 *  include on its own (e.g. `"connect ECONNREFUSED 127.0.0.1:9997"`, confirmed live against a real
 *  blocked Destination in the test org). */
interface RawStatusError {
  message?: string;
  details?: { error?: string; [key: string]: unknown };
}

/** One entry of a multi-listener/multi-connection connector type's own per-connection status —
 *  confirmed live against the test org for a `tcpjson` Destination: rather than one top-level
 *  `status.error`, it reports `status.metrics.items[]`, one entry per active listener, each with
 *  its *own* nested `status.error`. Without this fallback, this app's "Detail" column silently
 *  read blank for a connector type shaped this way, even though Cribl genuinely reported a real
 *  error for it — just one level deeper than the top-level `status.error` this app originally only
 *  ever looked at. */
interface RawMultiConnectionItem {
  name?: string;
  host?: string;
  port?: number;
  status?: { error?: RawStatusError };
}

/**
 * Per-worker Destination status — trimmed to the fields this app reads. Confirmed live: this is
 * the same shape the real Leader UI's own per-Destination Status tab is built from, and is
 * materially more detailed than the group-scoped status list (`api/topology.ts`'s
 * `getOutputStatus`), which only ever returns a health rolled up across every worker in the
 * group plus an empty `metrics: {}`.
 */
interface RawWorkerOutputStatus {
  id: string;
  type?: string;
  status?: {
    health?: 'Green' | 'Yellow' | 'Red' | 'Unknown';
    healthCounts?: Record<string, number>;
    timestamp?: number;
    error?: RawStatusError;
    metrics?: {
      connected?: boolean;
      closed?: boolean;
      numBytesInBuffer?: number;
      numEventsInBuffer?: number;
      sentCount?: number;
      sentBytes?: number;
      dropBytes?: number;
      lastConnectTime?: number;
      lastFlushTime?: number;
      blockedSince?: number;
      /** See `RawMultiConnectionItem`'s own doc comment — present only for multi-listener
       *  connector types (e.g. `tcpjson`), absent for a single-connection type like `splunk`. */
      items?: RawMultiConnectionItem[];
    };
    pq?: RawWorkerPqStatus;
  };
}

/** Resolves to `undefined` rather than throwing if this one worker has nothing to report for the given Destination id. */
async function getWorkerOutputStatus(workerId: string, outputId: string): Promise<RawWorkerOutputStatus | undefined> {
  const res = await api.get<ApiListResponse<RawWorkerOutputStatus>>(
    workerScoped(workerId, `/system/status/outputs/${encodeURIComponent(outputId)}?metrics=true`),
  );
  return res.items[0];
}

/** Mirrors `RawWorkerOutputStatus` for Sources — confirmed live that `/w/:workerId/system/status/
 *  inputs/:id` is a real, working endpoint (not previously used anywhere in this app; every prior
 *  per-worker fetch was Destination-only). A Source's own `metrics` shape varies a lot by
 *  connector type (confirmed live: an HTTP Source reports connection counters, an AppScope Source
 *  reports just `count`), so it's left as a loose bag rather than a fixed shape — only `pq` is
 *  typed concretely, since that's the one field this app actually reads structurally here. A
 *  possible `items[]` (see `RawMultiConnectionItem`) is read defensively off that same loose bag
 *  for the identical multi-listener fallback `RawWorkerOutputStatus` needs — not yet confirmed
 *  live for any Source in the test org, but the same real platform shape could plausibly apply to
 *  a multi-listener Source connector too. */
interface RawWorkerInputStatus {
  id: string;
  type?: string;
  status?: {
    health?: 'Green' | 'Yellow' | 'Red' | 'Unknown';
    healthCounts?: Record<string, number>;
    timestamp?: number;
    error?: RawStatusError;
    metrics?: Record<string, unknown> & { items?: RawMultiConnectionItem[] };
    pq?: RawWorkerPqStatus;
  };
}

/** Resolves to `undefined` rather than throwing if this one worker has nothing to report for the given Source id. */
async function getWorkerInputStatus(workerId: string, inputId: string): Promise<RawWorkerInputStatus | undefined> {
  const res = await api.get<ApiListResponse<RawWorkerInputStatus>>(
    workerScoped(workerId, `/system/status/inputs/${encodeURIComponent(inputId)}?metrics=true`),
  );
  return res.items[0];
}

/** This app's own generic view of a component's persistent-queue state, once resolved from
 *  whichever raw per-worker status shape (`RawWorkerOutputStatus`/`RawWorkerInputStatus`) it came
 *  from — `metrics` stays a raw, unlabeled bag (see `RawWorkerPqStatus`'s own doc comment for why)
 *  and is rendered as a generic key/value list rather than named fields this app hasn't actually
 *  confirmed exist. */
interface WorkerPqDetail {
  health?: unknown;
  error?: string;
  metrics?: Record<string, unknown>;
}

/** One row per Worker process reporting on a given Source or Destination — the shape both the Signal Path drawer's "Per-worker status" table and every page's blocked-worker badge are built from. */
export interface WorkerStatusRow {
  workerId: string;
  hostname?: string;
  health?: string;
  connected?: boolean;
  bufferedBytes?: number;
  bufferedEvents?: number;
  /** Cribl's own cumulative "sent" counters — real per-worker byte/event counts reported as
   *  having left the buffer. Surfaced specifically so a caller can tell a genuinely-delivering
   *  connection apart from one where the buffer is simply stuck: Cribl keeps reporting a nonzero
   *  `sentBytes`/`sentCount` from *before* a connection blocked, which reads as "still sending"
   *  unless compared against the buffer itself — see the Overview page's "Top Source Volume
   *  Trends" panel, the first consumer of these two fields. */
  sentBytes?: number;
  sentEvents?: number;
  /** Cribl's own `blockedSince` field, kept for display/debugging — **confirmed live against the
   *  real test org not to be a usable wall-clock epoch-ms value**: read alongside `status.timestamp`
   *  and `lastConnectTime` (both plausible epoch-ms, ~2026) on a genuinely-blocked Destination, this
   *  came back at roughly *double* their magnitude (e.g. `3572074756199` vs. a real `1786037379142`
   *  `timestamp` moments later) — not a units mismatch this app can safely "fix" by dividing by two
   *  (undocumented, could differ by Cribl version/environment), just an unreliable field. Do **not**
   *  compare this against real trend-bucket timestamps — see `lastFlushTime` below for the field
   *  that turned out to actually work for that. */
  blockedSince?: number;
  /** Real epoch-ms timestamp of this worker's own last flush attempt — confirmed live to be a
   *  sane, comparable wall-clock value (unlike `blockedSince` above) on a genuinely-stuck
   *  Destination: a `lastFlushTime` well in the past matched the real incident's own actual start,
   *  while `sentBytes`/`sentCount` kept reporting as if nothing had changed since. This is what
   *  `lib/blockedOutput.ts`'s trend correction actually anchors on. */
  lastFlushTime?: number;
  error?: WorkerErrorInfo;
  /** Persistent-queue detail for this one worker, when PQ is enabled on the component — `undefined` otherwise. */
  pq?: WorkerPqDetail;
  /**
   * Set only when rows from more than one real Destination have been concatenated into one list —
   * an Output Router's own rollup across its real targets. Left `undefined` for every single-Destination
   * caller (it's already named by the card/cell/node the badge is attached to), which
   * `WorkerAlertBadge` uses to decide whether to show a "Destination" column at all.
   */
  destinationLabel?: string;
}

function pqDetailOf(pq: RawWorkerPqStatus | undefined): WorkerPqDetail | undefined {
  if (!pq) return undefined;
  return { health: pq.health, error: pq.error?.message, metrics: pq.metrics };
}

/** This app's own view of a real connector error — `message` is Cribl's own stable, human-written
 *  summary (works for any failure type, "connection error"); `detail`, when present, is the real
 *  underlying failure text (e.g. "connect ECONNREFUSED 127.0.0.1:9997") that `message` alone
 *  doesn't include — see `RawStatusError`'s own doc comment for why `details` isn't trusted beyond
 *  its own `error` string field. Rendered as two separate lines wherever this app shows a worker's
 *  own error detail, not concatenated into one string — see `WorkerAlertBadge.tsx`/
 *  `NodeDetailPanel.tsx`. */
interface WorkerErrorInfo {
  message: string;
  detail?: string;
}

/** Resolves a real, displayable error out of Cribl's own per-worker status shape — falling back to
 *  the first nested per-connection error under `metrics.items[]` (see `RawMultiConnectionItem`)
 *  when there's no single top-level `status.error` to read, the shape a multi-listener connector
 *  type (confirmed live: `tcpjson`) reports instead. Without this fallback, a real, live-confirmed
 *  blocked Destination of this connector type read as a blank "—" in this app's own Detail column
 *  despite Cribl genuinely reporting a real error for it. */
function errorInfoFrom(topError: RawStatusError | undefined, items: RawMultiConnectionItem[] | undefined): WorkerErrorInfo | undefined {
  const source = topError?.message ? topError : items?.find((item) => item.status?.error?.message)?.status?.error;
  if (!source?.message) return undefined;
  return { message: source.message, detail: typeof source.details?.error === 'string' ? source.details.error : undefined };
}

/**
 * Real per-worker status for every given Destination, across every Worker process in `groupId` —
 * one `listWorkers()` call total regardless of how many Destinations are asked for, not one per
 * Destination (this matters once a caller asks for many at once, e.g. every Destination in a
 * Worker Group). One worker failing to respond doesn't blank out
 * the rest of that Destination's breakdown (individual `try/catch` per worker) — callers should
 * treat the whole call throwing as "couldn't even list workers" (e.g. an older install that hasn't
 * granted the `/master/workers` policy yet) and degrade to no breakdown, since the existing
 * group-scoped headline status still renders regardless.
 */
export async function fetchWorkerStatusesForOutputs(groupId: string, outputIds: string[]): Promise<Map<string, WorkerStatusRow[]>> {
  const workers = await listWorkers();
  const inGroup = workers.filter((w) => w.group === groupId);
  const entries = await Promise.all(
    outputIds.map(async (outputId): Promise<readonly [string, WorkerStatusRow[]]> => {
      const rows = await Promise.all(
        inGroup.map(async (worker): Promise<WorkerStatusRow> => {
          try {
            const entry = await getWorkerOutputStatus(worker.id, outputId);
            return {
              workerId: worker.id,
              hostname: worker.info?.hostname,
              health: entry?.status?.health,
              connected: entry?.status?.metrics?.connected,
              bufferedBytes: entry?.status?.metrics?.numBytesInBuffer,
              bufferedEvents: entry?.status?.metrics?.numEventsInBuffer,
              sentBytes: entry?.status?.metrics?.sentBytes,
              sentEvents: entry?.status?.metrics?.sentCount,
              blockedSince: entry?.status?.metrics?.blockedSince,
              lastFlushTime: entry?.status?.metrics?.lastFlushTime,
              error: errorInfoFrom(entry?.status?.error, entry?.status?.metrics?.items),
              pq: pqDetailOf(entry?.status?.pq),
            };
          } catch {
            return { workerId: worker.id, hostname: worker.info?.hostname };
          }
        }),
      );
      return [outputId, rows] as const;
    }),
  );
  return new Map(entries);
}

/** Mirrors `fetchWorkerStatusesForOutputs` for Sources — same one-`listWorkers()`-call shape,
 *  same per-worker `try/catch` isolation. Sources have no "connected"/buffered-send concept the
 *  way a Destination does, so those two fields are always left `undefined` here; `pq` is the field
 *  this exists for. */
export async function fetchWorkerStatusesForInputs(groupId: string, inputIds: string[]): Promise<Map<string, WorkerStatusRow[]>> {
  const workers = await listWorkers();
  const inGroup = workers.filter((w) => w.group === groupId);
  const entries = await Promise.all(
    inputIds.map(async (inputId): Promise<readonly [string, WorkerStatusRow[]]> => {
      const rows = await Promise.all(
        inGroup.map(async (worker): Promise<WorkerStatusRow> => {
          try {
            const entry = await getWorkerInputStatus(worker.id, inputId);
            return {
              workerId: worker.id,
              hostname: worker.info?.hostname,
              health: entry?.status?.health,
              error: errorInfoFrom(entry?.status?.error, entry?.status?.metrics?.items),
              pq: pqDetailOf(entry?.status?.pq),
            };
          } catch {
            return { workerId: worker.id, hostname: worker.info?.hostname };
          }
        }),
      );
      return [inputId, rows] as const;
    }),
  );
  return new Map(entries);
}

/** Maps Cribl's own three-state connector health onto this app's status-appearance vocabulary — kept here since this raw string enum only ever shows up in this per-worker breakdown, nowhere else in the app's shared health model. */
export const WORKER_HEALTH_APPEARANCE: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  Green: 'success',
  Yellow: 'warning',
  Red: 'danger',
  Unknown: 'default',
};
