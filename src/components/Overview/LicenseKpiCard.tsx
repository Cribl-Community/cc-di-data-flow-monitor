import { Gauge } from '@capra/icons';
import type { LicenseInfo } from '../../api/licenses';
import { expiryTone } from '../../lib/licenseExpiry';
import { formatDateLong } from '../../lib/format';

interface LicenseKpiCardProps {
  license: LicenseInfo | undefined;
  /** Always the trailing 30 days specifically, per explicit direction — independent of any other
   *  range selection elsewhere in the app, so this reads `useLicenseConsumption(30)`'s own
   *  dedicated fetch. */
  daysOverQuota: number;
  loading: boolean;
}

/**
 * License/Expires summary, rendered as the 8th card in Overview's own KPI row, sharing its
 * `.ov-kpi` shell/typography with the other 7. The daily license limit and the expiry date share a
 * single value line rather than each getting their own — the card only has room for 3 content
 * lines (label row, one value line, one sub line) before it grows taller than its siblings:
 * `{quota} GB/day (Expires {date})`, with just the parenthesized expiry portion carrying the
 * green/orange/red urgency coloring `expiryTone()` establishes (the limit figure itself stays the
 * card's plain default text color — only the expiry status is a "status" here).
 */
export function LicenseKpiCard({ license, daysOverQuota, loading }: LicenseKpiCardProps) {
  const tone = license?.expiresAt !== undefined ? expiryTone(license.expiresAt) : undefined;

  return (
    <div className="ov-kpi">
      <div className="ov-kpi-top">
        <span className="ov-kpi-label">License</span>
        <span className="ov-kpi-icon ov-kpi-icon--accent">
          <Gauge />
        </span>
      </div>
      {loading ? (
        <span className="ov-kpi-license-value">—</span>
      ) : license ? (
        <span
          className="ov-kpi-license-value"
          title={`${license.quotaGb.toLocaleString()} GB/day${license.expiresAt !== undefined ? ` (Expires ${formatDateLong(license.expiresAt)})` : ''}`}
        >
          {license.quotaGb.toLocaleString()} GB/day
          {license.expiresAt !== undefined && (
            <span className={`ov-kpi-license-expiry-inline${tone ? ` ov-kpi-license-expiry-inline--${tone}` : ''}`}>
              {' '}
              (Expires {formatDateLong(license.expiresAt)})
            </span>
          )}
        </span>
      ) : (
        <span className="ov-kpi-license-value">No ingest-based license</span>
      )}
      <div className="ov-kpi-sub-row">
        <span className="ov-kpi-sub">
          {loading ? (
            '—'
          ) : license ? (
            <>
              <b>{daysOverQuota}</b> day{daysOverQuota === 1 ? '' : 's'} over quota (past 30 days)
            </>
          ) : (
            '—'
          )}
        </span>
      </div>
    </div>
  );
}
