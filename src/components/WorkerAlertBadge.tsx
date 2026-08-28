import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatBytes, formatMetric } from '../lib/format';
import { WORKER_HEALTH_APPEARANCE, type WorkerStatusRow } from '../api/workers';
import { workerAlertSeverity } from '../hooks/useDestinationWorkerAlerts';
import { WORKER_NOUN, WORKER_NOUN_PLURAL } from '../lib/productTerms';
import type { GroupProductFilter } from '../lib/types';
import './WorkerAlertBadge.css';

/**
 * Real per-worker "blocked" escalation, distinct from a component/flow's own volume-based health
 * model. A Destination can read healthy by volume while one specific Worker process genuinely
 * can't reach it (the exact real-world case that motivated the Signal Path drawer's own
 * "Per-worker status" table — see CLAUDE.md's Thirtieth round) — this badge surfaces that same
 * signal directly on the card/cell/node it belongs to, without requiring a click into a drawer
 * first. Shared across every page that shows a Destination — Signal Path's `NodeCard` and Flow
 * Explorer's table rows/expanded chains — so the same visual language and interaction (hover or
 * focus reveals the same per-worker breakdown) reads identically everywhere it appears.
 *
 * Hover *or* focus reveals the panel. Built as a native `<button>` (not a bare `<span>`) so it's
 * independently reachable and operable by keyboard and touch, not just mouse hover — Capra's own
 * `Tooltip` only accepts a plain string, which can't hold a multi-worker table, so this is a small
 * purpose-built widget rather than a forced fit.
 *
 * The panel is portaled to `document.body` and positioned via `getBoundingClientRect()` rather
 * than a plain CSS-absolute child — confirmed live via the Playwright harness that a table's own
 * scroll container (`overflow: auto`, hugging its content height with no slack) silently clips a
 * CSS-absolute panel anchored inside it after its first ~20px. Portaling escapes that ancestor's
 * clipping the same way Capra's own `Tooltip`/`Popover` default to mounting in `document.body` for
 * the same reason — a general risk for this badge wherever it's placed, not just its original
 * home in Flow Explorer's table.
 */
export function WorkerAlertBadge({ rows, product = 'stream' }: { rows: WorkerStatusRow[] | undefined; product?: GroupProductFilter }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | undefined>(undefined);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const panelId = useId();

  const hideNow = () => setOpen(false);

  // The initial `left` is the trigger's own left edge, correct for most placements — but a badge
  // near the right edge of the viewport (e.g. the last card in Signal Path's Destinations lane)
  // would otherwise open a panel that runs off-screen, confirmed live via the Playwright harness.
  // Only measurable *after* the panel has actually rendered (its width depends on content — the
  // worker count/hostnames vary), so this clamps `left` in a layout effect rather than trying to
  // predict the width up front.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const overflow = rect.right - window.innerWidth;
    if (overflow > 0) {
      setPosition((prev) => (prev ? { ...prev, left: Math.max(8, prev.left - overflow - 8) } : prev));
    }
  }, [open]);

  // A stale position (from before a scroll/resize) is worse than no panel — closing rather than
  // repositioning matches Capra's own Tooltip, which also just dismisses on scroll rather than
  // tracking the trigger continuously.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', hideNow, true);
    window.addEventListener('resize', hideNow);
    return () => {
      window.removeEventListener('scroll', hideNow, true);
      window.removeEventListener('resize', hideNow);
    };
  }, [open]);

  if (workerAlertSeverity(rows) === 'none') return null;
  const blockedRows = (rows ?? []).filter((r) => r.health === 'Red');
  // Only shown as its own column when at least one row actually carries it — set only when rows
  // from more than one real Destination have been concatenated (an Output Router's own rollup
  // across its real targets); every other caller's rows are all for one Destination already named
  // by the card/cell/node itself, so a repeated column there would be redundant.
  const showDestinationColumn = (rows ?? []).some((r) => r.destinationLabel !== undefined);

  const show = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 4, left: rect.left });
    setOpen(true);
  };
  // Small delay so moving the pointer from the badge onto the panel itself doesn't flicker-close
  // it — same idea as Capra's own Tooltip dismissal delay, just applied to a custom widget.
  const scheduleHide = () => {
    hideTimer.current = setTimeout(() => setOpen(false), 200);
  };

  const nodeNoun = (blockedRows.length === 1 ? WORKER_NOUN[product] : WORKER_NOUN_PLURAL[product]).toLowerCase();
  const label = `Blocked on ${blockedRows.length} ${nodeNoun} — press Enter for details`;

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
