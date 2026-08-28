import { useMemo, useState } from 'react';
import { Text } from '@capra/core';
import { Search, CloseOutlined } from '@capra/icons';
import type { GroupProductFilter, HealthStatus, VolumeUnit } from '../../lib/types';
import { HEALTH_APPEARANCE, HEALTH_RANK } from '../../lib/health';
import { lastSeenHealth, type WorkerFleetRow } from '../../lib/workerHealth';
import { formatMetric, formatRelativeAge, formatUptime, formatTimestamp } from '../../lib/format';
import './FleetRoster.css';

interface FleetRosterProps {
  /** Already filtered by the page's own status-filter selection (the shared top-bar control). */
  rows: WorkerFleetRow[];
  totalCount: number;
  healthByWorkerId: Map<string, HealthStatus>;
  unit: VolumeUnit;
  /** Opens the per-node detail drawer (`WorkerNodeDrawer`) for the clicked row. */
  onSelectRow: (row: WorkerFleetRow) => void;
  /** The top-left toggle's own current product — every row already belongs to this same product,
   *  so it's what decides the leading two column headers' own labels ("Fleet"/"Node" for Edge,
   *  "Worker Group"/"Worker" for Stream) rather than re-deriving it from each individual row. */
  groupProductFilter: GroupProductFilter;
  /** Fired on every change to the free-text search box — the page wires this to a debounced
   *  background refresh, so a text filter always reflects fresh data shortly after typing stops
   *  rather than whatever was loaded when the page first opened. */
  onFilterChange?: () => void;
  /** Real, user-configurable Settings values, already resolved by the page for the current
   *  `groupProductFilter` (`state.cpuPressureWarnPctStream`/`Edge` etc. — see `UtilCell`'s own doc
   *  comment). */
  cpuWarnAt: number;
  memWarnAt: number;
  diskWarnAt: number;
}

const GROUP_COLUMN_LABEL: Record<GroupProductFilter, string> = {
  stream: 'Worker Group',
  edge: 'Fleet',
};
const NODE_COLUMN_LABEL: Record<GroupProductFilter, string> = {
  stream: 'Worker',
  edge: 'Node',
};

type SortKey = 'name' | 'cpu' | 'mem' | 'disk' | 'uptime' | 'volume' | 'blocks';
type SortDir = 'asc' | 'desc';

function pct(used: number | undefined, total: number | undefined): number | undefined {
  if (used === undefined || total === undefined || total <= 0) return undefined;
  return (used / total) * 100;
}

/** `warnAt` is a real, user-configurable Settings preference (`state.cpuPressureWarnPctStream`/
 *  `Edge`, `memPressureWarnPctStream`/`Edge`, `diskPressureWarnPctStream`/`Edge`, `70` by default
 *  for all six — byte-for-byte this cell's own original hardcoded value) for CPU, Memory, and now
 *  Disk alike, each resolved by the page for whichever product is currently in scope. The `danger`
 *  cutoff stays a fixed `85` regardless of `warnAt` — see `UserPreferences.
 *  cpuPressureWarnPctStream`'s own doc comment for why this is deliberately display-only and never
 *  feeds back into `deriveWorkerHealth()`/the Status column's own real color. */
function UtilCell({ value, warnAt = 70 }: { value: number | undefined; warnAt?: number }) {
  if (value === undefined) return <span className="ov-roster-na">n/a</span>;
  const clamped = Math.min(100, value);
  const cls = value >= 85 ? 'danger' : value >= warnAt ? 'warn' : 'ok';
  return (
    <div className="ov-mini-bar-cell">
      <div className="ov-mini-bar-track">
        <div className={`ov-mini-bar-fill ov-mini-bar-fill--${cls}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className="ov-mono">{Math.round(value)}%</span>
    </div>
  );
}

/**
 * One row per node — the leading two columns' own labels switch with the top-left toggle's
 * current product ("Worker Group"/"Worker" for Stream, "Fleet"/"Node" for Edge — `GROUP_COLUMN_
 * LABEL`/`NODE_COLUMN_LABEL` below), matching each product's own real vocabulary rather than
 * always saying "Worker" even when every row is really an Edge Node. CPU (real utilization,
 * computed from two successive `/system/info` polls' own tick counters — see `api/workerInfo.ts`'s
 * `computeCpuPct`; works identically for Stream and Edge, unlike the earlier `system.load_avg`-
 * derived figure the metrics store could never attribute per-node for Edge at all), Mem, Disk,
 * Uptime, Processes (the real `workerProcesses` count Cribl reports for that node), Volume in/out
 * for the selected time range and unit, Blocked count, and Last Seen. Last Seen shows real
 * connectivity — `w.lastMsgTime`, the Leader's own last-received-heartbeat timestamp for that node
 * (`/master/workers`' `lastMsgTime`, confirmed live to work identically for Stream Workers and Edge
 * Nodes) — not Cribl's raw process-level `status` string this column used to show, which stays
 * `"healthy"` straight through real backpressure/degradation and says nothing about whether the
 * node is actually still connected. Per direct instruction, its *color* is driven by that same
 * heartbeat's own staleness (`lastSeenHealth()`, `lib/workerHealth.ts`) rather than
 * `deriveWorkerHealth()`'s blocked-events/backpressure verdict — the latter still backs this
 * table's own default sort, the KPI row's counts, and the shared status filter (`healthByWorkerId`,
 * unaffected by this cell's own color), so a worker experiencing real backpressure still sorts to
 * the top and still counts toward "N need attention" even while its heartbeat itself reads fresh.
 * Each row opens a per-node detail drawer on click (`onSelectRow`) — config-drift check, license,
 * messages, build/OS identity, and a best-effort historical trend.
 */
export function FleetRoster({
  rows,
  totalCount,
  healthByWorkerId,
  unit,
  onSelectRow,
  groupProductFilter,
  onFilterChange,
  cpuWarnAt,
  memWarnAt,
  diskWarnAt,
}: FleetRosterProps) {
  const [search, setSearch] = useState('');
  const setSearchAndRefresh = (value: string) => {
    setSearch(value);
    onFilterChange?.();
  };
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q ? rows.filter((w) => w.hostname.toLowerCase().includes(q) || w.group.toLowerCase().includes(q)) : rows;

    const sign = sortDir === 'asc' ? 1 : -1;
    return [...matched].sort((a, b) => {
      switch (sortKey) {
        case 'cpu':
          return sign * ((a.loadPct ?? -1) - (b.loadPct ?? -1));
        case 'mem':
          return sign * ((pct(a.memUsedBytes, a.memTotalBytes) ?? -1) - (pct(b.memUsedBytes, b.memTotalBytes) ?? -1));
        case 'disk':
          return sign * ((pct(a.diskUsedBytes, a.diskTotalBytes) ?? -1) - (pct(b.diskUsedBytes, b.diskTotalBytes) ?? -1));
        case 'uptime':
          return sign * ((a.uptimeSeconds ?? -1) - (b.uptimeSeconds ?? -1));
        case 'volume':
          return sign * (a.volumeIn + a.volumeOut - (b.volumeIn + b.volumeOut));
        case 'blocks':
          return sign * (a.blockedCount - b.blockedCount);
        case 'name':
        default: {
          // Default direction ('asc') is worst-health-first, not alphabetical — matches Flow
          // Explorer's own default-sort bias, so the roster opens with whatever needs attention
          // at the top rather than requiring a click first.
          const healthA = healthByWorkerId.get(a.id) ?? 'nodata';
          const healthB = healthByWorkerId.get(b.id) ?? 'nodata';
          const rankDiff = (sortDir === 'asc' ? -1 : 1) * (HEALTH_RANK[healthA] - HEALTH_RANK[healthB]);
          if (rankDiff !== 0 && sortKey === 'name') return rankDiff;
          return sign * a.hostname.localeCompare(b.hostname);
        }
      }
    });
  }, [rows, search, sortKey, sortDir, healthByWorkerId]);

  const sortIndicator = (key: SortKey) => (key === sortKey ? (sortDir === 'asc' ? '▲' : '▼') : '');

  return (
    <div className="ov-panel">
      <div className="ov-panel-head">
        <span className="ov-panel-title">
          {NODE_COLUMN_LABEL[groupProductFilter]} Inventory{' '}
          <span className="ov-panel-count">({filtered.length !== totalCount ? `${filtered.length}/${totalCount}` : totalCount})</span>
        </span>
        <div className="ov-roster-search">
          <Search />
          <input
            type="text"
            placeholder={`Filter ${NODE_COLUMN_LABEL[groupProductFilter].toLowerCase()}s…`}
            value={search}
            onChange={(e) => setSearchAndRefresh(e.target.value)}
          />
          {search !== '' && (
            <button type="button" className="ov-roster-search-clear" aria-label="Clear search filter" onClick={() => setSearchAndRefresh('')}>
              <CloseOutlined />
            </button>
          )}
        </div>
      </div>
      <div className="ov-panel-body ov-roster-scroll">
        <table className="ov-roster-table">
          <thead>
            <tr>
              <th className="ov-th-plain">{GROUP_COLUMN_LABEL[groupProductFilter]}</th>
              <th>
                <button type="button" className="ov-sort-btn" onClick={() => toggleSort('name')}>
                  {NODE_COLUMN_LABEL[groupProductFilter]} <span className="ov-sort-indicator">{sortIndicator('name')}</span>
                </button>
              </th>
              <th>
                <button type="button" className="ov-sort-btn" onClick={() => toggleSort('cpu')}>
                  CPU <span className="ov-sort-indicator">{sortIndicator('cpu')}</span>
                </button>
              </th>
              <th>
                <button type="button" className="ov-sort-btn" onClick={() => toggleSort('mem')}>
                  Mem <span className="ov-sort-indicator">{sortIndicator('mem')}</span>
                </button>
              </th>
              <th>
                <button type="button" className="ov-sort-btn" onClick={() => toggleSort('disk')}>
                  Disk <span className="ov-sort-indicator">{sortIndicator('disk')}</span>
                </button>
              </th>
              <th>
                <button type="button" className="ov-sort-btn" onClick={() => toggleSort('uptime')}>
                  Uptime <span className="ov-sort-indicator">{sortIndicator('uptime')}</span>
                </button>
              </th>
              <th className="ov-th-plain">Processes</th>
              <th>
                <button type="button" className="ov-sort-btn" onClick={() => toggleSort('volume')}>
                  Volume (in/out) <span className="ov-sort-indicator">{sortIndicator('volume')}</span>
                </button>
              </th>
              <th>
                <button type="button" className="ov-sort-btn" onClick={() => toggleSort('blocks')}>
                  Blocked <span className="ov-sort-indicator">{sortIndicator('blocks')}</span>
                </button>
              </th>
              <th className="ov-th-plain">Last Seen</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((w) => {
              // Per direct instruction, this cell's own color is now driven by heartbeat
              // staleness (`lastSeenHealth`), not `deriveWorkerHealth`'s blocked-events/
              // backpressure verdict — that verdict (still read via `healthByWorkerId` above) is
              // unaffected and still backs this table's own default sort, the KPI row's counts,
              // and the shared status filter. Works identically for Stream and Edge — both
              // confirmed live to report `lastMsgTime` on their own real heartbeat cadence.
              const statusAppearance = HEALTH_APPEARANCE[lastSeenHealth(w)];
              return (
                <tr
                  key={w.id}
                  className="ov-roster-row"
                  role="button"
                  tabIndex={0}
                  aria-label={`View details for ${w.hostname}`}
                  onClick={() => onSelectRow(w)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectRow(w);
                    }
                  }}
                >
                  <td className="ov-mono ov-roster-group">{w.group}</td>
                  <td className="ov-mono">{w.hostname}</td>
                  <td>
                    <UtilCell value={w.loadPct} warnAt={cpuWarnAt} />
                  </td>
                  <td>
                    <UtilCell value={pct(w.memUsedBytes, w.memTotalBytes)} warnAt={memWarnAt} />
                  </td>
                  <td>
                    <UtilCell value={pct(w.diskUsedBytes, w.diskTotalBytes)} warnAt={diskWarnAt} />
                  </td>
                  <td className="ov-mono">{formatUptime(w.uptimeSeconds)}</td>
                  <td className="ov-mono">{w.workerProcesses}</td>
                  <td className="ov-mono">
                    {formatMetric(w.volumeIn, unit)} / {formatMetric(w.volumeOut, unit)}
                  </td>
                  <td className={`ov-mono ${w.blockedCount > 0 ? 'ov-roster-blocked' : ''}`}>{w.blockedCount}</td>
                  <td
                    className={`ov-roster-status ov-roster-status--${statusAppearance}`}
                    title={w.lastMsgTime !== undefined ? formatTimestamp(w.lastMsgTime) : undefined}
                  >
                    {formatRelativeAge(w.lastMsgTime)}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr className="ov-roster-empty-row">
                <td colSpan={10}>
                  <Text as="span" variant="body-sm-normal" color="subtle">
                    {search.trim()
                      ? `No ${NODE_COLUMN_LABEL[groupProductFilter].toLowerCase()}s match your search.`
                      : `No ${NODE_COLUMN_LABEL[groupProductFilter].toLowerCase()}s match the current status filter.`}
                  </Text>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
