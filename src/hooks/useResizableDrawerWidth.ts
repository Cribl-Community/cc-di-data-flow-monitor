import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_WIDTH = 480;
const MIN_WIDTH = 400; // matches Capra's own Drawer clamp floor — no point allowing a drag past what it'd ignore
const MAX_WIDTH_VW = 0.8; // matches Capra's own Drawer clamp ceiling (80vw)

/**
 * Drag-to-resize state for a Capra `Drawer` — Capra's own `width` prop is a fixed value with no
 * built-in resize affordance (confirmed via its docs: min 400px / max 80vw, no drag handle).
 * Returns the current width plus the props a `<div>` resize handle needs; the handle itself is
 * left to the caller since its exact placement (flush with the drawer's own left edge) depends on
 * that page's layout.
 *
 * Also returns `setContentWidth`, for a page whose drawer content itself suggests a width (Signal
 * Path's own `drawerWidthFor` — a Routes table wants more room than a plain status panel). Once
 * the user has actually dragged the handle, that becomes a real preference and every later
 * content-driven suggestion is ignored for the rest of the page's lifetime — matching how a
 * manually-resized side panel behaves elsewhere (VS Code, browser dev tools), rather than
 * fighting the user's own choice back to a "smarter" size on the next node they open.
 */
export function useResizableDrawerWidth(defaultWidth = DEFAULT_WIDTH) {
  const [width, setWidth] = useState(defaultWidth);
  const draggingRef = useRef(false);
  const userResizedRef = useRef(false);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!draggingRef.current) return;
      const maxWidth = window.innerWidth * MAX_WIDTH_VW;
      const next = Math.min(maxWidth, Math.max(MIN_WIDTH, window.innerWidth - e.clientX));
      setWidth(next);
    }
    function onMouseUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    userResizedRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const setContentWidth = useCallback(
    (contentWidth: number | undefined) => {
      if (userResizedRef.current) return;
      setWidth(contentWidth ?? defaultWidth);
    },
    [defaultWidth],
  );

  return { width, onHandleMouseDown, setContentWidth };
}
