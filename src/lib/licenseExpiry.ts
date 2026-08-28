const DAY_MS = 24 * 60 * 60 * 1000;
const AVG_DAYS_PER_MONTH = 30.44;

/** green (>= 6 months out) / orange (3-6 months) / red (< 3 months, including already expired) —
 *  an approximate, calendar-agnostic month length (`AVG_DAYS_PER_MONTH`) is a deliberate choice
 *  here: this is a glanceable urgency cue, not a billing calculation, so exact calendar-month
 *  arithmetic (accounting for varying month lengths) would be false precision. Shared by every
 *  place a license's own expiry date needs this same urgency color (Overview's License KPI card). */
export function expiryTone(expiresAt: number): 'success' | 'warning' | 'danger' {
  const daysLeft = (expiresAt - Date.now()) / DAY_MS;
  if (daysLeft >= 6 * AVG_DAYS_PER_MONTH) return 'success';
  if (daysLeft >= 3 * AVG_DAYS_PER_MONTH) return 'warning';
  return 'danger';
}
