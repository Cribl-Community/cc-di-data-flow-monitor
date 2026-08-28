import './DrawerResizeHandle.css';

interface DrawerResizeHandleProps {
  /** Current drawer width in px — the handle positions itself flush against the sheet's own left
   *  edge, which moves as the width changes. */
  drawerWidth: number;
  onMouseDown: (e: React.MouseEvent) => void;
}

/**
 * A custom drag handle for a Capra `Drawer`'s width — Capra's own `Drawer` has no resize
 * affordance at all (confirmed via its docs: a fixed `width` prop, clamped [400px, 80vw]), so this
 * is a small bespoke overlay rather than a Capra prop.
 */
export function DrawerResizeHandle({ drawerWidth, onMouseDown }: DrawerResizeHandleProps) {
  return (
    <div
      className="drawer-resize-handle"
      style={{ right: `calc(${drawerWidth}px - 3px)` }}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize detail panel"
    />
  );
}
