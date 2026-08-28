import { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useHref, type NavigateOptions } from 'react-router-dom';
import { RouterProvider, Drawer, IconButton, Spinner } from '@capra/core';
import { PushpinOutlined, PushpinSolid, CloseOutlined } from '@capra/icons';
import { AppStateProvider, useAppState } from './state/AppState';
import { Sidebar } from './components/Sidebar';
import { SettingsPanel } from './components/SettingsPanel';
import { HelpPanel, HelpSearchBox, useHelpSearch } from './components/HelpPanel';
import { VIEW_PATH } from './lib/types';
import { useApplyTheme } from './lib/theme';
import { useShareableUrlState } from './lib/shareableUrl';
import { SignalPathPage } from './pages/SignalPathPage';
import { FlowExplorerPage } from './pages/FlowExplorerPage';
import { OverviewPage } from './pages/OverviewPage';
import './App.css';
// Must stay the last import in this file — see its own doc comment for why the cascade order
// matters here.
import './legacy-theme-overrides.css';

declare module '@capra/core' {
  interface RouterConfig {
    routerOptions: NavigateOptions;
  }
}

/** Which of Settings/Help is currently showing, or neither. Deliberately plain local state, not a
 *  route and not part of the KV-persisted `AppState` — see `AppShell`'s own doc comment for why. */
type SidePanel = 'settings' | 'help' | undefined;

/**
 * Landing route (`/`) and catch-all (`*`) both redirect to whichever view `state.view` (the
 * "Default view" Settings preference) currently names — but that preference only reaches `state`
 * after two sequential async round trips (`window.getCriblUser()`, then a KV fetch), which always
 * take at least one tick longer than this component's own first render. Redirecting immediately,
 * before that preference has actually loaded, was a real, guaranteed-every-time bug: `state.view`
 * still held its hardcoded default at that first render, so the app always landed on Overview
 * regardless of what "Default view" was actually set to — and once React Router has committed to
 * a concrete path, a *later* change to `state.view` (once the real preference does arrive) no
 * longer re-triggers a redirect, since neither `/` nor `*` still matches. Waiting for
 * `state.preferencesLoaded` (set once, whether the load succeeded or fell back to defaults — see
 * `AppState.tsx`'s own `.catch()`) closes that race: the redirect only ever fires once `state.view`
 * genuinely reflects the saved preference, not its initial placeholder value. The brief spinner
 * this can show is real load time that already existed before, just previously hidden by
 * redirecting to the wrong place before it finished rather than waiting for it.
 */
function DefaultViewRedirect() {
  const { state } = useAppState();
  if (!state.preferencesLoaded) {
    return (
      <div className="app-initial-loading">
        <Spinner size="lg" title="Loading…" />
      </div>
    );
  }
  return <Navigate to={VIEW_PATH[state.view]} replace />;
}

function AppShell() {
  const navigate = useNavigate();
  const appState = useAppState();
  const { state } = appState;
  useApplyTheme(state.theme);
  useShareableUrlState(appState);

  // Settings and Help used to be real routes (`/settings`, `/help`) — per explicit direction,
  // they're now a left-side `Drawer` floating over whatever page is already loaded, so closing one
  // (click the scrim, Escape, or the header's own dismiss control — all handled by Capra's own
  // `Drawer` for free via `modal` defaulting to `true`) just reveals that same page exactly as it
  // was, instead of navigating away and back and losing/re-fetching its state. This is why the
  // panel lives here as plain component state rather than a KV-persisted `AppState` field or a
  // route: it's ephemeral UI, not something worth remembering across a reload or syncing to the
  // server.
  const [sidePanel, setSidePanel] = useState<SidePanel>(undefined);
  // Pinning suspends the Drawer's own click-outside-to-close behavior (see `modal={!pinned}`
  // below) so the panel can stay open as a working reference alongside the rest of the app. Always
  // starts false on a fresh open — pinning is a per-visit choice, not something worth remembering
  // across opens the way `sidePanel` itself already isn't persisted (see this component's own
  // top-level doc comment). `closeSidePanel` resets it together with `sidePanel` so a later open
  // never inherits a stale pin from whichever panel was open before.
  const [pinned, setPinned] = useState(false);
  const openSettings = () => {
    setSidePanel('settings');
    setPinned(false);
  };
  const openHelp = () => {
    setSidePanel('help');
    setPinned(false);
  };
  const closeSidePanel = () => {
    setSidePanel(undefined);
    setPinned(false);
  };

  // Called unconditionally (hooks can't be called only while Help happens to be open) — see the
  // hook's own doc comment for why. Its own state/refs sit idle and harmless the rest of the time.
  // Threaded into both `HelpSearchBox` (the header row below) and `<HelpPanel>` (this component's
  // own children further down) so the two can share one query/active-tab/scroll-target state despite
  // being rendered in two different places in the Drawer.
  const helpSearch = useHelpSearch();

  // Keeps `--app-sidebar-width` (read by `App.css`'s `.side-panel-portal` override below) in sync
  // with the sidebar's own real rendered width — which varies (collapsed vs. expanded, and the
  // transient hover-expand state), so this can't be a fixed value. A `ResizeObserver` on the real
  // `.app-sidebar` element catches every one of those cases (and a window resize) uniformly,
  // without needing to duplicate `Sidebar.tsx`'s own collapse/hover state here just to know when to
  // re-measure. Queried by class rather than a forwarded ref since `VerticalNavigation` doesn't
  // expose one — the same "target Capra's own rendered DOM directly" approach this app already
  // uses for several other narrow, load-bearing style overrides (see e.g. `Sidebar.css`'s own
  // `.capra-VerticalNavigation-module-*` rules).
  useEffect(() => {
    const el = document.querySelector('.app-sidebar');
    if (!el) return;
    // The sidebar's own *right edge* (`.right`), not its bare `.width` — the rail itself sits a
    // few pixels off the true viewport left edge (`.app-shell`'s own layout), so using `.width`
    // alone as the drawer's `left` offset would land it partway *under* the sidebar's own visible
    // right portion instead of flush against it. `.right` already accounts for that starting
    // offset, whatever it is, without this needing to know or duplicate where it comes from.
    const sync = () => document.documentElement.style.setProperty('--app-sidebar-width', `${el.getBoundingClientRect().right}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Settings/Help portal into this dedicated container (`getContainer`, below) instead of Capra's
  // own `document.body` default, purely so `App.css`'s override can scope itself to
  // `.side-panel-portal .capra-Drawer-module-*` — targeting those same Capra-internal classes
  // unscoped would also catch Signal Path's own (differently-placed, `document.body`-portaled)
  // node-detail drawer, since both instances share the identical CSS module class names. Rendered
  // unconditionally (not only while a panel is open) so the ref is already populated by the time
  // `isOpen` first turns true.
  const sidePanelPortalRef = useRef<HTMLDivElement>(null);

  return (
    <RouterProvider navigate={navigate} useHref={useHref}>
      <div className="app-shell">
        <Sidebar activeSidePanel={sidePanel} onOpenSettings={openSettings} onOpenHelp={openHelp} onNavigate={closeSidePanel} />
        <main className="app-content">
          <Routes>
            <Route path="/" element={<DefaultViewRedirect />} />
            <Route path="/signal-path" element={<SignalPathPage />} />
            <Route path="/flow-explorer" element={<FlowExplorerPage />} />
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="*" element={<DefaultViewRedirect />} />
          </Routes>
        </main>
      </div>

      <div ref={sidePanelPortalRef} className="side-panel-portal" />

      <Drawer
        isOpen={sidePanel !== undefined}
        onClose={closeSidePanel}
        placement="left"
        width={sidePanel === 'help' ? 560 : 480}
        // Non-modal while pinned: Capra's own scrim (and the click-outside-closes/focus-trap
        // behavior it drives) only exists when `modal` is true, so this is the actual mechanism
        // behind "pinning keeps the panel open while you use the rest of the app" — not a custom
        // click-outside override of our own. Escape still closes it either way (Capra's own
        // Escape handling isn't gated by `modal`) — deliberately left as-is; it's a distinct,
        // deliberate keystroke, not the "accidental click elsewhere" pinning exists to guard
        // against, and every other dialog in this app already treats Escape as always-available.
        modal={!pinned}
        // Capra's own header only ever renders a title plus its own built-in close button, with no
        // slot for extra trailing controls — `closable={false}` suppresses that built-in button so
        // a custom title node (which `Drawer` renders as-is when it isn't a plain string, still
        // picking up the right `aria-labelledby` wiring via `Drawer.Heading`) can lay out the real
        // title alongside a pin toggle and this app's own close button as one row.
        closable={false}
        title={
          <div className="side-panel-header-row">
            <Drawer.Heading>{sidePanel === 'settings' ? 'Settings' : 'Help'}</Drawer.Heading>
            {/* Help's own search box sits between the title and the pin/close icons, per direct
                request — a plain flexible spacer stands in for it on Settings (which has no search),
                so the title stays left and the icons stay right in both cases via the same layout,
                rather than two different header shapes for the two panels. */}
            {sidePanel === 'help' ? <HelpSearchBox search={helpSearch} /> : <div className="side-panel-header-spacer" />}
            <div className="side-panel-header-actions">
              <IconButton
                variant="tertiary"
                appearance="neutral"
                size="sm"
                icon={pinned ? PushpinSolid : PushpinOutlined}
                aria-label={pinned ? 'Unpin panel' : 'Pin panel open'}
                aria-pressed={pinned}
                FORCE__className={pinned ? 'side-panel-pin-btn side-panel-pin-btn--active' : 'side-panel-pin-btn'}
                onClick={() => setPinned((p) => !p)}
              />
              <IconButton variant="tertiary" appearance="neutral" size="sm" icon={CloseOutlined} aria-label="Close drawer" onClick={closeSidePanel} />
            </div>
          </div>
        }
        getContainer={() => sidePanelPortalRef.current!}
      >
        {sidePanel === 'settings' && <SettingsPanel />}
        {sidePanel === 'help' && <HelpPanel search={helpSearch} />}
      </Drawer>
    </RouterProvider>
  );
}

function App() {
  return (
    <AppStateProvider>
      <BrowserRouter basename={window.CRIBL_BASE_PATH}>
        <AppShell />
      </BrowserRouter>
    </AppStateProvider>
  );
}

export default App;
