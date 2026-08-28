import { api, type ApiListResponse } from './client';
import { queryMetrics } from './metrics';
import { listWorkerGroups } from './groups';
import { listInputs } from './topology';
import { metricsKey } from '../lib/topology';
import { LICENSE_EXEMPT_SOURCE_TYPES } from '../lib/licenseExempt';

// /system/licenses and /system/licenses/usage — both unprefixed, Leader-level (no /m/:gid
// prefix, no groupId parameter anywhere in their own OpenAPI definitions) and, per the schema's
// own description, org-wide: `UsageMetricsExtended` (the usage endpoint's own item shape) has no
// Worker-Group field at all. Confirmed live against the test org that both actually return real
// 200 data despite the bundled openapi.json documenting them as `x-cribl-availability: onprem`
// with an explicit 403-in-SaaS-mode note — docs and live behavior disagree here; worth
// re-confirming per-org if this ever reads empty, since it may vary by org config or Cribl
// version rather than being a hard platform rule.

interface RawLicense {
  id: string;
  cls?: 'prod' | 'trial' | 'free';
  title?: string;
  guid?: string;
  /** Allowed throughput in GB per day — a plain GB count, not bytes; see `quotaBytes` below. */
  quota?: number;
  /** Unix seconds. */
  exp?: number;
  /** Unix seconds. */
  iat?: number;
}

export interface LicenseInfo {
  id: string;
  cls?: 'prod' | 'trial' | 'free';
  title?: string;
  guid?: string;
  quotaGb: number;
  /** `quotaGb` converted to bytes (GB * 1024^3) so every figure on this page can share the same
   *  `formatBytes` scale as the rest of the app, rather than a separate GB-only formatter. */
  quotaBytes: number;
  /** Unix ms. */
  expiresAt?: number;
  /** Unix ms. */
  issuedAt?: number;
}

function normalizeLicense(raw: RawLicense): LicenseInfo {
  const quotaGb = raw.quota ?? 0;
  return {
    id: raw.id,
    cls: raw.cls,
    title: raw.title,
    guid: raw.guid,
    quotaGb,
    quotaBytes: quotaGb * 1024 ** 3,
    expiresAt: raw.exp !== undefined ? raw.exp * 1000 : undefined,
    issuedAt: raw.iat !== undefined ? raw.iat * 1000 : undefined,
  };
}

/** The org's ingest-based license entitlement. `undefined` if the org genuinely has none on this
 *  endpoint (e.g. a Credits-based org — see CLAUDE.md, this app only builds the ingest-based view
 *  in this phase) rather than treating an empty list as an error. */
export async function fetchLicenseInfo(): Promise<LicenseInfo | undefined> {
  const res = await api.get<ApiListResponse<RawLicense>>('/system/licenses');
  const first = res.items[0];
  return first ? normalizeLicense(first) : undefined;
}

interface RawLicenseUsageItem {
  /** Unix ms. */
  startTime: number;
  /** Unix ms. */
  endTime: number;
  inBytes: number;
  outBytes: number;
  inEvents: number;
  outEvents: number;
  droppedBytes: number;
  exemptedLicenseInBytes: number;
}

export interface LicenseUsageDay {
  /** Unix ms, start of day. */
  date: number;
  inBytes: number;
  outBytes: number;
  inEvents: number;
  outEvents: number;
  droppedBytes: number;
  exemptedLicenseInBytes: number;
}

/** Real daily-bucketed usage, up to the last 90 days Cribl retains — however much of that is
 *  actually populated for this org (confirmed live: 31 real days for the test org, not
 *  necessarily the full 90 every org will have). Sorted oldest-first. */
export async function fetchLicenseUsage(): Promise<LicenseUsageDay[]> {
  const res = await api.get<ApiListResponse<RawLicenseUsageItem>>('/system/licenses/usage');
  return res.items
    .map((item) => ({
      date: item.startTime,
      inBytes: item.inBytes ?? 0,
      outBytes: item.outBytes ?? 0,
      inEvents: item.inEvents ?? 0,
      outEvents: item.outEvents ?? 0,
      droppedBytes: item.droppedBytes ?? 0,
      exemptedLicenseInBytes: item.exemptedLicenseInBytes ?? 0,
    }))
    .sort((a, b) => a.date - b.date);
}

// --- Per-source breakdown, for the Usage chart's "By Source" view ---
//
// This page has no Worker Group filter (license entitlement isn't scoped to one — see the doc
// comment on the endpoints above), so the per-source split is built org-wide, across every real
// Worker Group at once, not just Stream ones — confirmed live that an Edge Fleet's own Sources
// (`system_state`, `windows_metrics`) genuinely contribute real `total.in_bytes`, so excluding
// non-Stream groups here would silently under-count real license-relevant ingest.

/** Composite key identifying one real Source across the whole org: its own Worker Group id plus
 *  its `metricsKey`-format (`${type}:${id}`) dimension value. Two different groups can each have a
 *  Source with the identical bare id (or even identical type+id) — confirmed live that the metrics
 *  store's own `input` dimension alone doesn't disambiguate them — so every per-source figure on
 *  this page is keyed by this pair, never `input` alone. */
function sourceKey(groupId: string, inputMetricsKey: string): string {
  return `${groupId}::${inputMetricsKey}`;
}

/** Friendly display label per `sourceKey`, built from every real Worker Group's own configured
 *  Sources — group-qualified (`id (Group Name)`) only where the bare id genuinely collides across
 *  more than one group, matching the same "qualify only on collision" convention `mergeFlowGraphs`
 *  already uses for Signal Path's own "All Worker Groups" view. A group whose Sources can't be
 *  listed (e.g. a policy not yet granted) is skipped, not treated as an error — the breakdown
 *  chart still works for every group that *is* reachable, just without labels for the rest (falls
 *  back to the raw key, see `useLicenseConsumption`). */
export async function fetchSourceLabels(): Promise<Map<string, string>> {
  const groups = await listWorkerGroups();
  const idOccurrences = new Map<string, number>();
  const entries: { key: string; groupName: string; id: string }[] = [];

  await Promise.all(
    groups.map(async (g) => {
      let inputs;
      try {
        inputs = await listInputs(g.id);
      } catch {
        return;
      }
      for (const input of inputs) {
        entries.push({ key: sourceKey(g.id, metricsKey(input.type, input.id)), groupName: g.name, id: input.id });
        idOccurrences.set(input.id, (idOccurrences.get(input.id) ?? 0) + 1);
      }
    }),
  );

  const labels = new Map<string, string>();
  for (const entry of entries) {
    const ambiguous = (idOccurrences.get(entry.id) ?? 0) > 1;
    labels.set(entry.key, ambiguous ? `${entry.id} (${entry.groupName})` : entry.id);
  }
  return labels;
}

export interface SourceDailyBreakdown {
  /** Unix ms, start of the bucket — a day for `fetchSourceDailyVolume`, an hour for
   *  `fetchSourceHourlyVolume` (shared type/shape, just a different real bucket size). */
  date: number;
  /** `sourceKey` -> bytes ingested in that bucket. */
  bySourceKey: Map<string, number>;
}

/**
 * Real daily per-Source ingest bytes, org-wide — **billable Sources only**. `total.in_bytes` split
 * by both `input` and `__worker_group` (not `input` alone) so two groups' Sources sharing an id are
 * kept separate, matching `fetchSourceLabels`'s own keying.
 *
 * A real Source whose own connector type is license-exempt (Datagen, CriblLogs, CriblMetrics — see
 * `LICENSE_EXEMPT_SOURCE_TYPES`'s own doc comment for the confirmed evidence) is filtered out
 * entirely here, at the source, rather than left in and merely unlabeled — per explicit direction,
 * the Daily Ingest panel should show only what actually counts against the license. This is
 * deliberately scoped to this one function family: Signal Path/Flow Explorer never call it, and
 * still show every real Source regardless of billing status, since those views track what's
 * actually happening to the data, not license-relevant volume.
 *
 * A 2-dimension split can return an extra rollup row that omits one of the two dimensions while
 * duplicating the sum of the other, fully-split rows for that same slice — confirmed live for
 * this exact query shape (see CLAUDE.md's own note on the identical quirk already found and fixed
 * for Node Inventory's volume figures). Any row missing either `input` or `__worker_group` is
 * skipped rather than trusted, the same defensive guard used there.
 *
 * How much real history this actually returns depends on the org's own metrics-store retention —
 * confirmed live that this test org's own retention for this particular split is much shorter
 * than the 90-day history `/system/licenses/usage` itself carries, so a day within the requested
 * range can legitimately come back with no per-source rows at all even though the license usage
 * total for that same day is real. `useLicenseConsumption` renders that gap honestly (an
 * "Unattributed" segment) rather than pretending a shorter real window is the full range.
 */
export async function fetchSourceDailyVolume(opts: { earliest: number; latest: number }): Promise<SourceDailyBreakdown[]> {
  return fetchSourceBreakdown({ ...opts, timeWindowSeconds: 86400 });
}

/** Real hourly per-Source ingest bytes, org-wide — the 24h/1h alternative to
 *  `fetchSourceDailyVolume` above, same query shape at a finer bucket size. There's no hourly
 *  equivalent of `/system/licenses/usage` (confirmed live — that endpoint is inherently
 *  day-bucketed), so unlike the daily case, a caller using this has no separate
 *  license-authoritative total to reconcile against: each bucket's own real breakdown sum *is*
 *  the real total for that hour. */
export async function fetchSourceHourlyVolume(opts: { earliest: number; latest: number }): Promise<SourceDailyBreakdown[]> {
  return fetchSourceBreakdown({ ...opts, timeWindowSeconds: 3600 });
}

async function fetchSourceBreakdown(opts: { earliest: number; latest: number; timeWindowSeconds: number }): Promise<SourceDailyBreakdown[]> {
  const { earliest, latest, timeWindowSeconds } = opts;
  const res = await queryMetrics({
    earliest,
    latest,
    aggs: {
      aggregations: ['sum("total.in_bytes").as("v")'],
      splitBys: ['input', '__worker_group'],
      cumulative: false,
      timeWindowSeconds,
    },
  });

  const byDate = new Map<number, Map<string, number>>();
  for (const row of res.results) {
    const input = row.input;
    const groupId = row.__worker_group;
    const startSeconds = row.starttime;
    if (typeof input !== 'string' || typeof groupId !== 'string' || typeof startSeconds !== 'number') continue;
    // `input` is always `${type}:${id}` (confirmed elsewhere in this app — `metricsKey`'s own
    // format) — the type is everything before the first colon, real ids never contain one.
    const colonIdx = input.indexOf(':');
    const inputType = colonIdx === -1 ? input : input.slice(0, colonIdx);
    if (LICENSE_EXEMPT_SOURCE_TYPES.has(inputType)) continue;
    const v = Number(row.v ?? 0);
    if (v <= 0) continue;
    const date = startSeconds * 1000;
    let bucket = byDate.get(date);
    if (!bucket) {
      bucket = new Map();
      byDate.set(date, bucket);
    }
    const key = sourceKey(groupId, input);
    bucket.set(key, (bucket.get(key) ?? 0) + v);
  }

  return [...byDate.entries()]
    .map(([date, bySourceKey]) => ({ date, bySourceKey }))
    .sort((a, b) => a.date - b.date);
}
