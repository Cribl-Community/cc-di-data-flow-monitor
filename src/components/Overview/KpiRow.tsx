import { useMemo } from 'react';
import { Text, Tooltip } from '@capra/core';
import { WorkersOutlined, NodesOutlined, ChartColumn, ArrowTrendUp, ArrowTrendDown, ArrowUpRightFromSquare, Sources, Destinations } from '@capra/icons';
import type { HealthStatus, FlowGraph, TimeRangeOption, VolumeUnit, ProductType, GroupProductFilter } from '../../lib/types';
import { TIME_RANGE_OPTIONS } from '../../lib/types';
import type { WorkerFleetRow } from '../../lib/workerHealth';
import type { LicenseInfo } from '../../api/licenses';
import { formatMetric } from '../../lib/format';
import { sumUniqueSourceIn } from '../../lib/topology';
import { matchesStatusFilter } from '../../lib/health';
import { criblWorkerGroupsListPath, criblWorkersListPath } from '../../lib/criblLinks';
import { ReductionValue } from '../ReductionValue';
import { LicenseKpiCard } from './LicenseKpiCard';
import './KpiRow.css';

/** Real Cribl deep links (not this app's own router) always open in a new tab — per AGENTS.md's
 *  own navigation guidance, already how NodeCard's "Open in Cribl" redirect icon behaves. */
function openInCribl(path: string): void {
  window.open(path, '_blank', 'noopener,noreferrer');
}

interface KpiRowProps {
  rows: WorkerFleetRow[];
  healthByWorkerId: Map<string, HealthStatus>;
  groupCount: number;
  groupIds: string[];
  /** Real name per real group id, scoped to whatever's actually selectable — see
   *  `OverviewPage.tsx`'s own `groupInfoById`. Used to list the selected group(s) by name under
   *  the Worker Groups/Fleets card. */
  groupInfoById: Map<string, { name: string; type: ProductType }>;
  /** The top-left toggle's own current product — decides whether the "Worker Groups"/"Workers"
   *  cards read that way or "Fleets"/"Nodes" instead. "Worker Groups"/"Workers" is genuinely
   *  misleading terminology once the scope is Edge Fleets/Nodes, the same reasoning already
   *  established for these two labels everywhere else they appear (`FleetRoster.tsx`,
   *  `AlertFeedPanel.tsx`). */
  groupProductFilter: GroupProductFilter;
  unit: VolumeUnit;
  flowGraph: FlowGraph | undefined;
  flowStatus: 'idle' | 'loading' | 'ready' | 'error';
  timeRangeId: TimeRangeOption['id'];
  /** Pivot: Overview -> Flow Explorer, scoped to the same Worker Group already selected. */
  onViewFlows: () => void;
  /** The org's own ingest-based license entitlement (`useLicenseConsumption(30)`, a fixed 30-day
   *  window independent of whatever range the License page's own picker happens to be set to) —
   *  feeds the 8th card, `LicenseKpiCard`. `undefined` while loading or if the org has none. */
  license: LicenseInfo | undefined;
  licenseDaysOverQuota: number;
  licenseLoading: boolean;
}

function Kpi({
  label,
  icon,
  value,
  sub,
  tone = 'accent',
  onClick,
  onClickLabel,
}: {
  label: string;
  icon: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'accent' | 'success' | 'neutral';
  /** A card with this set renders as a real `<button>` (not a plain `div`) and gets a small
   *  redirect-glyph affordance — "what's interactive should look interactive," not just clickable
   *  by accident. Two different destinations share this one prop: Active Flows/Reduction/Volume
   *  In/Volume Out all pivot *within* the app to Flow Explorer (all four are counted/summed from
   *  the same `graph.flowSummaries`, via the identical `onViewFlows` handler); Worker Groups/
   *  Workers open a *real* Cribl deep link in a new tab instead (`openInCribl`, at the bottom of
   *  this file). Both read identically here — the icon's own "this leaves for the current view"
   *  meaning is accurate either way — matching the same `ArrowUpRightFromSquare` glyph Signal
   *  Path's own NodeCard uses for its "Open in Cribl" redirect icon (the external case here is
   *  the exact same real action, just triggered from a KPI card instead of a node card), so every
   *  "this leaves" affordance in this app reads as one visual language rather than several. Unlike
   *  NodeCard's own version, this one is a plain decorative icon, not a nested `IconButton` — the
   *  whole card here already *is* the button, and a second real control inside it would reproduce
   *  the exact nested-interactive accessibility bug an earlier round fixed on NodeCard. */
  onClick?: () => void;
  /** Required alongside `onClick` — becomes the button's accessible name once the visible text
   *  affordance is replaced by an icon-only glyph. */
  onClickLabel?: string;
}) {
  const Wrapper = onClick ? 'button' : 'div';
  const card = (
    <Wrapper
      className={onClick ? 'ov-kpi ov-kpi--clickable' : 'ov-kpi'}
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-label={onClick ? onClickLabel : undefined}
    >
      <div className="ov-kpi-top">
        <span className="ov-kpi-label">{label}</span>
        <span className={`ov-kpi-icon ov-kpi-icon--${tone}`}>{icon}</span>
      </div>
      <Text as="span" variant="metric-sm" FORCE__className="ov-kpi-value">
        {value}
      </Text>
      <div className="ov-kpi-sub-row">
        {sub && <span className="ov-kpi-sub">{sub}</span>}
        {onClick && (
          <span className="ov-kpi-pivot" aria-hidden="true">
            <ArrowUpRightFromSquare />
          </span>
        )}
      </div>
    </Wrapper>
  );
  return onClick ? (
    <Tooltip title={onClickLabel ?? label} placement="top">
      {card}
    </Tooltip>
  ) : (
    card
  );
}

/**
 * Nine scope-wide stats, full width. The last eight are scoped to exactly what the top bar's
 * Worker Group select currently has selected (one group, or every group of the current product
 * under "All Worker Groups"/"All Fleets"), the same shared `state.selectedGroupId` every other
 * page already reads. "Active Flows" means a `FlowSummary` row with real observed volume in the
 * selected window (`graph.flowSummaries` itself never contains a synthetic zero-volume row —
 * that's a Flow-Explorer-only client-side addition on top of the same shared graph). Reduction is
 * computed from summed in/out across every active flow (matching how Flow Explorer's own toolbar
 * chicklet computes it), not an average of each flow's own percentage, which would be a different
 * and less correct number. "Total Sources"/"Total Destinations" count every real, configured node
 * of that kind regardless of current traffic (the same "every configured component gets a node"
 * convention `buildFlowGraph` already uses everywhere else) — "active"/"unhealthy" reuse the exact
 * shared `matchesStatusFilter` vocabulary the top-bar status filter itself uses, so they're not
 * mutually exclusive (a Destination can be both real-volume *and* genuinely blocked at once).
 *
 * The 1st, leftmost card (`LicenseKpiCard`) is a deliberate exception to that Worker-Group scoping
 * — the license API family is org-wide with no Worker Group parameter at all, so it's unaffected
 * by whatever the top bar's group select is currently set to.
 */
const GROUP_CARD_LABEL: Record<GroupProductFilter, string> = { stream: 'Worker Groups', edge: 'Fleets' };
const NODE_CARD_LABEL: Record<GroupProductFilter, string> = { stream: 'Workers', edge: 'Nodes' };

export function KpiRow({
  rows,
  healthByWorkerId,
  groupCount,
  groupIds,
  groupInfoById,
  groupProductFilter,
  unit,
  flowGraph,
  flowStatus,
  timeRangeId,
  onViewFlows,
  license,
  licenseDaysOverQuota,
  licenseLoading,
}: KpiRowProps) {
  const healthyCount = rows.filter((w) => healthByWorkerId.get(w.id) === 'good' || healthByWorkerId.get(w.id) === 'nodata').length;
  const attentionCount = rows.length - healthyCount;

  const { flowCount, inSum, outSum } = useMemo(() => {
    if (!flowGraph) return { flowCount: 0, inSum: 0, outSum: 0 };
    // IN is summed once per distinct Source (`sumUniqueSourceIn`), not once per `FlowSummary`
    // row — a Source fanning out to more than one Destination is several rows, and naively
    // summing `inEvents`/`inBytes` across them double-counts the same physical ingest. OUT has
    // no equivalent concern: each row's own `outEvents`/`outBytes` is a distinct, real delivery.
    const nodesById = new Map(flowGraph.nodes.map((n) => [n.id, n]));
    const inSum = sumUniqueSourceIn(flowGraph.flowSummaries, nodesById, unit);
    let outSum = 0;
    for (const s of flowGraph.flowSummaries) {
      outSum += unit === 'bytes' ? s.outBytes : s.outEvents;
    }
    return { flowCount: flowGraph.flowSummaries.length, inSum, outSum };
  }, [flowGraph, unit]);

  // Every real, configured Source/Destination node in scope — not volume-gated, the same "every
  // configured component gets a node regardless of current traffic" convention `buildFlowGraph`
  // already uses everywhere else. "Active" and "Unhealthy" are the same shared vocabulary the
  // top-bar status filter itself uses (`matchesStatusFilter`) — not mutually exclusive (a Destination
  // can be both: real volume *and* genuinely blocked), the same relationship "Active"/"Blocked" have
  // as real status-filter buttons elsewhere in this app. An Output Router is its own distinct kind,
  // not counted as a Destination here — it's a routing construct, not itself a real endpoint.
  const { sourceTotal, sourceActive, sourceUnhealthy, destTotal, destActive, destUnhealthy } = useMemo(() => {
    let sourceTotal = 0;
    let sourceActive = 0;
    let sourceUnhealthy = 0;
    let destTotal = 0;
    let destActive = 0;
    let destUnhealthy = 0;
    for (const n of flowGraph?.nodes ?? []) {
      if (n.kind === 'source') {
        sourceTotal += 1;
        if (matchesStatusFilter(n.health, 'active')) sourceActive += 1;
        if (matchesStatusFilter(n.health, 'unhealthy')) sourceUnhealthy += 1;
      } else if (n.kind === 'destination') {
        destTotal += 1;
        if (matchesStatusFilter(n.health, 'active')) destActive += 1;
        if (matchesStatusFilter(n.health, 'unhealthy')) destUnhealthy += 1;
      }
    }
    return { sourceTotal, sourceActive, sourceUnhealthy, destTotal, destActive, destUnhealthy };
  }, [flowGraph]);

  const groupNames = groupIds.map((id) => groupInfoById.get(id)?.name ?? id);

  const timeRangeLabel = TIME_RANGE_OPTIONS.find((t) => t.id === timeRangeId)?.label ?? '';
  const flowsLoading = flowStatus === 'loading' || flowStatus === 'idle';

  return (
    <div className="overview-kpi-row">
      <LicenseKpiCard license={license} daysOverQuota={licenseDaysOverQuota} loading={licenseLoading} />
      <Kpi
        label={GROUP_CARD_LABEL[groupProductFilter]}
        icon={<NodesOutlined />}
        value={groupCount}
        sub={groupNames.length > 0 ? groupNames.join(', ') : undefined}
        onClick={() => openInCribl(criblWorkerGroupsListPath())}
        onClickLabel={`View ${GROUP_CARD_LABEL[groupProductFilter]} in Cribl`}
      />
      <Kpi
        label={NODE_CARD_LABEL[groupProductFilter]}
        icon={<WorkersOutlined />}
        value={rows.length}
        sub={
          <>
            <b>{healthyCount}</b> healthy · <b>{attentionCount}</b> need attention
          </>
        }
        onClick={() => openInCribl(criblWorkersListPath())}
        onClickLabel={`View ${NODE_CARD_LABEL[groupProductFilter]} in Cribl`}
      />
      <Kpi
        label="Total Sources"
        icon={<Sources />}
        value={flowsLoading ? '—' : sourceTotal}
        sub={
          <>
            <b>{sourceActive}</b> active · <b>{sourceUnhealthy}</b> unhealthy
          </>
        }
      />
      <Kpi
        label="Total Destinations"
        icon={<Destinations />}
        value={flowsLoading ? '—' : destTotal}
        sub={
          <>
            <b>{destActive}</b> active · <b>{destUnhealthy}</b> unhealthy
          </>
        }
      />
      <Kpi
        label="Active Flows"
        icon={<ChartColumn />}
        value={flowsLoading ? '—' : flowCount}
        sub="with volume this window"
        onClick={onViewFlows}
        onClickLabel="View Active Flows in Flow Explorer"
      />
      <Kpi
        label="Volume In"
        icon={<ArrowTrendDown />}
        tone="success"
        value={flowsLoading ? '—' : formatMetric(inSum, unit)}
        sub={timeRangeLabel}
        onClick={onViewFlows}
        onClickLabel="View Active Flows in Flow Explorer"
      />
      <Kpi
        label="Volume Out"
        icon={<ArrowTrendUp />}
        value={flowsLoading ? '—' : formatMetric(outSum, unit)}
        sub={timeRangeLabel}
        onClick={onViewFlows}
        onClickLabel="View Active Flows in Flow Explorer"
      />
      <Kpi
        label="Reduction"
        icon={<ArrowTrendDown />}
        tone="neutral"
        value={flowsLoading ? '—' : <ReductionValue inValue={inSum} outValue={outSum} size="lg" />}
        sub="across active flows"
        onClick={onViewFlows}
        onClickLabel="View Active Flows in Flow Explorer"
      />
    </div>
  );
}
