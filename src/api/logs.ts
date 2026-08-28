import { api } from './client';
import { escapeFilterLiteral } from './metrics';

// /system/logs/search — Cribl's own raw internal log search (reads the real .log files on disk,
// not the metrics store). Marked `x-cribl-availability: onprem`... no — marked
// `x-cribl-internal: true` in the bundled openapi.json, unlike every other endpoint this app
// calls (`/system/metrics/query`/`/master/workers`/etc. are all `false`) — a real signal Cribl
// doesn't consider this part of the officially-supported product API for third-party Apps, even
// though it worked fine live against the test org with the same OAuth credentials used everywhere
// else in this app. Used here per explicit direction, with that caveat on record.
//
// Confirmed live (read-only validation, not guessed): `et`/`lt` are Unix seconds (not ms — tested
// both, seconds is the form that reliably narrows results to a specific past window); `type=group`
// + `groupId` scopes to one Worker Group's own logs (Leader *and* Worker-process log files
// together — confirmed via a real backpressure warning that came from a `/worker/0/cribl.log`
// path through this exact query shape); `filter` accepts a JS-like boolean expression evaluated
// per log line, same family of filter DSL as this app's other `escapeFilterLiteral` use, hence
// reusing it here rather than a second copy.
//
// Confirmed live shape of a Function-related log line — Cribl tags every `func:*`-channel entry
// (not just the "Code"/raw-JS function type, which is the only one documenting this in its own
// config schema) with real `pipelineName` and `functionZeroIndex` fields directly on the event,
// not just embedded in the channel string:
//   { time: "2026-08-02T21:49:46.167Z", channel: "func:sampling", level: "info",
//     message: "initialized", pipelineName: "palo_alto_traffic", functionZeroIndex: 5, ... }
// No pipeline in this test org has ever actually logged a real `level: "error"` entry (confirmed
// live: zero results for `level=='error'` across the full 90-day retention, org-wide, matching
// `pipe.err_events`'s own always-empty history) — so this exact shape is only confirmed for
// `info`-level entries; an `error`-level one is expected, not confirmed, to carry the same fields,
// since every `func:*` sample seen shares this one consistent structure.

interface RawLogEvent {
  time?: string;
  channel?: string;
  level?: string;
  message?: string;
  pipelineName?: string;
  functionZeroIndex?: number;
  host?: string;
  /** Present on some subsystems' entries (e.g. output backpressure) with a more specific message
   *  than the top-level `message` field. */
  trigger?: { message?: string };
  reason?: { message?: string };
}

interface RawLogSearchResponse {
  items?: { events?: RawLogEvent[] }[];
  count?: number;
}

export interface FunctionErrorLogEntry {
  /** Unix ms. */
  time: number;
  /** Zero-based position of the erroring Function within its Pipeline's own function list —
   *  matches the array index into `RawPipeline.conf.functions`. */
  functionZeroIndex: number;
  message: string;
  channel: string;
  host?: string;
}

/**
 * Real per-function processing errors for one Pipeline, over the given window — the log-search
 * counterpart to `pipe.err_events`'s own whole-pipeline count (see `fetchPipelineVolumeTotals`),
 * attributing each error to the specific Function that threw it via `functionZeroIndex`.
 */
export async function fetchPipelineFunctionErrors(opts: {
  groupId: string;
  pipelineId: string;
  earliest: number;
  latest: number;
}): Promise<FunctionErrorLogEntry[]> {
  const { groupId, pipelineId, earliest, latest } = opts;
  const filter = `level=='error' && channel && channel.indexOf('func:')===0 && pipelineName=='${escapeFilterLiteral(pipelineId)}'`;
  const params = new URLSearchParams({
    type: 'group',
    groupId,
    limit: '200',
    et: String(Math.floor(earliest / 1000)),
    lt: String(Math.floor(latest / 1000)),
    filter,
  });

  const res = await api.get<RawLogSearchResponse>(`/system/logs/search?${params.toString()}`);
  const events = res.items?.[0]?.events ?? [];

  const entries: FunctionErrorLogEntry[] = [];
  for (const e of events) {
    if (typeof e.functionZeroIndex !== 'number' || typeof e.time !== 'string') continue;
    const time = new Date(e.time).getTime();
    if (!Number.isFinite(time)) continue;
    entries.push({
      time,
      functionZeroIndex: e.functionZeroIndex,
      message: e.trigger?.message ?? e.reason?.message ?? e.message ?? '(no message)',
      channel: e.channel ?? '',
      host: e.host,
    });
  }
  return entries.sort((a, b) => b.time - a.time);
}
