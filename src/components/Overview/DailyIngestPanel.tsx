import { useState } from 'react';
import { Tooltip, CustomTooltipTrigger } from '@capra/core';
import { InfoOutlined } from '@capra/icons';
import type { LicenseInfo } from '../../api/licenses';
import { type LicenseDayPoint, useLicenseHourlyIngest } from '../../hooks/useLicenseConsumption';
import { LicenseUsageChart } from '../License/LicenseUsageChart';
import './DailyIngestPanel.css';

type IngestRange = '30d' | '24h';
const RANGE_OPTIONS: { id: IngestRange; label: string }[] = [
  { id: '24h', label: '24h' },
  { id: '30d', label: '30d' },
];

interface DailyIngestPanelProps {
  status: 'loading' | 'ready' | 'error' | 'unavailable';
  license: LicenseInfo | undefined;
  days: LicenseDayPoint[];
  topSourceKeys: string[];
  hasOtherSources: boolean;
  sourceLabel: (key: string) => string;
}

/**
 * Replaces the old Top Source Volume Trends panel in the same grid slot — a direct reuse of the
 * shared `LicenseUsageChart` (by-source-stacked bars, no quota reference line), wrapped in
 * Overview's own shared `.ov-panel` shell so it reads as one consistent panel with its siblings in
 * this grid. The 30-day view is fed by `OverviewPage.tsx`'s own `useLicenseConsumption(30)` call
 * (unchanged — org-wide, no Worker Group scoping, same as the KPI row's own License card); the 24h
 * view is a second, independent data path owned entirely by this component (`useLicenseHourlyIngest`,
 * real hourly buckets — there's no hourly equivalent of the daily-only `/system/licenses/usage`
 * endpoint the 30-day view relies on for its own authoritative total). Defaults to 30d; the 24h
 * fetch only ever fires once the reader actually switches to it (`useLicenseHourlyIngest`'s own
 * `enabled` gate), not on every Overview load regardless of which range is showing.
 */
export function DailyIngestPanel({ status, license, days, topSourceKeys, hasOtherSources, sourceLabel }: DailyIngestPanelProps) {
  const [range, setRange] = useState<IngestRange>('30d');
  const hourly = useLicenseHourlyIngest(range === '24h');

  const activeStatus = range === '24h' ? hourly.status : status;
  const activeLicense = range === '24h' ? hourly.license : license;
  const activePoints = range === '24h' ? hourly.hours : days;
  const activeTopSourceKeys = range === '24h' ? hourly.topSourceKeys : topSourceKeys;
  const activeHasOtherSources = range === '24h' ? hourly.hasOtherSources : hasOtherSources;
  const activeSourceLabel = range === '24h' ? hourly.sourceLabel : sourceLabel;

  return (
    <div className="ov-panel">
      <div className="ov-panel-head">
        <span className="ov-panel-title">
          Daily Ingest
          <Tooltip
            title="Per-source historical distribution availability is limited. Older data is displayed as aggregate ingest."
            placement="top"
          >
            <CustomTooltipTrigger>
              <button type="button" className="ov-info-icon" aria-label="About per-source data availability">
                <InfoOutlined />
              </button>
            </CustomTooltipTrigger>
          </Tooltip>
        </span>
        <div className="segmented ov-ingest-range" role="group" aria-label="Ingest chart range">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={range === opt.id ? 'active' : ''}
              aria-pressed={range === opt.id}
              onClick={() => setRange(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className="ov-panel-body ov-ingest-body">
        {activeStatus === 'loading' && !activeLicense && <div className="ov-ingest-empty">Loading {range === '24h' ? 'hourly' : 'daily'} ingest…</div>}
        {activeStatus === 'error' && <div className="ov-ingest-empty">Could not load license usage data.</div>}
        {activeStatus === 'unavailable' && <div className="ov-ingest-empty">No ingest-based license found for this org.</div>}
        {activeLicense && (
          <LicenseUsageChart
            dayPoints={activePoints}
            topSourceKeys={activeTopSourceKeys}
            hasOtherSources={activeHasOtherSources}
            sourceLabel={activeSourceLabel}
            granularity={range === '24h' ? 'hour' : 'day'}
          />
        )}
      </div>
    </div>
  );
}
