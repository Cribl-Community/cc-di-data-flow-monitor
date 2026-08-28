import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { VerticalNavigation, Tooltip, CustomTooltipTrigger } from '@capra/core';
import { Grid2, PartitionOutlined, ListUnordered, Cog, QuestionCircleOutlined } from '@capra/icons';
import { useAppState } from '../state/AppState';
import { VIEW_LABEL, VIEW_ORDER, VIEW_PATH, type ViewId } from '../lib/types';
import brandSquare from '../assets/brand/appIcon_2x.png';
import brandFull from '../assets/brand/DI-Logo1-300x137.png';
import './Sidebar.css';

const VIEW_ICON: Record<ViewId, React.ReactNode> = {
  signalPath: <PartitionOutlined />,
  flowExplorer: <ListUnordered />,
  overview: <Grid2 />,
};

/**
 * Real logo assets, not the old "D"/"DI" text placeholder. Per direct direction (following a
 * 15-option reveal-mechanism review), this replaces the former cross-fade between two overlapping
 * full images with a fixed icon plus a growing text-only reveal — "Soft Grow," the plainest of the
 * reviewed options: no extra per-text effect layered on top, just the same width transition
 * `.brand-mark`/`.brand-mark-clip` already used. The square icon never moves or fades in either
 * state; only the words "Discovered Intelligence" grow in beside it as the sidebar expands.
 *
 * `brandFull` (`DI-Logo1-300x137.png`) bakes its own copy of the "D" glyph together with the words
 * in one image — shown here purely as a CSS `background-image` on `.brand-mark-text`, cropped via
 * `background-position` to just the text region (`Sidebar.css`'s own doc comment on that rule has
 * the exact measured pixel boundary) since the square icon already supplies the "D" on its own;
 * the wordmark's own copy of it is simply never shown. `brandSquare` is the icon's own real 72×72
 * export (already well above its ~32px display size, so it downscales crisply with no upscaling
 * blur).
 */
function BrandMark({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={collapsed ? 'brand-mark brand-mark--collapsed' : 'brand-mark brand-mark--expanded'}>
      {/* The width-clipping/reveal element is this separate inner wrapper, not `.brand-mark`
       *  itself — see `.brand-mark-clip`'s own doc comment in Sidebar.css for why a plain
       *  `overflow: hidden` here (and *not* split across `overflow-x`/`overflow-y`) is what
       *  actually avoids a real scrollbar bug the split version caused. */}
      <div className="brand-mark-clip">
        <img src={brandSquare} alt="Discovered Intelligence" className="brand-mark-icon" />
        {/* `aria-hidden` — the icon's own `alt` above already carries the brand name; this is a
         *  decorative, purely visual echo of the same name, not new information. */}
        <div className="brand-mark-reveal">
          <div className="brand-mark-text" style={{ backgroundImage: `url(${brandFull})` }} aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

interface SidebarProps {
  /** Which of Settings/Help is currently open as the left-side drawer (`App.tsx` owns the actual
   *  state) — drives the footer items' own `isActive`, since neither is a route anymore. */
  activeSidePanel: 'settings' | 'help' | undefined;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  /** Closes Settings/Help (if either is open) when a view nav item is clicked — including while
   *  pinned, per explicit direction that any other sidebar icon closes an open panel regardless of
   *  pin state. A no-op when nothing is open. */
  onNavigate: () => void;
}

export function Sidebar({ activeSidePanel, onOpenSettings, onOpenHelp, onNavigate }: SidebarProps) {
  const { state, dispatch } = useAppState();
  const location = useLocation();
  const navigate = useNavigate();
  // VerticalNavigation.Item renders a plain <a href> with no router awareness (it isn't built on
  // react-aria's Link, so RouterProvider's navigate/useHref never reach it) — left alone, every
  // click is a full browser navigation that remounts the whole app and drops in-memory state.
  // Intercepting the click and driving react-router ourselves keeps navigation client-side.
  const handleNavClick = (href: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    onNavigate();
    navigate(href);
  };
  // Settings/Help open the left-side drawer (`App.tsx`) instead of navigating — same
  // intercept-the-anchor-click reasoning as `handleNavClick` above, just a different action once
  // intercepted.
  const handlePanelClick = (open: () => void) => (event: React.MouseEvent) => {
    event.preventDefault();
    open();
  };
  const collapsed = state.sidebarCollapsed;
  // Separate from `collapsed` on purpose: hovering never touches the persisted preference, only
  // how the rail looks *right now*. The Collapse button below still reads/toggles the real
  // `collapsed` value even while a hover is temporarily showing labels.
  const [isHovering, setIsHovering] = useState(false);
  const visuallyCollapsed = collapsed && !(isHovering && state.sidebarAutoExpandOnHover);

  return (
    <VerticalNavigation
      collapsed={visuallyCollapsed}
      // Deliberately ignores Capra's own `next` argument and flips our real `collapsed` directly
      // instead: Capra computes `next` from the `collapsed` prop it was given (`visuallyCollapsed`),
      // which during a hover-expand no longer matches the real persisted state — trusting it would
      // toggle the wrong direction the instant a hover and a real collapse disagree.
      onCollapseChange={() => dispatch({ type: 'sidebar/setCollapsed', collapsed: !collapsed })}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      aria-label="Data Flow Monitor navigation"
      FORCE__className="app-sidebar"
    >
      <BrandMark collapsed={visuallyCollapsed} />

      <VerticalNavigation.ItemList>
        {VIEW_ORDER.map((view) => (
          // Always the same Tooltip-wrapped shape, toggling only `isDisabled` — a real bug found
          // live while chasing an expand/collapse asymmetry: rendering a *bare* `<Item>` when
          // expanded and swapping in a differently-shaped `<Tooltip><CustomTooltipTrigger>...`
          // tree when collapsed (the previous version of this code) changes the JSX tree shape
          // itself, so React unmounts and remounts a brand-new `<Item>` every time `visuallyCollapsed`
          // flips — and a freshly-mounted element has no "previous" computed style to transition
          // *from*, so its own width/label CSS transitions couldn't animate at all on that remount,
          // snapping instantly to their final value instead. That snap was invisible collapsing
          // (the rail's own still-wide `min-width` stayed the binding constraint throughout, so an
          // item that's already instantly narrow made no visible difference) but very visible
          // expanding (the freshly-mounted item's instantly-full width immediately exceeded the
          // rail's own still-narrow `min-width`, forcing the whole rail to jump wide in one frame
          // before easing the rest of the way) — exactly the reported "jerky expand, fine collapse"
          // asymmetry, confirmed by sampling every real paint frame through both directions.
          // `isDisabled` (a real Capra `Tooltip` prop) suppresses just the popover itself without
          // changing the tree shape at all, so the same `<Item>` instance now survives every
          // collapse/expand toggle and its own transitions animate normally in both directions.
          <Tooltip key={view} title={VIEW_LABEL[view]} placement="right" isDisabled={!visuallyCollapsed}>
            <CustomTooltipTrigger>
              <VerticalNavigation.Item
                icon={VIEW_ICON[view]}
                label={VIEW_LABEL[view]}
                href={VIEW_PATH[view]}
                isActive={location.pathname === VIEW_PATH[view]}
                onClick={handleNavClick(VIEW_PATH[view])}
              />
            </CustomTooltipTrigger>
          </Tooltip>
        ))}
      </VerticalNavigation.ItemList>

      <VerticalNavigation.Footer>
        {[
          { id: 'settings' as const, label: 'Settings', href: '/settings', icon: <Cog />, open: onOpenSettings },
          { id: 'help' as const, label: 'Help', href: '/help', icon: <QuestionCircleOutlined />, open: onOpenHelp },
        ].map(({ id, label, href, icon, open }) => (
          // Same fixed shape as the main item list above — see that map's own comment.
          <Tooltip key={id} title={label} placement="right" isDisabled={!visuallyCollapsed}>
            <CustomTooltipTrigger>
              <VerticalNavigation.Item icon={icon} label={label} href={href} isActive={activeSidePanel === id} onClick={handlePanelClick(open)} />
            </CustomTooltipTrigger>
          </Tooltip>
        ))}
      </VerticalNavigation.Footer>

      {/* Same fixed-shape-plus-`isDisabled` treatment as the items above, for the same reason —
          reflects and toggles the real persisted `collapsed`, not the hover-driven visual state,
          so clicking it always pins/unpins the rail regardless of whether a hover is currently
          showing it expanded. */}
      <Tooltip title="Expand navigation" placement="right" isDisabled={!collapsed}>
        <CustomTooltipTrigger>
          <VerticalNavigation.Collapse aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} />
        </CustomTooltipTrigger>
      </Tooltip>
    </VerticalNavigation>
  );
}
