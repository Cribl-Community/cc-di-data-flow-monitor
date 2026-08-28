export interface ReductionInfo {
  /** Signed: positive = a real reduction (output smaller than input), negative = an increase
   *  (output larger than input) — carries its own sign now rather than always being non-negative
   *  with `direction` as a separate flag, so every consumer (display, sort, the Top 10 focus) can
   *  just use this one number directly instead of re-deriving a sign from `direction` each time. */
  pct: number;
  /** "down" = output smaller than input (Cribl trimming volume before the destination — expected,
   *  not a problem). "up" = output larger than input (unusual; flagged, not fabricated a cause
   *  for). "flat" = output equals input, or there was no input to compare against. */
  direction: 'down' | 'up' | 'flat';
}

/**
 * Volume reduction between a flow's input and output — replaces the old events-out/events-in
 * "Ratio" with the inverse framing the user actually cares about here: how much did Cribl trim
 * before this reached the destination. A near-zero difference (< 0.05%, comfortably inside
 * floating-point/estimation noise from the out-share scaling in `topology.ts`) reads as "flat"
 * rather than a misleading "down 0.01%".
 */
export function computeReduction(inValue: number, outValue: number): ReductionInfo {
  if (inValue <= 0) return { pct: 0, direction: 'flat' };
  const pct = ((inValue - outValue) / inValue) * 100;
  if (pct > 0.05) return { pct, direction: 'down' };
  if (pct < -0.05) return { pct, direction: 'up' };
  return { pct: 0, direction: 'flat' };
}
