import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLicenseInfo, fetchLicenseUsage, fetchSourceDailyVolume, fetchSourceHourlyVolume, fetchSourceLabels, type LicenseInfo } from '../api/licenses';
import { PermissionError } from '../api/client';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const HOURLY_WINDOW_HOURS = 24;
const TOP_N = 10;
export const OTHER_SOURCE_KEY = '__other__';

function dayIndex(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

interface LicenseDaySegment {
  key: string;
  label: string;
  bytes: number;
}

export interface LicenseDayPoint {
  date: number;
  /** The real *billed* total for this day — always the ground truth for the bar's own height, in
   *  both chart modes. For the daily hook this is `/system/licenses/usage`'s own `inBytes -
   *  exemptedLicenseInBytes`, **not** `inBytes` alone: confirmed live that `inBytes` is a gross
   *  figure that still includes exempt traffic (Datagen, Cribl Internal Sources — see
   *  `LICENSE_EXEMPT_SOURCE_TYPES`), and in a Datagen-heavy org that gross figure can overstate the
   *  real bill by two orders of magnitude. For the hourly hook there's no equivalent authoritative
   *  split, but it doesn't need one — `fetchSourceHourlyVolume` already excludes exempt Sources at
   *  the query level, so its own breakdown sum is the billed total already. */
  totalBytes: number;
  overQuota: boolean;
  /** Present only when real per-source breakdown data exists for this day — rescaled so the
   *  segments always sum to exactly `totalBytes` (the metrics-store sum and the license-usage
   *  total are two different measurement systems and can disagree slightly on their own; the
   *  license-usage figure is the one that's actually counted against quota, so it wins). Ordered
   *  `topSourceKeys` first, `OTHER_SOURCE_KEY` last. `undefined` means this day's real total (still
   *  shown) has no real per-source data available to attribute it to — see
   *  `fetchSourceDailyVolume`'s own doc comment on why that's a real, expected gap in some
   *  environments, not a bug. */
  segments?: LicenseDaySegment[];
}

export interface UseLicenseConsumptionResult {
  status: 'loading' | 'ready' | 'error' | 'unavailable';
  error?: string;
  isPermissionError: boolean;
  license?: LicenseInfo;
  /** Exactly the requested day range, oldest first — may be shorter than requested if the org's
   *  own real usage history is shorter (never padded with fabricated days). */
  days: LicenseDayPoint[];
  /** Ranked by real total bytes across every day that has breakdown data in this range — a fixed
   *  order, so a given Source keeps the same legend color across every day of the chart rather
   *  than being independently top-10'd per day. */
  topSourceKeys: string[];
  /** True if at least one day's segments include a non-empty `OTHER_SOURCE_KEY` entry. */
  hasOtherSources: boolean;
  sourceLabel: (key: string) => string;
  todayBytes: number;
  avgBytes: number;
  daysOverQuota: number;
  refresh: () => void;
}

const EMPTY: Omit<UseLicenseConsumptionResult, 'refresh' | 'sourceLabel'> = {
  status: 'loading',
  isPermissionError: false,
  days: [],
  topSourceKeys: [],
  hasOtherSources: false,
  todayBytes: 0,
  avgBytes: 0,
  daysOverQuota: 0,
};

/**
 * Ingest-based license entitlement + real daily usage history, for the License Usage
 * page. Org-wide — this endpoint family has no Worker Group scoping at all (see `api/licenses.ts`'s
 * own doc comment), so unlike every other page's data hook, this one takes no `groupId`.
 *
 * The day-range total always comes from `/system/licenses/usage` — specifically `inBytes -
 * exemptedLicenseInBytes`, the real *billed* figure, not the gross `inBytes` alone (see
 * `LicenseDayPoint.totalBytes`'s own doc comment for why that distinction is a real, confirmed-live
 * bug fix and not pedantry — in a Datagen-heavy org `inBytes` alone can overstate the real bill by
 * two orders of magnitude). The per-source breakdown (`fetchSourceDailyVolume`, a `total.in_bytes`
 * metrics-store query, already filtered to billable connector types only) only ever *redistributes*
 * that same real billed total across Sources for whichever days it actually has data for; it never
 * substitutes its own sum, since the two are different measurement systems that can disagree
 * slightly on their own.
 */
export function useLicenseConsumption(days: number): UseLicenseConsumptionResult {
  const [state, setState] = useState<Omit<UseLicenseConsumptionResult, 'refresh' | 'sourceLabel'>>(EMPTY);
  const labelsRef = useRef<Map<string, string>>(new Map());
  const [nonce, setNonce] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    const myRequestId = ++requestId.current;
    setState((prev) => ({ ...prev, status: 'loading', error: undefined, isPermissionError: false }));

    const latest = Date.now();
    const earliest = latest - days * DAY_MS;

    Promise.all([
      fetchLicenseInfo(),
      fetchLicenseUsage(),
      fetchSourceDailyVolume({ earliest, latest }).catch(() => []),
      fetchSourceLabels().catch(() => new Map<string, string>()),
    ])
      .then(([license, usage, breakdown, labels]) => {
        if (myRequestId !== requestId.current) return;
        labelsRef.current = labels;

        if (!license) {
          setState({ ...EMPTY, status: 'unavailable' });
          return;
        }

        const recentUsage = usage.filter((u) => u.date >= earliest - DAY_MS).slice(-days);

        const breakdownByDay = new Map<number, Map<string, number>>();
        for (const b of breakdown) breakdownByDay.set(dayIndex(b.date), b.bySourceKey);

        const totalsByKey = new Map<string, number>();
        for (const b of breakdown) {
          for (const [key, bytes] of b.bySourceKey) totalsByKey.set(key, (totalsByKey.get(key) ?? 0) + bytes);
        }
        const topSourceKeys = [...totalsByKey.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, TOP_N)
          .map(([key]) => key);
        const topSet = new Set(topSourceKeys);

        let hasOtherSources = false;
        const dayPoints: LicenseDayPoint[] = recentUsage.map((u) => {
          // The real billed total — `inBytes` alone is a gross figure that still includes exempt
          // (Datagen/Cribl-internal) traffic; `exemptedLicenseInBytes` is Cribl's own real count of
          // how much of that gross figure doesn't actually count. Clamped to zero defensively
          // (should never go negative for real data, but a negative bar height would be worse than
          // a floor at zero if it ever did).
          const billedBytes = Math.max(0, u.inBytes - u.exemptedLicenseInBytes);
          const bySource = breakdownByDay.get(dayIndex(u.date));
          let segments: LicenseDaySegment[] | undefined;
          if (bySource && bySource.size > 0) {
            // `bySource` only ever contains billable Sources already (`fetchSourceDailyVolume`
            // filters exempt connector types out at the query level) — rescaling its own sum to
            // match `billedBytes` (not the old gross `inBytes`) keeps this the same "two different
            // measurement systems, the authoritative one wins" reconciliation this always did, just
            // pointed at the corrected authoritative figure.
            const breakdownSum = [...bySource.values()].reduce((a, b) => a + b, 0);
            const scale = breakdownSum > 0 ? billedBytes / breakdownSum : 0;
            const segs: LicenseDaySegment[] = topSourceKeys.map((key) => ({
              key,
              label: labels.get(key) ?? key,
              bytes: (bySource.get(key) ?? 0) * scale,
            }));
            let otherRaw = 0;
            for (const [key, raw] of bySource) {
              if (!topSet.has(key)) otherRaw += raw;
            }
            if (otherRaw > 0) {
              segs.push({ key: OTHER_SOURCE_KEY, label: 'Other sources', bytes: otherRaw * scale });
              hasOtherSources = true;
            }
            segments = segs;
          }
          return {
            date: u.date,
            totalBytes: billedBytes,
            overQuota: license.quotaBytes > 0 && billedBytes > license.quotaBytes,
            segments,
          };
        });

        const todayBytes = dayPoints[dayPoints.length - 1]?.totalBytes ?? 0;
        const avgBytes = dayPoints.length > 0 ? dayPoints.reduce((sum, d) => sum + d.totalBytes, 0) / dayPoints.length : 0;
        const daysOverQuota = dayPoints.filter((d) => d.overQuota).length;

        setState({
          status: 'ready',
          license,
          days: dayPoints,
          topSourceKeys,
          hasOtherSources,
          todayBytes,
          avgBytes,
          daysOverQuota,
          isPermissionError: false,
        });
      })
      .catch((err: unknown) => {
        if (myRequestId !== requestId.current) return;
        setState({ ...EMPTY, status: 'error', error: err instanceof Error ? err.message : String(err), isPermissionError: err instanceof PermissionError });
      });
  }, [days, nonce]);

  // Stable across renders (matching `useFlowGraph`'s own identical `refresh`) — this page has no
  // auto-refresh interval today, but keeping this memoized costs nothing and avoids the same
  // stale-closure trap if one's ever added.
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return {
    ...state,
    sourceLabel: (key: string) => (key === OTHER_SOURCE_KEY ? 'Other sources' : (labelsRef.current.get(key) ?? key)),
    refresh,
  };
}

export interface UseLicenseHourlyIngestResult {
  status: 'loading' | 'ready' | 'error' | 'unavailable';
  error?: string;
  isPermissionError: boolean;
  license?: LicenseInfo;
  /** One real point per hour that had any real ingest in the trailing 24 hours — an hour with
   *  genuinely zero volume is simply absent (there's no authoritative "every hour, even zero"
   *  source the way `/system/licenses/usage` gives the daily case), oldest first. */
  hours: LicenseDayPoint[];
  topSourceKeys: string[];
  hasOtherSources: boolean;
  sourceLabel: (key: string) => string;
  refresh: () => void;
}

const HOURLY_EMPTY: Omit<UseLicenseHourlyIngestResult, 'refresh' | 'sourceLabel'> = {
  status: 'loading',
  isPermissionError: false,
  hours: [],
  topSourceKeys: [],
  hasOtherSources: false,
};

/**
 * Real hourly ingest for the trailing 24 hours, by Source — the Daily Ingest chart's 24h
 * alternative to `useLicenseConsumption`'s own 30-day view above. No hourly equivalent of
 * `/system/licenses/usage` exists (confirmed live — that endpoint is inherently day-bucketed), so
 * unlike the daily hook, there's no separate license-authoritative total to reconcile the
 * metrics-store's own breakdown against: each hour's own bar total *is* the real, directly-measured
 * `total.in_bytes` sum for that hour, and every segment is that same real figure — no rescaling
 * needed, since there's nothing more authoritative to rescale toward. This is already the *billed*
 * total, not a gross one, with no extra step needed here to make it so — `fetchSourceHourlyVolume`
 * excludes exempt (Datagen/Cribl-internal) connector types at the query level, so summing what it
 * returns already sums only billable Sources. `overQuota` is always `false` on every point here — a
 * real Cribl license quota is inherently a daily concept, so there's no honest per-hour threshold to
 * compare one hour's own volume against.
 *
 * `enabled` (default `true`) gates the real fetch — `false` skips it entirely, leaving `hours`
 * empty and `status` at its initial `'loading'` rather than ever resolving. `DailyIngestPanel`
 * passes `false` until the reader actually switches to the 24h view, so this org-wide fetch only
 * ever fires for someone who asked for it, not on every Overview load regardless of which range is
 * showing.
 */
export function useLicenseHourlyIngest(enabled = true): UseLicenseHourlyIngestResult {
  const [state, setState] = useState<Omit<UseLicenseHourlyIngestResult, 'refresh' | 'sourceLabel'>>(HOURLY_EMPTY);
  const labelsRef = useRef<Map<string, string>>(new Map());
  const [nonce, setNonce] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const myRequestId = ++requestId.current;
    setState((prev) => ({ ...prev, status: 'loading', error: undefined, isPermissionError: false }));

    const latest = Date.now();
    const earliest = latest - HOURLY_WINDOW_HOURS * HOUR_MS;

    Promise.all([fetchLicenseInfo(), fetchSourceHourlyVolume({ earliest, latest }).catch(() => []), fetchSourceLabels().catch(() => new Map<string, string>())])
      .then(([license, breakdown, labels]) => {
        if (myRequestId !== requestId.current) return;
        labelsRef.current = labels;

        if (!license) {
          setState({ ...HOURLY_EMPTY, status: 'unavailable' });
          return;
        }

        const totalsByKey = new Map<string, number>();
        for (const b of breakdown) {
          for (const [key, bytes] of b.bySourceKey) totalsByKey.set(key, (totalsByKey.get(key) ?? 0) + bytes);
        }
        const topSourceKeys = [...totalsByKey.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, TOP_N)
          .map(([key]) => key);
        const topSet = new Set(topSourceKeys);

        let hasOtherSources = false;
        const hours: LicenseDayPoint[] = breakdown.map((b) => {
          const totalBytes = [...b.bySourceKey.values()].reduce((a, v) => a + v, 0);
          const segs: LicenseDaySegment[] = topSourceKeys.map((key) => ({ key, label: labels.get(key) ?? key, bytes: b.bySourceKey.get(key) ?? 0 }));
          let otherRaw = 0;
          for (const [key, raw] of b.bySourceKey) {
            if (!topSet.has(key)) otherRaw += raw;
          }
          if (otherRaw > 0) {
            segs.push({ key: OTHER_SOURCE_KEY, label: 'Other sources', bytes: otherRaw });
            hasOtherSources = true;
          }
          return { date: b.date, totalBytes, overQuota: false, segments: segs };
        });

        setState({ status: 'ready', license, hours, topSourceKeys, hasOtherSources, isPermissionError: false });
      })
      .catch((err: unknown) => {
        if (myRequestId !== requestId.current) return;
        setState({ ...HOURLY_EMPTY, status: 'error', error: err instanceof Error ? err.message : String(err), isPermissionError: err instanceof PermissionError });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fixed 24h window, only `nonce`/`enabled` re-trigger a real refetch.
  }, [nonce, enabled]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return {
    ...state,
    sourceLabel: (key: string) => (key === OTHER_SOURCE_KEY ? 'Other sources' : (labelsRef.current.get(key) ?? key)),
    refresh,
  };
}
