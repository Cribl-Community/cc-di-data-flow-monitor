import { cloneElement, Fragment, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Text, Pill, Alert } from '@capra/core';
import { Search, CloseOutlined } from '@capra/icons';
import './HelpPanel.css';

type HelpTab = 'general' | 'overview' | 'signalPath' | 'flowExplorer' | 'about';

const TABS: { id: HelpTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'overview', label: 'Overview' },
  { id: 'signalPath', label: 'Signal Path' },
  { id: 'flowExplorer', label: 'Flow Explorer' },
  { id: 'about', label: 'About' },
];

const TAB_LABEL_BY_ID = TABS.reduce<Record<HelpTab, string>>((acc, t) => {
  acc[t.id] = t.label;
  return acc;
}, {} as Record<HelpTab, string>);

/** A bold term followed by its description — the list format already established by the former
 *  single-page Help content, reused throughout every tab below instead of a `<table>`, which reads
 *  cramped at the drawer's own width. */
function TermList({ children }: { children: ReactNode }) {
  return <ul className="help-term-list">{children}</ul>;
}

function Term({ children }: { children: ReactNode }) {
  return <b>{children}</b>;
}

/** A small tracked category label above a section's own heading — General only (see this file's
 *  own top-level doc comment for why it isn't everywhere). The class carrying the letter-spacing/
 *  uppercase transform lives on the wrapping `span`, not passed to `Text` itself, per AGENTS.md's
 *  own guidance that Capra components should rarely take a `className`. */
function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="help-eyebrow">
      <Text as="span" variant="body-xs-semibold" color="accent">
        {children}
      </Text>
    </span>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return (
    <Text as="h3" variant="heading-xs">
      {children}
    </Text>
  );
}

/**
 * One documentation section — the unit both rendering and search operate on. `body` is the exact
 * JSX that goes inside the section's own `<section>` wrapper (unchanged from how this file's
 * tab-per-function version wrote it); `title` is a plain-text label used both as the section's own
 * search-result heading and, for a tab's very first section, as its de facto "Introduction" name
 * (none of the five tabs give their own opening paragraph a visible `SubHeading`). Splitting content
 * into named, id-addressable records — rather than one big JSX blob per tab, as this file used to
 * be — is what makes the sticky tab strip's own "jump to a specific section" search feature possible
 * without a second, hand-maintained copy of this same content: `extractText` below derives the full
 * search index directly from each entry's own `body`, so search and render can never drift apart.
 */
type HelpSection = { tabId: HelpTab; id: string; title: string; body: ReactNode };

const GENERAL_SECTIONS: HelpSection[] = [
  {
    tabId: 'general',
    id: 'general-intro',
    title: 'Introduction',
    body: (
      <Text as="p">
        Data Flow Monitor provides a unified view of how events move through a Cribl Stream Worker Group or Edge
        Fleet, spanning the Source, Pre-Processing, Routes, Pipeline, Post-Processing, and Destination stages. Use this
        application to verify that a flow exists and to understand its configuration, or to identify precisely
        where events are being blocked or are failing to arrive.
      </Text>
    ),
  },
  {
    tabId: 'general',
    id: 'general-views',
    title: 'The three views',
    body: (
      <>
        <Eyebrow>Views</Eyebrow>
        <SubHeading>The three views</SubHeading>
        <TermList>
          <li>
            <Term>Overview</Term> — Presents a high-level summary of fleet health, including license entitlement
            and daily ingest. This is the recommended starting point when the area requiring attention has not yet
            been identified.
          </li>
          <li>
            <Term>Signal Path</Term> — Displays the complete wiring diagram for a single Worker Group or Fleet.
            Use this view to verify how a flow is actually configured.
          </li>
          <li>
            <Term>Flow Explorer</Term> — Presents one row per Source-to-Destination pair, with sortable and
            searchable columns. Use this view to scan or compare multiple flows at once.
          </li>
        </TermList>
      </>
    ),
  },
  {
    tabId: 'general',
    id: 'general-controls',
    title: 'Worker Group and time range',
    body: (
      <>
        <Eyebrow>Controls</Eyebrow>
        <SubHeading>Worker Group and time range</SubHeading>
        <Text as="p">
          The control bar at the top of the Signal Path, Flow Explorer, and Overview views establishes the scope
          for all information displayed below it. The <Term>Stream / Edge</Term> toggle at the far left decides
          which product's groups the selector beside it lists, and switches that selector's own vocabulary to
          match — <Term>Worker Group</Term> and <Term>Worker</Term> for Stream, <Term>Fleet</Term> and{' '}
          <Term>Node</Term> for Edge. The selector itself determines which group's configuration and metrics are
          shown; the Signal Path and Flow Explorer views also provide an <Term>All Worker Groups</Term> (or{' '}
          <Term>All Fleets</Term>) option, which merges the topology of every group in the selected product into a
          single combined view. The <Term>Time Range</Term> selector re-queries data live upon selection, rather
          than rescaling an existing chart.
        </Text>
        <Text as="p">
          The <Term>Events / Bytes</Term> toggle changes the unit of measurement for every headline figure and
          trend on the page. Signal Path has no page-level toggle — it shows Events only on the canvas and in
          card headlines, with Bytes available as a secondary figure on individual Source/Destination cards and
          in their own drawers.
        </Text>
      </>
    ),
  },
  {
    tabId: 'general',
    id: 'general-status',
    title: 'Status colors',
    body: (
      <>
        <Eyebrow>Status</Eyebrow>
        <SubHeading>Status colors</SubHeading>
        <div className="help-ref-table-wrap">
          <table className="help-ref-table">
            <tbody>
              <tr>
                <td className="help-ref-table-pill-cell">
                  <Pill appearance="success" FORCE__className="help-status-pill">
                    Healthy
                  </Pill>
                </td>
                <td>The component is receiving and sending data normally.</td>
              </tr>
              <tr>
                <td className="help-ref-table-pill-cell">
                  <Pill appearance="warning" FORCE__className="help-status-pill">
                    Degraded
                  </Pill>
                </td>
                <td>
                  Some, but not all, of the component's Worker (or Node, for Edge) processes report it as
                  blocked. Open the detail drawer to view the per-process breakdown.
                </td>
              </tr>
              <tr>
                <td className="help-ref-table-pill-cell">
                  <Pill appearance="danger" FORCE__className="help-status-pill">
                    Blocked
                  </Pill>
                </td>
                <td>Events are arriving but none are being forwarded. Investigate this component first.</td>
              </tr>
              <tr>
                <td className="help-ref-table-pill-cell">
                  <Pill FORCE__className="help-status-pill">No data</Pill>
                </td>
                <td>No activity was observed within the selected time range. Widen the time range before concluding that an issue exists.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </>
    ),
  },
  {
    tabId: 'general',
    id: 'general-accuracy',
    title: 'Recent configuration changes',
    body: (
      <>
        <Eyebrow>Results Accuracy</Eyebrow>
        <SubHeading>Recent configuration changes</SubHeading>
        <Alert appearance="info" layout="compact">
          Source-to-Destination paths reflect only configuration that has been committed and deployed in Cribl. An
          edit that has been saved but not yet deployed may not appear in the application as expected. Following
          deployment, a change may require a short interval before it takes effect. For a flow that has been
          recently modified, narrow the time range to <code>Last 15 minutes</code> to view current results.
          Selecting a wider time range may combine current and outdated data, producing an inconsistent
          representation of the flow.
        </Alert>
      </>
    ),
  },
  {
    tabId: 'general',
    id: 'general-filtering',
    title: 'The status filter',
    body: (
      <>
        <Eyebrow>Filtering</Eyebrow>
        <SubHeading>The status filter</SubHeading>
        <Text as="p">
          On Signal Path and Flow Explorer, the status filter — <Term>All, Enabled, Active, Unhealthy, and No
          Data</Term> — narrows every list and diagram on the page to matching components. <Term>Enabled</Term>
          matches components that are turned on in Cribl's own configuration, independent of whether any traffic
          has actually been observed. <Term>Active</Term> is the default selection on load and hides components
          with no observed data, which is typically preferable in a high-volume environment. The{' '}
          <Term>Unhealthy</Term> filter matches components in a Blocked or Degraded state, as a partial blockage
          remains relevant under this filter.
        </Text>
        <Text as="p">
          Overview does not use this shared filter — its Node Inventory panel has its own, more specific search
          box instead, since a fleet-wide status filter would narrow that one panel while leaving every other
          panel on the page unfiltered.
        </Text>
      </>
    ),
  },
  {
    tabId: 'general',
    id: 'general-preferences',
    title: 'Settings',
    body: (
      <>
        <Eyebrow>Preferences</Eyebrow>
        <SubHeading>Settings</SubHeading>
        <Text as="p">
          Theme, default Worker Group, default view, and auto-refresh interval are configured in Settings,
          accessible from the icon at the bottom of the sidebar. Settings opens as a panel adjacent to the sidebar;
          closing it returns you to your prior context without reloading or re-fetching data.
        </Text>
      </>
    ),
  },
];

const OVERVIEW_SECTIONS: HelpSection[] = [
  {
    tabId: 'overview',
    id: 'overview-intro',
    title: 'Introduction',
    body: (
      <Text as="p">
        The Overview view serves as the default landing page, presenting fleet-level Worker infrastructure
        rather than individual flows. Use this view to determine quickly whether any component within the
        selected scope requires attention, before proceeding to Signal Path or Flow Explorer for further detail.
      </Text>
    ),
  },
  {
    tabId: 'overview',
    id: 'overview-kpi',
    title: 'The KPI row',
    body: (
      <>
        <SubHeading>The KPI row</SubHeading>
        <Text as="p">
          Seven cards are displayed across the top of the view. License is the only card not scoped to the
          selected Worker Group or Fleet; license figures are reported at the organization level.
        </Text>
        <div className="help-ref-table-wrap">
          <table className="help-ref-table">
            <thead>
              <tr>
                <th>Card</th>
                <th>Shows</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <Term>License</Term>
                </td>
                <td>
                  Displays the daily ingest limit and expiry date, along with the number of days within the past 30
                  that exceeded quota. The expiry date is color-coded: green indicates more than six months remain,
                  orange indicates fewer than six months remain, and red indicates fewer than three months remain
                  or that the license has already expired.
                </td>
              </tr>
              <tr>
                <td>
                  <Term>Worker Groups / Workers</Term>
                </td>
                <td>
                  Displays counts for the current scope, including a healthy/needs-attention split for Workers.
                  These two cards read <Term>Fleets</Term> and <Term>Nodes</Term> instead when the top-left toggle
                  is set to Edge.
                </td>
              </tr>
              <tr>
                <td>
                  <Term>Active Flows / Volume In / Volume Out / Reduction</Term>
                </td>
                <td>Displays totals summed across every flow with observed volume within the selected window.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Text as="p" color="subtle">
          Active Flows, Volume In, Volume Out, and Reduction are selectable and navigate to Flow Explorer with the
          same scope applied. Worker Groups/Fleets and Workers/Nodes open the Cribl console in a new browser tab.
        </Text>
      </>
    ),
  },
  {
    tabId: 'overview',
    id: 'overview-alerts',
    title: 'Alert Feed',
    body: (
      <>
        <SubHeading>Alert Feed</SubHeading>
        <Text as="p">
          Displays a live list of Workers (or Nodes, for Edge) currently in a genuine problem state —
          disconnected, blocked, or under resource pressure — rather than a historical log. This is informational
          only; a row does not navigate anywhere, since the affected process's own alert does not always identify
          the specific Destination it relates to.
        </Text>
      </>
    ),
  },
  {
    tabId: 'overview',
    id: 'overview-matrix',
    title: 'Volume Matrix',
    body: (
      <>
        <SubHeading>Volume Matrix</SubHeading>
        <Text as="p">
          Presents a compact Source-by-Destination grid for the busiest pairs within scope. A dash indicates that
          the corresponding Source and Destination have not been paired within the selected window. Select a cell
          to navigate to Flow Explorer, filtered to that specific pair.
        </Text>
      </>
    ),
  },
  {
    tabId: 'overview',
    id: 'overview-ingest',
    title: 'Daily Ingest',
    body: (
      <>
        <SubHeading>Daily Ingest</SubHeading>
        <Text as="p">
          Displays the most recent 30 days, independent of the time range selected above. A day without a
          per-source breakdown is displayed as a solid bar: blue indicates the day remained within the license
          quota, and red indicates the quota was exceeded. A day with per-source data available is displayed as a
          stacked bar; hovering over a Source in the legend highlights that Source's segments and dims the
          remainder. Per-source data is available only for a short, recent timeframe, allowing for a quick review
          of how volume has recently split across Sources.
        </Text>
      </>
    ),
  },
  {
    tabId: 'overview',
    id: 'overview-inventory',
    title: 'Worker/Node Inventory',
    body: (
      <>
        <SubHeading>Worker/Node Inventory</SubHeading>
        <Text as="p">
          Displays one row per node — a Stream Worker process or an Edge Node, matching whichever product the
          top-left toggle currently has selected — including group, hostname, CPU, memory, and disk utilization as
          compact bars, uptime, the process count, inbound and outbound volume, a blocked-events count, and Cribl's
          own reported process status (for example, <Term>healthy</Term>). CPU, memory, disk, and uptime are read
          directly from that specific node, so they're real for Edge Nodes as well as Stream Workers. This status
          field is Cribl's own raw signal, not this application's derived Healthy/Degraded/Blocked judgment — the
          "Workers" card at the top of the page counts against this same signal, so the two always agree. The table
          is sortable and searchable using the box above it; it has no separate status filter of its own. Clicking a
          row opens a detail panel with the node's deployed configuration (including whether it's fallen behind the
          group's latest deploy), license limits, any node-reported messages, and — when available — a recent
          historical trend. This panel's own heading reads <Term>Worker Inventory</Term> for Stream and{' '}
          <Term>Node Inventory</Term> for Edge, matching the top-left toggle — the same convention "Worker
          Comparison"/"Node Comparison" below already uses.
        </Text>
      </>
    ),
  },
  {
    tabId: 'overview',
    id: 'overview-comparison',
    title: 'Worker Comparison',
    body: (
      <>
        <SubHeading>Worker Comparison</SubHeading>
        <Text as="p">
          Presents a bar-per-node comparison across five metrics, selectable using the control above the chart.
          A node whose value sits meaningfully above the remainder is displayed with a red bar, providing a quick
          method for identifying fleet imbalance without reviewing every value individually. This panel reads{' '}
          <Term>Node Comparison</Term> when the top-left toggle is set to Edge.
        </Text>
      </>
    ),
  },
];

const SIGNAL_PATH_SECTIONS: HelpSection[] = [
  {
    tabId: 'signalPath',
    id: 'signalpath-intro',
    title: 'Introduction',
    body: (
      <Text as="p">
        The Signal Path view displays the complete wiring diagram for a single Worker Group or Fleet, arranged
        left to right: Source, Pre-Processing, Routes, Pipeline, Post-Processing, and Destination. Use this view
        to verify precisely how a flow is configured, not only whether it is healthy.
      </Text>
    ),
  },
  {
    tabId: 'signalPath',
    id: 'signalpath-lanes',
    title: 'Reading the lanes',
    body: (
      <>
        <SubHeading>Reading the lanes</SubHeading>
        <Text as="p">
          Each lane provides its own search box, filtered independently; the filters, however, interact with one
          another. Narrowing Sources to a single name also hides every Pipeline, Route, and Destination that the
          Source does not reach, and the reverse applies in either direction.
        </Text>
        <Text as="p">
          A line's color reflects whether real traffic is currently observed flowing across that specific
          connection, not a health judgment — a disabled connection is shown faded and dashed. A line highlights
          when either endpoint is hovered over or selected, and its entire connected path — every card and line
          sharing that same real, attributed Source — highlights accordingly, not only the segment beneath the
          cursor.
        </Text>
      </>
    ),
  },
  {
    tabId: 'signalPath',
    id: 'signalpath-routes',
    title: 'The Routes card',
    body: (
      <>
        <SubHeading>The Routes card</SubHeading>
        <Text as="p">
          Rules are listed in actual evaluation order, each displayed with its own status border. A{' '}
          <Term>Final</Term> tag indicates a rule that halts evaluation for anything it matches. The built-in
          catch-all <Term>endRoute</Term> row is displayed at the bottom, indicating where Cribl's own implicit
          fallback directs events not claimed by any rule.
        </Text>
      </>
    ),
  },
  {
    tabId: 'signalPath',
    id: 'signalpath-component',
    title: 'Opening a component',
    body: (
      <>
        <SubHeading>Opening a component</SubHeading>
        <Text as="p">Select any card to open its detail drawer.</Text>
        <TermList>
          <li>
            <Term>Volume</Term> — Real, independently-measured In/Out totals for the component (Events and
            Bytes, where both are available).
          </li>
          <li>
            <Term>Trend</Term> — Displays a time series for the selected window.
          </li>
          <li>
            <Term>Sources</Term> — Displays every Source that passed through this component within the selected
            window, along with its volume, pipeline, and most recent ingest time.
          </li>
          <li>
            <Term>Per-Worker Status</Term> — Applicable to Sources and Destinations only. Displays the actual
            per-connector status reported by Cribl for each Worker (or Node, for Edge) process, including the
            specific connection error when one exists.
          </li>
        </TermList>
      </>
    ),
  },
  {
    tabId: 'signalPath',
    id: 'signalpath-capture',
    title: 'Live Capture',
    body: (
      <>
        <SubHeading>Live Capture</SubHeading>
        <Text as="p">
          Select the capture icon at the end of any connecting line to sample events at that exact point: before
          Pre-Processing, before Routes, before Post-Processing, or before the Destination. The filter field is
          pre-populated using the Sources known to reach that point.
        </Text>
      </>
    ),
  },
];

const FLOW_EXPLORER_SECTIONS: HelpSection[] = [
  {
    tabId: 'flowExplorer',
    id: 'flowexplorer-intro',
    title: 'Introduction',
    body: (
      <Text as="p">
        The Flow Explorer view presents one row per Source-to-Destination pair across the entire selected scope.
        Use this view, rather than Signal Path, when scanning, sorting, or searching multiple flows at once is
        required, rather than tracing the configuration of a single flow.
      </Text>
    ),
  },
  {
    tabId: 'flowExplorer',
    id: 'flowexplorer-table',
    title: 'The table',
    body: (
      <>
        <SubHeading>The table</SubHeading>
        <TermList>
          <li>
            <Term>Flow</Term> — Displays the Source-to-Destination pair, with the Pipeline it routes through
            indicated beneath.
          </li>
          <li>
            <Term>Count</Term> — Indicates how many distinct Route rules contribute to this pair.
          </li>
          <li>
            <Term>Path</Term> — Displays a compact glyph representing the stage count for this flow.
          </li>
          <li>
            <Term>Trend</Term> — Displays a per-row sparkline for the selected window.
          </li>
          <li>
            <Term>In / Out / Reduction</Term> — Displays volume and the resulting reduction; only an increase is
            flagged.
          </li>
        </TermList>
        <Text as="p" color="subtle">
          Select a column header to sort by that column; the default order presents the worst-performing flows
          first. The search box filters by Source or Destination name; <Term>Expand all</Term> opens the resolved
          chain for every row simultaneously.
        </Text>
      </>
    ),
  },
  {
    tabId: 'flowExplorer',
    id: 'flowexplorer-expand',
    title: 'Expanding a row',
    body: (
      <>
        <SubHeading>Expanding a row</SubHeading>
        <Text as="p">
          Each expanded row displays the resolved chain from Source through Destination, with every stage colored
          according to its actual status, accompanied by a plain-language caption describing the current
          condition. A row supported by more than one Route rule expands into a separate chain for each
          contributing rule.
        </Text>
      </>
    ),
  },
];

const ABOUT_SECTIONS: HelpSection[] = [
  {
    tabId: 'about',
    id: 'about-summary',
    title: 'What this app does',
    body: (
      <>
        <SubHeading>What this app does</SubHeading>
        <Text as="p">
          Data Flow Monitor for Cribl is a single pane of glass for Cribl Stream data flows, end to end — from
          Source through every middle stage to Destination. It answers two questions: whether a given flow exists
          and is configured the way you expect, and, when it isn't behaving as expected, exactly where events are
          being dropped, blocked, or failing to arrive. The three views on the left cover both: Overview for a
          fleet-wide health check (including license entitlement and daily ingest), and Signal Path and Flow
          Explorer for tracing or comparing individual flows.
        </Text>
      </>
    ),
  },
  {
    tabId: 'about',
    id: 'about-version',
    title: 'Version',
    body: (
      <>
        <SubHeading>Version</SubHeading>
        <Text as="p">
          This is Data Flow Monitor for Cribl <Term>v{__APP_VERSION__}</Term>.
        </Text>
      </>
    ),
  },
  {
    tabId: 'about',
    id: 'about-maker',
    title: 'Discovered Intelligence',
    body: (
      <>
        <SubHeading>Discovered Intelligence</SubHeading>
        <Text as="p">
          Data Flow Monitor for Cribl is built by Discovered Intelligence.
        </Text>
        <Text as="p">
          <a href="https://discoveredintelligence.com" target="_blank" rel="noopener noreferrer">
            discoveredintelligence.com
          </a>
        </Text>
      </>
    ),
  },
  {
    tabId: 'about',
    id: 'about-license',
    title: 'License',
    body: (
      <>
        <SubHeading>License</SubHeading>
        <Text as="p">
          Data Flow Monitor for Cribl is released under the <Term>Apache License 2.0</Term>. The full license
          text is included with the application and is also available at{' '}
          <a href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noopener noreferrer">
            apache.org/licenses/LICENSE-2.0
          </a>
          .
        </Text>
      </>
    ),
  },
];

const HELP_SECTIONS: HelpSection[] = [
  ...GENERAL_SECTIONS,
  ...OVERVIEW_SECTIONS,
  ...SIGNAL_PATH_SECTIONS,
  ...FLOW_EXPLORER_SECTIONS,
  ...ABOUT_SECTIONS,
];

/** Walks a section's own `body` JSX collecting every plain-text string it renders, regardless of
 *  which Capra component or plain element wraps it — `Text`, `Pill`, `Alert`, a bare `<table>`,
 *  `<code>`, `TermList`'s `<b>` terms, all decompose into `props.children` the same way, so one
 *  generic recursion covers the whole mixed component tree with no per-component-type branching.
 *  Deriving the search corpus straight from this same tree (rather than a hand-typed second copy
 *  of every section's own text) is what guarantees search can never silently drift from what's
 *  actually rendered. */
function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join(' ');
  if (isValidElement(node)) return extractText((node.props as { children?: ReactNode }).children);
  return '';
}

const SNIPPET_LENGTH = 140;

/** A short excerpt of a section's own body text, centered on the first matching search token when
 *  one is found in the body (not just the title) — gives a result some context beyond its heading
 *  without requiring the reader to open the tab first. */
function buildSnippet(bodyText: string, tokens: string[]): string {
  const lower = bodyText.toLowerCase();
  let matchIndex = -1;
  for (const token of tokens) {
    const i = lower.indexOf(token);
    if (i !== -1 && (matchIndex === -1 || i < matchIndex)) matchIndex = i;
  }
  if (matchIndex === -1) {
    return bodyText.length > SNIPPET_LENGTH ? `${bodyText.slice(0, SNIPPET_LENGTH).trim()}…` : bodyText;
  }
  const start = Math.max(0, matchIndex - 40);
  const end = Math.min(bodyText.length, start + SNIPPET_LENGTH);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < bodyText.length ? '…' : '';
  return `${prefix}${bodyText.slice(start, end).trim()}${suffix}`;
}

/** Precomputed once at module load, not per keystroke — every one of these ~20 sections' own text
 *  is static, so there's nothing to recompute on every render. `haystack` (title + body, lowercased)
 *  is what an actual query is matched against; `bodyText` (original case) is kept separately so a
 *  result's own displayed snippet doesn't render in all-lowercase. */
const HELP_SEARCH_INDEX = HELP_SECTIONS.map((section) => {
  const bodyText = extractText(section.body).replace(/\s+/g, ' ').trim();
  return {
    ...section,
    bodyText,
    haystack: `${section.title} ${bodyText}`.toLowerCase(),
  };
});

type SearchResult = (typeof HELP_SEARCH_INDEX)[number] & { snippet: string };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Rebuilds a section's own `body` tree with every occurrence of any given search token wrapped in
 *  a `<mark>`, so a reader landing on a jumped-to section can see exactly *where* their search term
 *  appears, not just that the section as a whole matched. Walks the same shape `extractText` above
 *  already does (strings/arrays/elements) but produces a new tree instead of a flattened string;
 *  `cloneElement` preserves every original prop and only swaps in the transformed children, so
 *  nothing about how a `Text`/`Pill`/`<table>` cell etc. renders otherwise changes. */
function highlightNode(node: ReactNode, tokens: string[], keyPrefix = 'h'): ReactNode {
  if (tokens.length === 0) return node;
  if (typeof node === 'string') return highlightString(node, tokens, keyPrefix);
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'number') return node;
  if (Array.isArray(node)) {
    return node.map((child, i) => <Fragment key={`${keyPrefix}-${i}`}>{highlightNode(child, tokens, `${keyPrefix}-${i}`)}</Fragment>);
  }
  if (isValidElement(node)) {
    const children = (node.props as { children?: ReactNode }).children;
    if (children === undefined) return node;
    return cloneElement(node, undefined, highlightNode(children, tokens, keyPrefix));
  }
  return node;
}

/** `text.split(re)` with one capturing group interleaves the matched substrings at the odd indices
 *  (`["before", "match", "between", "match", "after"]`) — a deterministic property of `split` itself,
 *  not something that needs a second, stateful `re.test()` pass (which would have its own `lastIndex`
 *  correctness pitfall on a global regex) to tell matches apart from plain text. */
function highlightString(text: string, tokens: string[], keyPrefix: string): ReactNode {
  const escaped = tokens.map(escapeRegExp).filter(Boolean);
  if (escaped.length === 0) return text;
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(re);
  if (parts.length <= 1) return text;
  return parts.map((part, i) => (i % 2 === 1 ? <mark key={`${keyPrefix}-${i}`} className="help-search-match">{part}</mark> : part));
}

function renderTabSections(tabId: HelpTab, highlightedSectionId: string | null, highlightTokens: string[]) {
  return (
    <>
      {HELP_SECTIONS.filter((s) => s.tabId === tabId).map((s) => (
        <section key={s.id} id={s.id}>
          {s.id === highlightedSectionId ? highlightNode(s.body, highlightTokens) : s.body}
        </section>
      ))}
    </>
  );
}

/**
 * Owns every piece of Help's own state — which tab is active, the free-text search query/results,
 * and the pending "jump to this section and highlight these terms" request a search selection
 * creates — so that it can be shared between two components rendered in two different places in the
 * Drawer (`App.tsx`'s own header, where the search box itself now lives per direct request, and
 * this file's `HelpPanel`, the scrolling body below it) without either needing to know about the
 * other. Called once, unconditionally, from `AppShell` (harmless when Help isn't even open — every
 * ref stays unattached and every effect below is a no-op until it is) and threaded down as a single
 * `search` prop to both `HelpSearchBox` and `HelpPanel`.
 */
export function useHelpSearch() {
  const [activeTab, setActiveTabState] = useState<HelpTab>('general');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<{ tabId: HelpTab; sectionId: string } | null>(null);
  const [highlightedSectionId, setHighlightedSectionId] = useState<string | null>(null);
  const [highlightTokens, setHighlightTokens] = useState<string[]>([]);
  const [stickyHeight, setStickyHeight] = useState(0);
  // A *callback* ref, not a plain `useRef` — this hook is called once, at `AppShell`'s own mount,
  // long before Help's sticky tab strip first exists in the DOM (it mounts/unmounts every time the
  // Help drawer opens/closes). A plain `useRef` paired with an effect keyed on `[]` would only ever
  // check `.current` once, at that first (too-early) mount, and never again — the exact bug this
  // project already found and fixed once for `TrendChart.tsx`'s own container ref (see CLAUDE.md).
  // A callback ref instead fires every time React actually attaches or detaches the real node,
  // independent of which render that happens on.
  const [stickyEl, setStickyEl] = useState<HTMLDivElement | null>(null);
  const stickyRef = useCallback((el: HTMLDivElement | null) => setStickyEl(el), []);

  const searchContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Measured live, not guessed — the sticky header's own real height changes with viewport width
  // (the tab strip wraps to a second row below ~560px) and would otherwise make a fixed
  // `scroll-margin-top` guess wrong for some widths/themes, leaving a jumped-to section either
  // still hidden behind the frozen header or offset by more empty space than it needs.
  useEffect(() => {
    if (!stickyEl || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setStickyHeight(entry.contentRect.height));
    observer.observe(stickyEl);
    return () => observer.disconnect();
  }, [stickyEl]);

  // Runs once the target tab's own content is actually mounted (switching `activeTab` and setting
  // `scrollTarget` happen in the same click handler, but the new tab's sections aren't in the DOM
  // until after that state change commits) — an effect keyed on both is what guarantees the lookup
  // below only ever runs against a panel that's really showing the right tab. `panelRef` itself is
  // safe as a plain `useRef` here (unlike `stickyRef` above): this effect only ever does anything
  // once `scrollTarget` is set, which only ever happens from a click inside `HelpSearchBox` — and
  // that can only render while `HelpPanel` (and therefore `panelRef`'s real node) is already mounted
  // too, since both only exist while the Help drawer itself is open.
  useEffect(() => {
    if (!scrollTarget || scrollTarget.tabId !== activeTab) return;
    const el = panelRef.current?.querySelector<HTMLElement>(`#${CSS.escape(scrollTarget.sectionId)}`);
    setScrollTarget(null);
    if (!el) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    el.classList.add('help-section-highlight');
    const timer = setTimeout(() => el.classList.remove('help-section-highlight'), 1200);
    return () => clearTimeout(timer);
  }, [activeTab, scrollTarget]);

  const trimmedQuery = searchQuery.trim();
  const queryTokens = useMemo(() => trimmedQuery.toLowerCase().split(/\s+/).filter(Boolean), [trimmedQuery]);
  const searchResults = useMemo<SearchResult[]>(() => {
    if (queryTokens.length === 0) return [];
    return HELP_SEARCH_INDEX.filter((s) => queryTokens.every((t) => s.haystack.includes(t)))
      .slice(0, 8)
      .map((s) => ({ ...s, snippet: buildSnippet(s.bodyText, queryTokens) }));
  }, [queryTokens]);

  const dropdownOpen = searchFocused && trimmedQuery !== '';

  // A manual tab click clears any earlier search-driven text highlight — it's tied to the specific
  // section a search jumped to, and no longer means anything once the reader has navigated away
  // from it on their own. A jump *to* a different section via search (`selectResult`, below) always
  // overwrites it with its own fresh target regardless, so this only matters for the "navigated away
  // and might come back later" case.
  function handleTabClick(tab: HelpTab) {
    setActiveTabState(tab);
    setHighlightedSectionId(null);
    setHighlightTokens([]);
  }

  function selectResult(tabId: HelpTab, sectionId: string) {
    setActiveTabState(tabId);
    setScrollTarget({ tabId, sectionId });
    setHighlightedSectionId(sectionId);
    setHighlightTokens(queryTokens);
    setSearchQuery('');
    setSearchFocused(false);
    searchInputRef.current?.blur();
  }

  // Deliberately no Escape handling here — matching this app's own established search-box
  // convention (Flow Explorer's identical search field has none either; clearing is the explicit
  // "x" button's job only). Escape is reserved for the Drawer's own always-available close
  // behavior (see App.tsx's own doc comment on that) — Capra's Drawer listens for it on a
  // *capture-phase* document listener, which fires before this input's own bubble-phase handler
  // ever could, so trying to intercept it here to just clear the query would be both inconsistent
  // with the rest of the app and unreliable in practice.
  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && searchResults.length > 0) {
      selectResult(searchResults[0].tabId, searchResults[0].id);
    }
  }

  return {
    activeTab,
    handleTabClick,
    searchQuery,
    setSearchQuery,
    searchFocused,
    setSearchFocused,
    searchResults,
    dropdownOpen,
    selectResult,
    handleSearchKeyDown,
    searchContainerRef,
    searchInputRef,
    stickyRef,
    stickyHeight,
    panelRef,
    highlightedSectionId,
    highlightTokens,
  };
}

export type HelpSearchController = ReturnType<typeof useHelpSearch>;

/**
 * The free-text search box itself — rendered by `App.tsx` in the Drawer's own real header, between
 * the "Help" title and the pin/close icons, per direct request (previously part of this file's own
 * sticky tab strip, inside the scrolling body). Purely presentational: every piece of state and
 * every handler comes from the shared `search` controller (`useHelpSearch`, above).
 *
 * Search is tab-agnostic by design: it matches against every tab's own sections at once
 * (`HELP_SEARCH_INDEX`, built from all five tabs), not just whichever tab happens to be open —
 * selecting a result switches to that section's own tab, scrolls straight to it, and highlights
 * every occurrence of the searched word(s) within it, so a reader never has to first guess which tab
 * holds the answer, or hunt for the match once they land on the right section.
 */
export function HelpSearchBox({ search }: { search: HelpSearchController }) {
  return (
    <div
      className="help-search"
      ref={search.searchContainerRef}
      onBlur={(e) => {
        if (!search.searchContainerRef.current?.contains(e.relatedTarget as Node | null)) search.setSearchFocused(false);
      }}
    >
      <div className="help-search-field">
        <Search />
        <input
          ref={search.searchInputRef}
          type="text"
          placeholder="Search help topics…"
          value={search.searchQuery}
          onChange={(e) => search.setSearchQuery(e.target.value)}
          onFocus={() => search.setSearchFocused(true)}
          onKeyDown={search.handleSearchKeyDown}
          aria-label="Search help topics across every tab"
        />
        {search.searchQuery !== '' && (
          <button
            type="button"
            className="help-search-clear"
            aria-label="Clear search"
            onClick={() => {
              search.setSearchQuery('');
              search.searchInputRef.current?.focus();
            }}
          >
            <CloseOutlined />
          </button>
        )}
      </div>

      {search.dropdownOpen && (
        <div className="help-search-results" role="region" aria-label="Search results">
          {search.searchResults.length === 0 ? (
            <div className="help-search-empty">
              <Text as="span" variant="body-sm-normal" color="subtle">
                No matching topics.
              </Text>
            </div>
          ) : (
            search.searchResults.map((r) => (
              <button key={r.id} type="button" className="help-search-result" onClick={() => search.selectResult(r.tabId, r.id)}>
                <span className="help-search-result-heading">
                  <Text as="span" variant="body-xs-semibold" color="accent">
                    {TAB_LABEL_BY_ID[r.tabId]}
                  </Text>
                  <Text as="span" variant="body-sm-semibold">
                    {r.title}
                  </Text>
                </span>
                {r.snippet && (
                  <Text as="span" variant="body-xs-normal" color="subtle">
                    {r.snippet}
                  </Text>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Help content only — no page chrome of its own (`App.tsx`'s own `<Drawer>` supplies the
 * title/close control, and now the search box too — see `HelpSearchBox` above). Tabbed per view
 * (plus a General tab for cross-cutting concepts), matching the reviewed documentation mockup —
 * condensed for the drawer's own ~560px width rather than the mockup's full-page layout, and
 * text-only (no embedded screenshots, which belonged to the pitch artifact, not shipped help
 * content).
 *
 * The tab strip lives in a `position: sticky` header (`.help-sticky-header`) pinned to the top of
 * the Drawer's own scrolling body — a navigation control a reader needs reachable regardless of how
 * far they've scrolled down a long tab's content, not just at the very top of the panel.
 */
export function HelpPanel({ search }: { search: HelpSearchController }) {
  const panelStyle = { '--help-sticky-offset': `${search.stickyHeight}px` } as CSSProperties;

  return (
    <div className="help-panel-body" style={panelStyle}>
      <div className="help-sticky-header" ref={search.stickyRef}>
        <div className="help-tablist" role="tablist" aria-label="Help topics">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`help-tab-${tab.id}`}
              aria-selected={search.activeTab === tab.id}
              aria-controls={`help-tabpanel-${tab.id}`}
              className={search.activeTab === tab.id ? 'help-tab help-tab--active' : 'help-tab'}
              onClick={() => search.handleTabClick(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div
        className="help-tabpanel"
        role="tabpanel"
        id={`help-tabpanel-${search.activeTab}`}
        aria-labelledby={`help-tab-${search.activeTab}`}
        tabIndex={0}
        ref={search.panelRef}
      >
        {renderTabSections(search.activeTab, search.highlightedSectionId, search.highlightTokens)}
      </div>
    </div>
  );
}
