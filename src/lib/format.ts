import type { VolumeUnit } from './types';
import { criblOrigin } from './criblLinks';

const EVENT_UNITS = ['', 'K', 'M', 'B'];
// Two-character byte-scale suffixes (KB/MB/GB/TB), not single letters (K/M/G/T) — an earlier round
// shortened these to match the event-count suffixes above, but per direct, later feedback a bare
// "K"/"M"/"G" reads as ambiguous for bytes specifically (unlike events, where K/M/B has no
// competing unit it could be confused with) — reverted back to the more conventional two-character
// form for bytes only; `EVENT_UNITS` above is unchanged.
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function scale(value: number, base: number, units: string[]): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  let v = Math.abs(value);
  let i = 0;
  while (v >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  const precision = i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${sign}${v.toFixed(precision)}${units[i]}`;
}

function formatEvents(value: number): string {
  return scale(value, 1000, EVENT_UNITS);
}

export function formatBytes(value: number): string {
  return scale(value, 1024, BYTE_UNITS);
}

export function formatMetric(value: number, unit: VolumeUnit): string {
  return unit === 'bytes' ? formatBytes(value) : formatEvents(value);
}

export function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Axis-label form: hour:minute only — chart x-axis ticks don't need seconds or the date. */
export function formatTimeShort(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Date-only, no time — for the Daily Ingest chart's day-granular axis/tooltips, where every
 *  point already represents a whole day and a time-of-day component would be noise. */
export function formatDateShort(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Hour-only, no date — the same chart's 24h/hourly axis/tooltips, where every point is already
 *  within the last day and a repeated date would be noise instead. */
export function formatHourShort(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric' });
}

/** Full calendar date, for a license's issued/expiry date — a year matters there in a way it
 *  doesn't for a chart axis tick that's always within the current year's recent history. */
export function formatDateLong(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** This org's own real Cribl.Cloud subdomain segment (e.g. `main-infallible-jackson-x3zlthz` from
 *  `main-infallible-jackson-x3zlthz.cribl.cloud`) — confirmed live that a real, SaaS-hosted Stream
 *  Worker's own hostname always ends with exactly this same segment (`ip-10-247-1-226-main-
 *  infallible-jackson-x3zlthz`), which is what `trimOrgFromHostname` strips. `undefined` for a
 *  non-SaaS deployment (`CRIBL_API_URL` pointing anywhere other than `*.cribl.cloud`, e.g.
 *  AGENTS.md's own documented on-prem example `https://localhost:9000/api/v1`) — there's no such
 *  segment to derive there at all, and nothing gets trimmed.
 */
function criblCloudOrgSlug(): string | undefined {
  const match = /^https?:\/\/([^./]+)\.cribl\.cloud$/i.exec(criblOrigin());
  return match?.[1];
}

/**
 * A real Worker/Edge Node hostname with this org's own workspace+org slug trimmed off the end,
 * when present, to save space in a compact list/table — derived live from the org's own real API
 * domain (`criblCloudOrgSlug`), never a hardcoded/guessed suffix pattern, so it only ever trims
 * the exact segment that's actually this org's own. A hostname that doesn't end with it (an Edge
 * Node's own plain OS hostname — confirmed live these don't carry any such suffix — an on-prem
 * Worker, or any non-Cribl.Cloud deployment) is returned unchanged, not guessed at.
 */
export function trimOrgFromHostname(hostname: string): string {
  const slug = criblCloudOrgSlug();
  if (!slug) return hostname;
  const suffix = `-${slug}`;
  return hostname.toLowerCase().endsWith(suffix.toLowerCase()) ? hostname.slice(0, hostname.length - suffix.length) : hostname;
}

/** A worker node's own real `/system/info` uptime (seconds) as a compact "11d 4h" / "3h 12m" /
 *  "42m" string — whichever two units are actually meaningful at that magnitude, matching this
 *  app's own general preference for a short, glanceable figure over a full duration breakdown. */
/** A real per-node heartbeat timestamp (`WorkerFleetRow.lastMsgTime`) as a compact "12s ago" /
 *  "4m ago" / "3h ago" string — the Node Inventory table's own real "is this node alive" reading,
 *  in place of Cribl's raw process-level `status` string (which stays `"healthy"` through real
 *  backpressure/degradation and says nothing about actual connectivity). `undefined` only if the
 *  org hasn't granted `/master/workers`' own `lastMsgTime` field. A negative delta (clock skew
 *  between this browser and the Leader) reads as "just now" rather than a confusing negative age. */
export function formatRelativeAge(sinceMs: number | undefined, nowMs: number = Date.now()): string {
  if (sinceMs === undefined || !Number.isFinite(sinceMs)) return '—';
  const deltaSeconds = Math.max(0, Math.round((nowMs - sinceMs) / 1000));
  if (deltaSeconds < 5) return 'just now';
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatUptime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
