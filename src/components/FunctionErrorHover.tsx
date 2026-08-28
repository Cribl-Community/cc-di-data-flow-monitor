import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatTimestamp } from '../lib/format';
import type { FunctionErrorLogEntry } from '../api/logs';
import { clampFloatingPanelToViewport } from '../lib/floatingPanel';
import './FunctionErrorHover.css';

interface FunctionErrorHoverProps {
  entries: FunctionErrorLogEntry[] | undefined;
  children: React.ReactNode;
  ariaLabel: string;
  className?: string;
}

/**
 * A hover/focus trigger that shows a floating panel of recent function-error log entries — used by
 * the Signal Path node card and detail drawer. All four viewport edges are checked and corrected
 * when positioning the panel (see `clampFloatingPanelToViewport`), not just the right edge.
 */
export function FunctionErrorHover({ entries, children, ariaLabel, className }: FunctionErrorHoverProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | undefined>(undefined);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const panelId = useId();

  const hideNow = () => setOpen(false);

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

  const list = entries ?? [];

  const show = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 4, left: rect.left });
    setOpen(true);
  };
  const scheduleHide = () => {
    hideTimer.current = setTimeout(() => setOpen(false), 200);
  };

  const SHOWN_CAP = 20;

  return (
    <span className="function-error-hover">
      <button
        ref={buttonRef}
        type="button"
        className={className ? `function-error-trigger ${className}` : 'function-error-trigger'}
        aria-label={ariaLabel}
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
        {children}
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="tooltip"
            className="function-error-panel"
            style={{ top: position.top, left: position.left }}
            onMouseEnter={show}
            onMouseLeave={scheduleHide}
          >
            {list.length === 0 ? (
              <div className="function-error-empty">No detailed error log entries found for this window.</div>
            ) : (
              <ul className="function-error-list">
                {list.slice(0, SHOWN_CAP).map((entry, i) => (
                  <li key={`${entry.time}:${i}`} className="function-error-item">
                    <span className="function-error-time">{formatTimestamp(entry.time)}</span>
                    <span className="function-error-message">{entry.message}</span>
                  </li>
                ))}
              </ul>
            )}
            {list.length > SHOWN_CAP && <div className="function-error-more">+{list.length - SHOWN_CAP} more</div>}
          </div>,
          document.body,
        )}
    </span>
  );
}
