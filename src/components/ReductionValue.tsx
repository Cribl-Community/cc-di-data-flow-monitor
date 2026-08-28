import { computeReduction } from '../lib/reduction';
import './ReductionValue.css';

interface ReductionValueProps {
  inValue: number;
  outValue: number;
  /** 'sm' is the subordinate-detail treatment (e.g. Flow Explorer's individual-flow breakdown) —
   *  visibly smaller than the default 'md'. 'lg' matches a toolbar/summary chicklet's own
   *  `metric-sm` typography (`ReductionValue` renders a plain `<span>`, not a `Text`, so it has no
   *  variant prop of its own to reach for). */
  size?: 'md' | 'sm' | 'lg';
}

const ARROW: Record<ReturnType<typeof computeReduction>['direction'], string> = {
  down: '▼',
  up: '▲',
  flat: '→',
};

// "up" is the one direction worth a second look, so it's the only one that gets an explanatory
// tooltip — a real, honest cause here (never a guess): Cribl-side send retries counted as extra
// sends, or a Pipeline function that fans one event into several, both make real out exceed real
// in.
const UP_TITLE =
  'Output exceeded input. This can reflect destination-side send retries, or a Pipeline function ' +
  'that fans one event into several — not necessarily a problem.';

/**
 * Volume reduction as an arrow + signed percent — shared across every page that shows an in/out
 * comparison (originally Flow Explorer's own "Reduction" column; now also Signal Path's NodeCards
 * and the node detail drawer, replacing their old separate "Dropped"/"Ratio" figures — see
 * CLAUDE.md for why: a reduced output isn't itself a health problem, Cribl trimming volume before
 * a Destination is often the intended, expected behavior). "down" (the normal case) and "flat"
 * read no differently in color; only "up" (output exceeding input, genuinely unusual) gets a
 * warning tint *and* its natural negative sign shown alongside the arrow (e.g. "▲ -5%"), since
 * that's the one direction actually worth a second look. `Math.round` rather than `pct.toFixed(0)`
 * specifically — `toFixed` renders small negative values that round to zero as the string "-0",
 * which `Math.round` + template-literal coercion doesn't (JS normalizes -0 to "0" on implicit
 * string conversion), so a barely-negative value doesn't display a confusing "-0%".
 */
export function ReductionValue({ inValue, outValue, size = 'md' }: ReductionValueProps) {
  const { pct, direction } = computeReduction(inValue, outValue);
  return (
    <span className={`reduction-value reduction-value--${direction} reduction-value--${size}`} title={direction === 'up' ? UP_TITLE : undefined}>
      {ARROW[direction]} {Math.round(pct)}%
    </span>
  );
}
