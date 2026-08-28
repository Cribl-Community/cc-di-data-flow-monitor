/** Shared by the Signal Path canvas's own floating hover panels (`NodeCardWorkerAlertBadge`,
 *  `FunctionErrorHover`) to keep a trigger-anchored panel fully on-screen. Checks — and corrects —
 *  all four viewport edges in one pass: a trigger near the *bottom* of the browser window can still
 *  open a panel that would otherwise run off the bottom edge, not just the right one.
 */
export interface FloatingPanelPosition {
  top: number;
  left: number;
}

const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 4;

/**
 * `panelRect` is the panel's own already-measured `getBoundingClientRect()` — since it was rendered
 * at `current`'s exact `top`/`left`, its `right`/`bottom` directly reflect what a "no correction
 * needed" case would look like, so overflow is just `panelRect.right - window.innerWidth` etc.,
 * no reconstruction from separate width/height values needed. `triggerRect` is used only for the
 * vertical case, to flip the panel above the trigger when there's more room there than below.
 */
export function clampFloatingPanelToViewport(panelRect: DOMRect, current: FloatingPanelPosition, triggerRect: DOMRect): FloatingPanelPosition {
  let { top, left } = current;

  const rightOverflow = panelRect.right - window.innerWidth;
  if (rightOverflow > 0) left -= rightOverflow + VIEWPORT_MARGIN;
  left = Math.max(VIEWPORT_MARGIN, left);

  const bottomOverflow = panelRect.bottom - window.innerHeight;
  if (bottomOverflow > 0) {
    const panelHeight = panelRect.height;
    const aboveTop = triggerRect.top - panelHeight - TRIGGER_GAP;
    // Flip above the trigger when there's real room there; otherwise pin to the bottom margin —
    // rare (only when the panel is taller than the whole viewport), but never worse than the
    // original unclamped overflow.
    top = aboveTop >= VIEWPORT_MARGIN ? aboveTop : Math.max(VIEWPORT_MARGIN, window.innerHeight - panelHeight - VIEWPORT_MARGIN);
  }
  top = Math.max(VIEWPORT_MARGIN, top);

  return { top, left };
}
