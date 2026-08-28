import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { FlowGraph, VolumeUnit } from '../../lib/types';
import './TopSourcesByVolumePanel.css';

interface TopSourcesByVolumePanelProps {
  flowGraph: FlowGraph | undefined;
  unit: VolumeUnit;
  /** A populated cell's own drilldown — pivots to Flow Explorer pinned to exactly that Source ->
   *  Destination pair, so the flow list underneath the number being looked at is one click away. */
  onCellDrilldown: (sourceLabel: string, destinationLabel: string) => void;
}

interface Cell {
  in: number;
  out: number;
}

const MAX_SOURCES = 8;
const MAX_DEST_FULL = 5;
const MAX_DEST_FALLBACK = 3;

const EVENT_UNITS = ['', 'K', 'M', 'B'];
// Two-character byte-scale suffixes, matching `lib/format.ts`'s own app-wide `BYTE_UNITS`.
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** A fixed-decimal-place sibling of `formatMetric`/`scale` (`lib/format.ts`) for this panel only.
 *  That shared helper deliberately varies its own precision by magnitude (0/1/2 places) — right
 *  for one standalone number, but wrong for a grid where every cell needs the *same* number of
 *  decimals to actually line up. A raw (unscaled) value stays a whole number — fractional events/
 *  bytes below the first scale step aren't meaningful — every scaled value always shows exactly
 *  one decimal place. */
function scaleFixed(value: number, base: number, units: string[]): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  let v = Math.abs(value);
  let i = 0;
  while (v >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  return `${sign}${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

function formatMetricFixed(value: number, unit: VolumeUnit): string {
  return unit === 'bytes' ? scaleFixed(value, 1024, BYTE_UNITS) : scaleFixed(value, 1000, EVENT_UNITS);
}

/** 0 (no data) / 1 (low) / 2 (mid) / 3 (high) — a fixed number of shading steps rather than a
 *  continuously-scaled opacity. A previous round of this app (Flow Matrix's own chicklet cells)
 *  found live that scaling a tinted background's *opacity* continuously under plain text eventually
 *  fails WCAG contrast at the low end, since there's no floor stopping it from approaching the
 *  panel's own background. Discrete steps built from Capra's own accent wash ramp
 *  (`subtle`/`default`/`hover`/`selected` — tokens explicitly designed to sit under default-colored
 *  text, unlike a `.solid` fill) sidestep that: verified live (see CLAUDE.md) that every step keeps
 *  real text on top comfortably AA-compliant in both themes. */
function shadeStep(value: number, max: number): 0 | 1 | 2 | 3 {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio > 0.66) return 3;
  if (ratio > 0.33) return 2;
  return 1;
}

/**
 * A Source x Destination matrix — real input/output volume for every pair actually observed this
 * window, from the exact same `graph.flowSummaries` every other Overview KPI and Flow Explorer
 * itself already reads (no second, lighter aggregation). Rows are the top sources by their own
 * total volume (in + out, summed across every destination they reach), capped at `MAX_SOURCES` so
 * this stays a glanceable panel rather than growing without bound. Columns are the top
 * destinations those sources reach, ranked the same way (by total volume) — up to
 * `MAX_DEST_FULL`, or `MAX_DEST_FALLBACK` on a narrower panel that can't comfortably fit that many
 * (measured live against the panel's own real rendered width, not guessed from a fixed breakpoint
 * — see the `useLayoutEffect` below).
 */
export function TopSourcesByVolumePanel({ flowGraph, unit, onCellDrilldown }: TopSourcesByVolumePanelProps) {
  const { sources, rankedDestinations, cellFor } = useMemo(() => {
    const nodesById = new Map((flowGraph?.nodes ?? []).map((n) => [n.id, n]));
    const bySource = new Map<string, Map<string, Cell>>();
    const sourceIdByLabel = new Map<string, string>();
    const sourceOutTotal = new Map<string, number>();
    const destTotal = new Map<string, number>();

    for (const s of flowGraph?.flowSummaries ?? []) {
      const inV = unit === 'events' ? s.inEvents : s.inBytes;
      // `outEvents`/`outBytes` are already corrected at the source (`buildFlowGraph`, `lib/
      // topology.ts`) for a genuinely stuck Destination — real per-worker status, not a guess —
      // so this panel doesn't need its own separate correction anymore.
      const outV = unit === 'events' ? s.outEvents : s.outBytes;
      if (inV <= 0 && outV <= 0) continue;

      let row = bySource.get(s.sourceLabel);
      if (!row) {
        row = new Map();
        bySource.set(s.sourceLabel, row);
      }
      row.set(s.destinationLabel, { in: inV, out: outV });
      sourceIdByLabel.set(s.sourceLabel, s.sourceId);
      sourceOutTotal.set(s.sourceLabel, (sourceOutTotal.get(s.sourceLabel) ?? 0) + outV);
      destTotal.set(s.destinationLabel, (destTotal.get(s.destinationLabel) ?? 0) + inV + outV);
    }

    // Ranking score per Source: its own canonical IN (`node.metrics`, counted once — never
    // re-summed per destination pairing, which would double-count a Source fanning out to more
    // than one Destination) plus its real OUT summed across every destination it reaches
    // (legitimate — each pairing is a distinct, real delivery, not a duplicate of the same one).
    const sourceTotal = new Map<string, number>();
    for (const [label, sourceId] of sourceIdByLabel) {
      const node = nodesById.get(sourceId);
      const inOnce = node ? (unit === 'events' ? (node.metrics.inEvents ?? 0) : (node.metrics.inBytes ?? 0)) : 0;
      sourceTotal.set(label, inOnce + (sourceOutTotal.get(label) ?? 0));
    }

    const topSources = [...sourceTotal.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SOURCES)
      .map(([label]) => label);
    const topSourceSet = new Set(topSources);

    // Only rank destinations by the volume they actually receive from the *shown* sources — a
    // destination fed only by a source that didn't make the top-8 cut shouldn't out-rank one that
    // genuinely pairs with what's on screen.
    const destTotalAmongShown = new Map<string, number>();
    for (const src of topSources) {
      for (const [dest, cell] of bySource.get(src) ?? []) {
        destTotalAmongShown.set(dest, (destTotalAmongShown.get(dest) ?? 0) + cell.in + cell.out);
      }
    }
    const rankedDestinations = [...destTotalAmongShown.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);

    return {
      sources: topSources,
      rankedDestinations,
      cellFor: (src: string, dest: string) => (topSourceSet.has(src) ? bySource.get(src)?.get(dest) : undefined),
    };
  }, [flowGraph, unit]);

  // Try `MAX_DEST_FULL` destination columns first; if the table actually overflows the panel's
  // own real width once rendered, fall back to `MAX_DEST_FALLBACK` — measured against the live
  // DOM (`scrollWidth` vs. the scroll container's `clientWidth`), not a guessed pixel breakpoint,
  // since how much a destination name/volume figure actually takes up varies with real data.
  //
  // The "retry full" trigger (a real resize, or sibling panels' async data shifting this panel's
  // own width via the shared grid's `1fr` tracks) and the "measure and maybe fall back" decision
  // used to live in two independent effects — a `ResizeObserver` blindly resetting `destCap` back
  // to `MAX_DEST_FULL` on *any* fire (including its own unconditional initial observation), and a
  // separate `useLayoutEffect` measuring and falling back. Those two raced: the ResizeObserver's
  // reset could land *after* the layout effect had already fallen back for this same render pass,
  // permanently overriding it — confirmed live, this consistently left the panel stuck at
  // `MAX_DEST_FULL`, silently clipping an overflowing last column with no way to reach it (the
  // scroll container's own `overflow-x: auto` never got a chance to matter, since nothing ever
  // told it the content was actually too wide). Merged into one effect: `resizeGen` is bumped by
  // the ResizeObserver purely as a "please re-attempt" signal, and `lastMeasuredGen` tracks
  // whether *this* effect run is the first response to a given bump — only that first response
  // retries `MAX_DEST_FULL` (returning early so the very next run, triggered by `destCap` itself
  // changing, does the real measurement); every other run just measures and settles, so a
  // successful fallback can never be undone by a stale reset racing in behind it.
  const [destCap, setDestCap] = useState(MAX_DEST_FULL);
  const [resizeGen, setResizeGen] = useState(0);
  const lastMeasuredGen = useRef(-1);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  useEffect(() => {
    const bodyEl = bodyRef.current;
    if (!bodyEl) return;
    const ro = new ResizeObserver(() => setResizeGen((g) => g + 1));
    ro.observe(bodyEl);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const bodyEl = bodyRef.current;
    const tableEl = tableRef.current;
    if (!bodyEl || !tableEl) return;

    if (lastMeasuredGen.current !== resizeGen) {
      lastMeasuredGen.current = resizeGen;
      if (destCap !== MAX_DEST_FULL) {
        setDestCap(MAX_DEST_FULL);
        return;
      }
    }

    if (destCap === MAX_DEST_FULL && tableEl.scrollWidth > bodyEl.clientWidth + 1) {
      setDestCap(MAX_DEST_FALLBACK);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-measure whenever the rendered data (not just destCap/resizeGen) changes.
  }, [destCap, resizeGen, rankedDestinations, sources]);

  const destinations = rankedDestinations.slice(0, destCap);
  const maxCell = useMemo(() => {
    let max = 0;
    for (const src of sources) {
      for (const dest of destinations) {
        const cell = cellFor(src, dest);
        if (cell) max = Math.max(max, cell.in + cell.out);
      }
    }
    return max;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `cellFor` closes over the same memoized data `sources`/`destinations` already key off.
  }, [sources, destinations]);

  // Every cell's "in"/"out" figure is pinned to the *same* character width (the longest formatted
  // value actually on screen, not a guessed constant) so the "/" separator lands at an identical
  // offset in every cell, in every row and column — not just self-consistent within one cell's own
  // pair of numbers.
  const { maxInLen, maxOutLen } = useMemo(() => {
    let maxIn = 0;
    let maxOut = 0;
    for (const src of sources) {
      for (const dest of destinations) {
        const cell = cellFor(src, dest);
        if (!cell) continue;
        maxIn = Math.max(maxIn, formatMetricFixed(cell.in, unit).length);
        maxOut = Math.max(maxOut, formatMetricFixed(cell.out, unit).length);
      }
    }
    return { maxInLen: maxIn, maxOutLen: maxOut };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `cellFor` closes over the same memoized data `sources`/`destinations` already key off.
  }, [sources, destinations, unit]);

  const svmStyle = { '--ov-svm-in-w': maxInLen, '--ov-svm-out-w': maxOutLen } as CSSProperties;

  return (
    <div className="ov-panel">
      <div className="ov-panel-head">
        <span className="ov-panel-title">
          Volume Matrix <span className="ov-panel-count">({sources.length})</span>
        </span>
        <span className="ov-panel-static-action">in / out</span>
      </div>
      <div className="ov-panel-body ov-svm-scroll" ref={bodyRef} style={svmStyle}>
        {sources.length === 0 ? (
          <div className="ov-svm-empty">No observed volume in this scope yet.</div>
        ) : (
          <table className="ov-svm-table" ref={tableRef}>
            <thead>
              <tr>
                <th className="ov-svm-corner">Source ↓ / Dest →</th>
                {destinations.map((dest) => (
                  <th key={dest} className="ov-svm-col-head" title={dest}>
                    {dest}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources.map((src) => (
                <tr key={src}>
                  <th className="ov-svm-row-head" title={src}>
                    {src}
                  </th>
                  {destinations.map((dest) => {
                    const cell = cellFor(src, dest);
                    const step = cell ? shadeStep(cell.in + cell.out, maxCell) : 0;
                    return (
                      <td key={dest} className="ov-svm-cell">
                        {cell ? (
                          <button
                            type="button"
                            className={`ov-svm-chip ov-svm-chip--${step} ov-svm-chip--clickable`}
                            onClick={() => onCellDrilldown(src, dest)}
                            title={`View ${src} → ${dest} in Flow Explorer`}
                            aria-label={`View ${src} to ${dest} flows in Flow Explorer — ${formatMetricFixed(cell.in, unit)} in, ${formatMetricFixed(cell.out, unit)} out`}
                          >
                            <span className="ov-svm-in">{formatMetricFixed(cell.in, unit)}</span>
                            <span className="ov-svm-sep">/</span>
                            <span className="ov-svm-out">{formatMetricFixed(cell.out, unit)}</span>
                          </button>
                        ) : (
                          <div className="ov-svm-chip ov-svm-chip--0">
                            <span className="ov-svm-dash">—</span>
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
