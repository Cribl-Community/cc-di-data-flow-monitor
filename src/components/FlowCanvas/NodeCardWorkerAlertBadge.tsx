import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatBytes, formatMetric } from '../../lib/format';
import { WORKER_HEALTH_APPEARANCE, type WorkerStatusRow } from '../../api/workers';
import { HEALTH_APPEARANCE, HEALTH_LABEL } from '../../lib/health';
import { WORKER_NOUN, WORKER_NOUN_PLURAL } from '../../lib/productTerms';
import type { GroupProductFilter } from '../../lib/types';
import { clampFloatingPanelToViewport } from '../../lib/floatingPanel';
import { explainWorkerRows, healthFromWorkerRows } from '../../hooks/useWorkerStatus';
import '../WorkerAlertBadge.css';

/**
 * Node card's own worker-alert badge — same markup/CSS classes as the shared `WorkerAlertBadge`
 * (reusing `WorkerAlertBadge.css` directly) and the identical hover/focus/portal-panel mechanics,
 * kept as its own component since it's driven by this page's own `useWorkerStatus` data shape
 * rather than `hooks/useDestinationWorkerAlerts.ts`'s `workerAlertSeverity`.
 */
export function NodeCardWorkerAlertBadge({ rows, product = 'stream' }: { rows: WorkerStatusRow[] | undefined; product?: GroupProductFilter }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | undefined>(undefined);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const panelId = useId();

  const hideNow = () => setOpen(false);

  // Checks and corrects all four viewport edges in one pass — not just the right edge, so a badge
  // near the bottom or left of the window doesn't open a panel that runs off-screen there either.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const button = buttonRef.current;
    if (!panel || !button) return;
    const panelRect = panel.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    setPosition((prev) => (prev ? clampFloatingPanelToViewport(panelRect, prev, buttonRect) : prev));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', hideNow, true);
    window.addEventListener('resize', hideNow);
    return () => {
      window.removeEventListener('scroll', hideNow, true);
      window.removeEventListener('resize', hideNow);
    };
  }, [open]);

  const blockedRows = (rows ?? []).filter((r) => r.health === 'Red' || r.health === 'Yellow');
  if (blockedRows.length === 0) return null;
  const showDestinationColumn = (rows ?? []).some((r) => r.destinationLabel !== undefined);
  const why = explainWorkerRows(rows, product);
  // Same real status word/color the drawer's own Why box uses (`NodeDetailPanel.tsx`) — this badge
  // only ever renders once `blockedRows.length > 0` above, so `health` here is always genuinely
  // `blocked` or `degraded`, never `good`/`nodata`.
  const health = healthFromWorkerRows(rows);
  const summaryAppearance = HEALTH_APPEARANCE[health];

  const show = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 4, left: rect.left });
    setOpen(true);
  };
  const scheduleHide = () => {
    hideTimer.current = setTimeout(() => setOpen(false), 200);
  };

  const nodeNoun = (blockedRows.length === 1 ? WORKER_NOUN[product] : WORKER_NOUN_PLURAL[product]).toLowerCase();
  const label = `Blocked or degraded on ${blockedRows.length} ${nodeNoun} — press Enter for details`;

  return (
    <span className="worker-alert">
      <button
        ref={buttonRef}
        type="button"
        className="worker-alert-badge"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? panelId : undefined}
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
        onFocus={show}
        onBlur={hideNow}
        onClick={(e) => {
          e.stopPropagation();
          if (open) hideNow();
          else show();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') hideNow();
        }}
      >
        <span className="worker-alert-badge-chip" aria-hidden="true">
          !
        </span>
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="tooltip"
            className="worker-alert-panel"
            style={{ top: position.top, left: position.left }}
            onMouseEnter={show}
            onMouseLeave={scheduleHide}
          >
            {why && (
              <div className={`worker-alert-summary worker-alert-summary--${summaryAppearance}`}>
                <span className="worker-alert-summary-label">{HEALTH_LABEL[health].toUpperCase()}</span>
                <p>{why}</p>
              </div>
            )}
            <div className="worker-alert-table-wrap">
              <table className="worker-alert-table">
                <thead>
                  <tr>
                    {showDestinationColumn && <th>Destination</th>}
                    <th>{WORKER_NOUN[product]}</th>
                    <th>Connected</th>
                    <th>Buffered</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {(rows ?? []).map((row, i) => {
                    const appearance = row.health ? WORKER_HEALTH_APPEARANCE[row.health] : 'default';
                    return (
                      <tr key={`${row.destinationLabel ?? ''}:${row.workerId}:${i}`} className={`worker-alert-row worker-alert-row--${appearance}`}>
                        {showDestinationColumn && <td>{row.destinationLabel ?? '—'}</td>}
                        <td>{row.hostname ?? row.workerId}</td>
                        <td>{row.connected === undefined ? '—' : row.connected ? 'Yes' : 'No'}</td>
                        <td>
                          {row.bufferedBytes !== undefined
                            ? `${formatBytes(row.bufferedBytes)}${row.bufferedEvents !== undefined ? ` (${formatMetric(row.bufferedEvents, 'events')})` : ''}`
                            : '—'}
                        </td>
                        <td>
                          {row.error ? (
                            <div className="worker-alert-detail">
                              <span className="worker-alert-detail-message">{row.error.message}</span>
                              {row.error.detail && <span className="worker-alert-detail-underlying">{row.error.detail}</span>}
                            </div>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
