// @capra/icons has nothing that reads as "sidebar pinned collapsed" / "pinned expanded" / "reveals
// on hover" (confirmed by checking its full icon list the same way `ThemeIcons.tsx` already did for
// Sun/Moon/Monitor) — these three are hand-drawn to match that same file's own convention: 20x20
// viewBox, 1em sizing, currentColor, minimal stroke-based glyphs rather than inventing solid-fill
// ones by eye. All three share one small app-frame outline (an outer rounded rect) with a rail
// portion inside it, so the three read as one family and differ only in what the rail itself shows.

function FrameIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      {children}
    </svg>
  );
}

/** A narrow, solid rail — the sidebar stays pinned collapsed on every load. */
export function SidebarCollapsedIcon() {
  return (
    <FrameIcon>
      <rect x="4" y="5" width="3" height="10" fill="currentColor" />
    </FrameIcon>
  );
}

/** A wide, solid rail — the sidebar stays pinned open (labels visible) on every load. */
export function SidebarExpandedIcon() {
  return (
    <FrameIcon>
      <rect x="4" y="5" width="7.5" height="10" fill="currentColor" />
    </FrameIcon>
  );
}

/** A narrow, half-opacity rail (only sometimes shown) with a small chevron overlapping its own
 *  trailing edge — the "reveals on interaction" motif, distinguishing this from the always-on
 *  collapsed state above despite sharing the same narrow rail width. */
export function SidebarHoverIcon() {
  return (
    <FrameIcon>
      <rect x="4" y="5" width="3" height="10" fill="currentColor" fillOpacity="0.4" />
      <path d="M8.5 8 L11.5 10 L8.5 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </FrameIcon>
  );
}
