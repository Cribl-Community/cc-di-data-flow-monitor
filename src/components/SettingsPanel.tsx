import { useState } from 'react';
import { Text, Button, Modal, Tooltip, CustomTooltipTrigger } from '@capra/core';
import { useAppState } from '../state/AppState';
import {
  ALL_GROUPS_ID,
  AUTO_REFRESH_OPTIONS,
  FLOW_ANIMATION_OPTIONS,
  TOP_SOURCES_COUNT_OPTIONS,
  VIEW_LABEL,
  VIEW_ORDER,
  type FlowAnimationStyle,
  type GroupProductFilter,
  type SidebarMode,
  type UserPreferences,
  type ViewId,
} from '../lib/types';
import { isSupportedGroup } from '../api/groups';
import { SunIcon, MoonIcon, SystemIcon } from './ThemeIcons';
import { SidebarCollapsedIcon, SidebarExpandedIcon, SidebarHoverIcon } from './SidebarModeIcons';
import './SettingsPanel.css';

const THEME_OPTIONS: { id: UserPreferences['theme']; label: string; icon: React.ReactNode }[] = [
  { id: 'light', label: 'Light', icon: <SunIcon /> },
  { id: 'dark', label: 'Dark', icon: <MoonIcon /> },
  { id: 'system', label: 'System', icon: <SystemIcon /> },
];

const SIDEBAR_MODE_OPTIONS: { id: SidebarMode; label: string; icon: React.ReactNode }[] = [
  { id: 'collapsed', label: 'Collapsed', icon: <SidebarCollapsedIcon /> },
  { id: 'expanded', label: 'Expanded', icon: <SidebarExpandedIcon /> },
  { id: 'hover', label: 'Expand on hover', icon: <SidebarHoverIcon /> },
];

type SettingsTab = 'general' | 'thresholds';
const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'thresholds', label: 'Thresholds' },
];

/** One CPU/Memory/Disk pressure-warning row — shared by both the Stream and Edge subsections on
 *  the Thresholds tab, since the control shape is identical for all six real fields (see
 *  `UserPreferences.cpuPressureWarnPctStream`'s own doc comment for why there are six, not two). */
function ThresholdRow({
  label,
  description,
  value,
  ariaLabel,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  ariaLabel: string;
  onChange: (pct: number) => void;
}) {
  return (
    <div className="settings-page-row">
      <div className="settings-page-label">
        <Text as="p" variant="body-sm-semibold">
          {label}
        </Text>
        <Text as="p" variant="body-sm-normal" color="subtle">
          {description}
        </Text>
      </div>
      <div className="settings-threshold-control">
        <input type="range" min={40} max={84} step={1} value={value} aria-label={ariaLabel} onChange={(e) => onChange(Number(e.target.value))} />
        <Text as="span" variant="body-sm-semibold" FORCE__className="settings-threshold-value">
          {value}%
        </Text>
      </div>
    </div>
  );
}

/**
 * Settings content only — no page chrome of its own (`App.tsx`'s own `<Drawer>` supplies the
 * title/close control), reused as-is from the former `SettingsPage.tsx`. See `AppShell`'s own doc
 * comment in `App.tsx` for why this moved from a routed page to a drawer.
 */
export function SettingsPanel() {
  const { state, dispatch } = useAppState();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const supportedGroups = state.workerGroups.filter(isSupportedGroup);
  const streamGroups = supportedGroups.filter((g) => g.type === 'stream');
  const edgeGroups = supportedGroups.filter((g) => g.type === 'edge');

  const setPressureThreshold = (metric: 'cpu' | 'mem' | 'disk', product: GroupProductFilter, pct: number) =>
    dispatch({ type: 'pressureThreshold/set', metric, product, pct });

  // Resetting overwrites every preference below with its app default — a real, if reversible-by-
  // hand, loss of the user's own current choices, so it goes through the same confirm-before-
  // overwrite pattern AGENTS.md requires for any action that replaces existing state rather than
  // firing straight off the button's own click. Specifically `Modal.confirm` (appearance
  // "default"), not `.warning`/`.danger` — read directly in Capra's own source, only the
  // "default" appearance actually renders a Cancel button at all; the others render a single
  // acknowledge-only action with the dialog itself set non-dismissible, which would leave no way
  // to back out of this prompt except actually resetting.
  const handleResetClick = () => {
    Modal.confirm({
      title: 'Reset all settings?',
      content:
        'Theme, default view, default Worker Group/Edge Fleet, auto-refresh interval, sidebar behavior, flow animation style, Top Sources count, and every Stream/Edge pressure threshold all go back to their app defaults. Saved views are not affected. This can’t be undone — your current choices will be replaced.',
      confirmButtonText: 'Reset to defaults',
      cancelButtonText: 'Cancel',
      onConfirm: () => dispatch({ type: 'preferences/reset' }),
    });
  };

  return (
    <div className="settings-panel-body">
      <div className="settings-sticky-header">
        <div className="settings-tablist" role="tablist" aria-label="Settings sections">
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`settings-tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`settings-tabpanel-${tab.id}`}
              className={activeTab === tab.id ? 'settings-tab settings-tab--active' : 'settings-tab'}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-tabpanel" role="tabpanel" id={`settings-tabpanel-${activeTab}`} aria-labelledby={`settings-tab-${activeTab}`} tabIndex={0}>
        {activeTab === 'general' ? (
          <>
      <section>
        <Text as="h2" variant="heading">
          Appearance
        </Text>
        <div className="settings-page-row">
          <div className="settings-page-label">
            <Text as="p" variant="body-sm-semibold">
              Theme
            </Text>
            <Text as="p" variant="body-sm-normal" color="subtle">
              Dark by default — choose Light or System to change that.
            </Text>
          </div>
          <div className="segmented segmented--icon" role="group" aria-label="Theme">
            {THEME_OPTIONS.map((opt) => (
              <Tooltip key={opt.id} title={opt.label} placement="top">
                <CustomTooltipTrigger>
                  <button
                    type="button"
                    className={state.theme === opt.id ? 'active' : ''}
                    aria-label={opt.label}
                    aria-pressed={state.theme === opt.id}
                    onClick={() => dispatch({ type: 'theme/set', theme: opt.id })}
                  >
                    {opt.icon}
                  </button>
                </CustomTooltipTrigger>
              </Tooltip>
            ))}
          </div>
        </div>
      </section>

      <section>
        <Text as="h2" variant="heading">
          Navigation
        </Text>
        <div className="settings-page-row">
          <div className="settings-page-label">
            <Text as="p" variant="body-sm-semibold">
              Sidebar behavior
            </Text>
            <Text as="p" variant="body-sm-normal" color="subtle">
              Collapsed by default — Expanded keeps labels visible on every load; Expand on hover
              reveals them temporarily without pinning the sidebar open.
            </Text>
          </div>
          <div className="segmented segmented--icon" role="group" aria-label="Sidebar behavior">
            {SIDEBAR_MODE_OPTIONS.map((opt) => (
              <Tooltip key={opt.id} title={opt.label} placement="top">
                <CustomTooltipTrigger>
                  <button
                    type="button"
                    className={state.sidebarMode === opt.id ? 'active' : ''}
                    aria-label={opt.label}
                    aria-pressed={state.sidebarMode === opt.id}
                    onClick={() => dispatch({ type: 'sidebar/setMode', mode: opt.id })}
                  >
                    {opt.icon}
                  </button>
                </CustomTooltipTrigger>
              </Tooltip>
            ))}
          </div>
        </div>
        <div className="settings-page-row">
          <div className="settings-page-label">
            <Text as="p" variant="body-sm-semibold">
              Default view
            </Text>
            <Text as="p" variant="body-sm-normal" color="subtle">
              Which view opens first.
            </Text>
          </div>
          <select
            className="settings-page-select"
            aria-label="Default view"
            value={state.view}
            onChange={(e) => dispatch({ type: 'view/set', view: e.target.value as ViewId })}
          >
            {VIEW_ORDER.map((v) => (
              <option key={v} value={v}>
                {VIEW_LABEL[v]}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section>
        <Text as="h2" variant="heading">
          Data
        </Text>
        <div className="settings-page-row">
          <div className="settings-page-label">
            <Text as="p" variant="body-sm-semibold">
              Default Worker Group/Edge Fleet
            </Text>
            <Text as="p" variant="body-sm-normal" color="subtle">
              Which Worker Group or Edge Fleet Signal Path and Flow Explorer open to. Picking a
              Fleet here also switches the Stream/Edge toggle to Edge, and picking a Worker Group
              switches it back to Stream.
            </Text>
          </div>
          <select
            className="settings-page-select"
            aria-label="Default Worker Group/Edge Fleet"
            value={state.selectedGroupId ?? ALL_GROUPS_ID}
            onChange={(e) => dispatch({ type: 'group/select', groupId: e.target.value })}
            disabled={state.workerGroupsStatus === 'loading'}
          >
            <option value={ALL_GROUPS_ID}>All Worker Groups</option>
            {streamGroups.length > 0 && (
              <optgroup label="Stream Worker Groups">
                {streamGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </optgroup>
            )}
            {edgeGroups.length > 0 && (
              <optgroup label="Edge Fleets">
                {edgeGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <div className="settings-page-row">
          <div className="settings-page-label">
            <Text as="p" variant="body-sm-semibold">
              Auto-refresh
            </Text>
            <Text as="p" variant="body-sm-normal" color="subtle">
              How often Signal Path re-fetches data on its own. Choose "Off" to disable and
              refresh manually instead.
            </Text>
          </div>
          <div className="segmented" role="group" aria-label="Auto-refresh interval">
            {AUTO_REFRESH_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={state.autoRefreshId === opt.id ? 'active' : ''}
                aria-pressed={state.autoRefreshId === opt.id}
                onClick={() => dispatch({ type: 'autoRefresh/set', autoRefreshId: opt.id })}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-page-row">
          <div className="settings-page-label">
            <Text as="p" variant="body-sm-semibold">
              Top Sources count
            </Text>
            <Text as="p" variant="body-sm-normal" color="subtle">
              How many active Sources the "Top N Active" status filter (Signal Path and Flow
              Explorer's own top bars) narrows down to, ranked by volume in the selected time
              range, when selected.
            </Text>
          </div>
          <select
            className="settings-page-select"
            aria-label="Top Sources count"
            value={state.topSourcesCount}
            onChange={(e) => dispatch({ type: 'topSourcesCount/set', count: Number(e.target.value) })}
          >
            {TOP_SOURCES_COUNT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section>
        <Text as="h2" variant="heading">
          Signal Path
        </Text>
        <div className="settings-page-row">
          <div className="settings-page-label">
            <Text as="p" variant="body-sm-semibold">
              Flow animation style
            </Text>
            <Text as="p" variant="body-sm-normal" color="subtle">
              Shown on active (real-traffic) edges when nothing on the canvas is hovered — hovering
              reverts to a plain highlighted/dimmed flow with no animation.
            </Text>
          </div>
          <select
            className="settings-page-select"
            aria-label="Flow animation style"
            value={state.flowAnimationStyle}
            onChange={(e) => dispatch({ type: 'flowAnimation/set', flowAnimationStyle: e.target.value as FlowAnimationStyle })}
          >
            {FLOW_ANIMATION_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section>
        <Text as="h2" variant="heading">
          Reset
        </Text>
        <div className="settings-page-row">
          <div className="settings-page-label">
            <Text as="p" variant="body-sm-semibold">
              Reset to defaults
            </Text>
            <Text as="p" variant="body-sm-normal" color="subtle">
              Puts every setting on both tabs back the way it was on first install.
            </Text>
          </div>
          <Button appearance="danger" onClick={handleResetClick}>
            Reset to defaults
          </Button>
        </div>
      </section>
          </>
        ) : (
          <>
            <section>
              <Text as="h2" variant="heading">
                Stream Worker thresholds
              </Text>
              <Text as="p" variant="body-sm-normal" color="subtle">
                Applies to Node Inventory rows for Stream Worker Groups, when the top-left product
                toggle on Overview is set to Stream.
              </Text>
              <ThresholdRow
                label="CPU pressure warning"
                description="Overview's Node Inventory turns a Worker's CPU bar amber above this. The red cutoff stays a fixed 85% — this only tunes how early the amber warning shows."
                value={state.cpuPressureWarnPctStream}
                ariaLabel="Stream CPU pressure warning percent"
                onChange={(pct) => setPressureThreshold('cpu', 'stream', pct)}
              />
              <ThresholdRow
                label="Memory pressure warning"
                description="Same signal, for the Memory bar right beside it."
                value={state.memPressureWarnPctStream}
                ariaLabel="Stream memory pressure warning percent"
                onChange={(pct) => setPressureThreshold('mem', 'stream', pct)}
              />
              <ThresholdRow
                label="Disk pressure warning"
                description="Same signal, for the Disk bar."
                value={state.diskPressureWarnPctStream}
                ariaLabel="Stream disk pressure warning percent"
                onChange={(pct) => setPressureThreshold('disk', 'stream', pct)}
              />
            </section>

            <section>
              <Text as="h2" variant="heading">
                Edge Node thresholds
              </Text>
              <Text as="p" variant="body-sm-normal" color="subtle">
                Applies to Node Inventory rows for Edge Fleets, when the top-left product toggle
                on Overview is set to Edge — tunable separately from the Stream thresholds above,
                since a typical Edge Node's resource profile isn't necessarily the same as a
                Stream Worker's.
              </Text>
              <ThresholdRow
                label="CPU pressure warning"
                description="Overview's Node Inventory turns a Node's CPU bar amber above this. The red cutoff stays a fixed 85% — this only tunes how early the amber warning shows."
                value={state.cpuPressureWarnPctEdge}
                ariaLabel="Edge CPU pressure warning percent"
                onChange={(pct) => setPressureThreshold('cpu', 'edge', pct)}
              />
              <ThresholdRow
                label="Memory pressure warning"
                description="Same signal, for the Memory bar right beside it."
                value={state.memPressureWarnPctEdge}
                ariaLabel="Edge memory pressure warning percent"
                onChange={(pct) => setPressureThreshold('mem', 'edge', pct)}
              />
              <ThresholdRow
                label="Disk pressure warning"
                description="Same signal, for the Disk bar."
                value={state.diskPressureWarnPctEdge}
                ariaLabel="Edge disk pressure warning percent"
                onChange={(pct) => setPressureThreshold('disk', 'edge', pct)}
              />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
