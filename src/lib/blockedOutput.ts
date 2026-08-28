import type { TrendPoint } from '../api/metrics';
import type { WorkerStatusRow } from '../api/workers';

/**
 * A Destination is genuinely blocked, not merely trailing off — real per-worker `Red` health
 * *and* its own buffered count exactly equals its own "sent" count, summed across every Worker
 * process reporting on it. Cribl keeps `sentBytes`/`sentCount` at whatever value they'd reached
 * right before the connection blocked — read on its own, that looks like "still sending," when
 * nothing further is actually leaving the buffer. Checked in whichever unit (bytes or events)
 * actually shows the stuck condition, independent of which unit the caller currently displays,
 * since the underlying fault isn't unit-specific. Originally built for the Overview page's "Top
 * Source Volume Trends" panel; shared here so the Signal Path drawer and Flow Explorer's own
 * Trend column can apply the identical real signal instead of a second copy.
 */
export function isDestinationStuck(rows: WorkerStatusRow[] | undefined): boolean {
  if (!rows || rows.length === 0) return false;
  let bufferedBytes = 0;
  let sentBytes = 0;
  let bufferedEvents = 0;
  let sentEvents = 0;
  let sawBlocked = false;
  for (const r of rows) {
    bufferedBytes += r.bufferedBytes ?? 0;
    sentBytes += r.sentBytes ?? 0;
    bufferedEvents += r.bufferedEvents ?? 0;
    sentEvents += r.sentEvents ?? 0;
    if (r.health === 'Red') sawBlocked = true;
  }
  if (!sawBlocked) return false;
  return (bufferedBytes > 0 && bufferedBytes === sentBytes) || (bufferedEvents > 0 && bufferedEvents === sentEvents);
}

/** The latest real `lastFlushTime` among rows that are actually reporting `Red` — the most recent
 *  moment *any* stuck worker last genuinely flushed, so it's the earliest point this app can be
 *  confident nothing further actually left (a worker that recovered, no longer `Red`, shouldn't
 *  anchor this even if it still carries a stale value from an earlier incident). `undefined` if
 *  none — `blockedSince` was tried here first and confirmed live (see `WorkerStatusRow`'s own doc
 *  comment) to not be a usable wall-clock value at all, so it's deliberately not used. */
function lastRealFlushTime(rows: WorkerStatusRow[] | undefined): number | undefined {
  let latest: number | undefined;
  for (const r of rows ?? []) {
    if (r.health !== 'Red' || r.lastFlushTime === undefined) continue;
    if (latest === undefined || r.lastFlushTime > latest) latest = r.lastFlushTime;
  }
  return latest;
}

/**
 * Corrects a historical volume trend for a Destination that's genuinely stuck (see
 * `isDestinationStuck`) — every metric this app can query for a Destination's own "out" figure
 * (`total.out_events`/`route.in_events`/etc.) reflects what was *handed to* the output stage, not
 * what actually left it, so a blocked connection still reads as flowing right up to "now." Real
 * per-worker status gives an honest correction: before its own last real flush, egress was
 * genuinely happening and the queried trend is left alone; from that real moment onward, nothing
 * is actually leaving, so every bucket at or after it is zeroed. Not stuck, or no real
 * `lastFlushTime` to anchor on (e.g. a mocked/older status shape) — returns `points` unchanged
 * rather than guessing at *when* it became stuck.
 */
export function applyBlockedTrendCorrection(points: TrendPoint[], rows: WorkerStatusRow[] | undefined): TrendPoint[] {
  if (!isDestinationStuck(rows)) return points;
  const anchor = lastRealFlushTime(rows);
  if (anchor === undefined) return points;
  return points.map((p) => (p.t >= anchor ? { t: p.t, v: 0 } : p));
}
