import { useEffect, type RefObject } from 'react';

/**
 * Calls `onOutside` for a pointerdown outside `ref`'s element, while `active` is true.
 * `ignoreSelector` exempts elements that aren't part of `ref`'s own subtree but shouldn't count as
 * "outside" either — e.g. a resize handle rendered as a page-level sibling of a portaled Drawer,
 * which a plain containment check would otherwise treat as an outside click and close the drawer
 * mid-drag.
 */
export function useClickOutside(ref: RefObject<HTMLElement | null>, onOutside: () => void, active: boolean, ignoreSelector?: string): void {
  useEffect(() => {
    if (!active) return;
    function handle(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (ignoreSelector && target.closest(ignoreSelector)) return;
      if (ref.current && !ref.current.contains(target)) onOutside();
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [active, onOutside, ref, ignoreSelector]);
}
