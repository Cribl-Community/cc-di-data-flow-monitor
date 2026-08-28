import { useMemo } from 'react';
import type { GroupProductFilter, ProductType, TimeRangeOption } from '../../lib/types';
import type { WorkerFleetRow } from '../../lib/workerHealth';
import { formatBytes, formatMetric, formatTimeShort, trimOrgFromHostname } from '../../lib/format';
import './AlertFeedPanel.css';

interface AlertFeedPanelProps {
  rows: WorkerFleetRow[];
  timeRangeId: TimeRangeOption['id'];
  /** Real name + product per real group id — see `OverviewPage.tsx`'s own `groupInfoById`. Every
   *  entry names which real group it's in (a hostname alone doesn't say whether it's a Stream
   *  Worker or an Edge Node), regardless of whether the current scope is single- or
   *  multi-product — unlike the KPI row's own breakdowns, this is always useful here since each
   *  row is one specific, actionable item, not an aggregate count. */
  groupInfoById: Map<string, { name: string; type: ProductType }>;
  /** The top-left toggle's own current product — every row in `rows` already belongs to this same
   *  product (the whole page is scoped through it), so it's what decides the leading two columns'
   *  own header labels ("Fleet"/"Node" for Edge, "Worker Group"/"Worker" for Stream) rather than
   *  re-deriving it from each individual row's own group — matching `FleetRoster.tsx`'s own
   *  identical convention for the same two columns. */
  groupProductFilter: GroupProductFilter;
}

const GROUP_COLUMN_LABEL: Record<GroupProductFilter, string> = {
  stream: 'Worker Group',
  edge: 'Fleet',
};
const NODE_COLUMN_LABEL: Record<GroupProductFilter, string> = {
  stream: 'Worker',
  edge: 'Node',
};

interface AlertEntry {
  id: string;
  severity: 'danger' | 'warning' | 'good';
  hostname: string;
  group: string;
  detail: string;
}

const HEARTBEAT_LAG_WARN_SECONDS = 5;
const LOAD_PCT_WARN = 80;
const MEM_PCT_WARN = 85;
const DISK_PCT_WARN = 85;

function pct(used: number | undefined, total: number | undefined): number | undefined {
  if (used === undefined || total === undefined || total <= 0) return undefined;
  return (used / total) * 100;
}

/**
 * A real composite view of "what's currently wrong," built from actual signals this app has
 * confirmed live — not a fabricated historical event log. Cribl has no dedicated live error/
 * notification feed for worker nodes (`/notifications` is configured alert *rules*, not a feed of
 * what already happened — confirmed live, see CLAUDE.md); every entry here instead reflects a
 * real, currently-true condition (disconnected, backpressure, resource/heartbeat pressure), so
 * this is honestly a **current-state** warning list ordered worst-first, not a strict
 * chronological timeline the underlying data doesn't actually support.
 */
// `timeRangeId` is accepted but not read directly — the "as of" stamp is always "now" (these are
// current-state signals composed from live values, not a backward-looking historical window), but
// the prop is kept on the interface so a future real historical feed could reference it without an
// API change, rather than silently dropping the scope information the caller already has.
export function AlertFeedPanel({ rows, groupInfoById, groupProductFilter }: AlertFeedPanelProps) {
  const entries = useMemo<AlertEntry[]>(() => {
    const out: AlertEntry[] = [];
    for (const w of rows) {
      if (w.disconnected) {
        out.push({ id: `${w.id}:disc`, severity: 'danger', hostname: w.hostname, group: w.group, detail: 'currently disconnected from the Leader' });
        continue;
      }
      if (w.blockedCount > 0) {
        out.push({
          id: `${w.id}:blocked`,
          severity: 'danger',
          hostname: w.hostname,
          group: w.group,
          detail: `experiencing backpressure — ${formatMetric(w.blockedCount, 'events')} blocked this window`,
        });
      }
      if (w.heartbeatLagSeconds !== undefined && w.heartbeatLagSeconds > HEARTBEAT_LAG_WARN_SECONDS) {
        out.push({ id: `${w.id}:hb`, severity: 'warning', hostname: w.hostname, group: w.group, detail: `heartbeat lag ${w.heartbeatLagSeconds.toFixed(1)}s` });
      }
      if (w.loadPct !== undefined && w.loadPct > LOAD_PCT_WARN) {
        out.push({ id: `${w.id}:load`, severity: 'warning', hostname: w.hostname, group: w.group, detail: `load at ${Math.round(w.loadPct)}% of configured cores` });
      }
      const memPct = pct(w.memUsedBytes, w.memTotalBytes);
      if (memPct !== undefined && memPct > MEM_PCT_WARN) {
        out.push({
          id: `${w.id}:mem`,
          severity: 'warning',
          hostname: w.hostname,
          group: w.group,
          detail: `memory at ${Math.round(memPct)}% (${formatBytes(w.memUsedBytes ?? 0)} of ${formatBytes(w.memTotalBytes ?? 0)})`,
        });
      }
      const diskPct = pct(w.diskUsedBytes, w.diskTotalBytes);
      if (diskPct !== undefined && diskPct > DISK_PCT_WARN) {
        out.push({
          id: `${w.id}:disk`,
          severity: 'warning',
          hostname: w.hostname,
          group: w.group,
          detail: `disk at ${Math.round(diskPct)}% (${formatBytes(w.diskUsedBytes ?? 0)} of ${formatBytes(w.diskTotalBytes ?? 0)})`,
        });
      }
    }
    const rank = { danger: 0, warning: 1, good: 2 };
    return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  }, [rows]);

  const asOf = formatTimeShort(Date.now());

  return (
    <div className="ov-panel">
      <div className="ov-panel-head">
        <span className="ov-panel-title">
          Alert Feed <span className="ov-panel-count">({entries.length})</span>
        </span>
        <span className="ov-panel-static-action">as of {asOf}</span>
      </div>
      <div className="ov-panel-body">
        {entries.length === 0 ? (
          <div className="ov-alert-empty">Nothing needs attention in this scope right now.</div>
        ) : (
          <table className="ov-alert-table">
            <thead>
              <tr>
                <th className="ov-th-plain">{GROUP_COLUMN_LABEL[groupProductFilter]}</th>
                <th className="ov-th-plain">{NODE_COLUMN_LABEL[groupProductFilter]}</th>
                <th className="ov-th-plain">Description</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const groupName = groupInfoById.get(e.group)?.name ?? e.group;
                return (
                  <tr key={e.id}>
                    <td className={`ov-mono ov-alert-group-cell ov-alert-group-cell--${e.severity}`} title={groupName}>
                      {groupName}
                    </td>
                    <td className="ov-mono">{trimOrgFromHostname(e.hostname)}</td>
                    <td className="ov-alert-detail">{e.detail}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
