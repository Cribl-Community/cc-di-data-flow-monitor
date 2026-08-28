import { WORKER_NOUN } from './productTerms';
import type { GraphNode, GroupProductFilter, HealthStatus, StatusFilter } from './types';

// Maps our 4-state model onto Capra's semantic appearance vocabulary, so every status pill,
// badge, and dot in the app draws from the same design-token-backed palette rather than a
// hand-rolled one. green = good/success, orange = degraded/warning, red = blocked/danger,
// grey = nodata/neutral.

export const HEALTH_APPEARANCE: Record<HealthStatus, 'success' | 'warning' | 'danger' | 'default'> = {
  good: 'success',
  degraded: 'warning',
  blocked: 'danger',
  nodata: 'default',
};

/** Worst-to-best ranking, shared so every "pick the worse of two statuses" call site (Flow
 *  Explorer's caption/sort logic, the worker-alert severity overlay) agrees on one ordering
 *  instead of several identical-but-separately-declared copies. */
export const HEALTH_RANK: Record<HealthStatus, number> = { blocked: 3, degraded: 2, nodata: 1, good: 0 };

/** The more severe of two statuses, by `HEALTH_RANK`. */
export function worseOf(a: HealthStatus, b: HealthStatus): HealthStatus {
  return HEALTH_RANK[b] > HEALTH_RANK[a] ? b : a;
}

// One label per status, used everywhere a status is named — on canvas cards, rule rows, the
// drawer, and the top-bar filter alike. Used to read "Receiving, not sending" here while the
// status filter said "Blocked" for the same state — two names for one thing, confusing right in
// the middle of the troubleshooting flow this app exists for. Now the same word everywhere; the
// fuller explanation lives in `explainHealth()` below instead of competing as a second label.
export const HEALTH_LABEL: Record<HealthStatus, string> = {
  good: 'Healthy',
  degraded: 'Degraded',
  blocked: 'Blocked',
  nodata: 'No data',
};

/**
 * 'all' always matches. 'enabled' is config-level, not health-level — it ignores `health`
 * entirely and just checks `disabled` (a caller with no real disabled-ness signal of its own,
 * e.g. a synthetic row, should pass `false`, which reads as "enabled"). 'active' means "flowing at
 * all," i.e. anything but nodata. 'unhealthy' matches both `blocked` and `degraded` — there is
 * deliberately no standalone "Degraded" button anywhere in this app's top bar (see `PageHeader`'s
 * own status-filter list), since `degraded` can now only ever mean one specific thing everywhere
 * in this app: a Destination blocked on some, but not all, of its real Worker processes (see
 * `deriveHealth`/`withWorkerAlert`) — a real, worth-finding problem that belongs under
 * "Unhealthy," not a separate, unreachable category. 'nodata' matches only `nodata`.
 */
export function matchesStatusFilter(health: HealthStatus, filter: StatusFilter, disabled?: boolean): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'enabled':
      return !disabled;
    case 'active':
      return health !== 'nodata';
    case 'unhealthy':
      return health === 'blocked' || health === 'degraded';
    case 'nodata':
      return health === 'nodata';
  }
}

/**
 * A one-sentence, honest explanation of why a node was assigned its status, for the detail
 * drawer. Only draws on signals we actually have (volume in/out, disabled state, real per-worker
 * status) — never invents a specific cause we can't back up, like a connector error message we
 * don't receive from the status API. `product` (default `'stream'`) picks "Worker"/"Node" for the
 * two sentences that name the real per-process signal — this node's own real product, not
 * necessarily the top bar's current toggle (a caller under "All Worker Groups" needs the
 * *specific* node's own product, see e.g. `FlowExplorer/ExpandedPath.tsx`'s own resolution).
 */
export function explainHealth(node: GraphNode, product: GroupProductFilter = 'stream'): string | undefined {
  if (node.health === 'good') return undefined;
  if (node.disabled) return 'This component is disabled and not currently processing events.';
  const processNoun = `${WORKER_NOUN[product]} processes`;

  if (node.kind === 'routes') {
    // A rule's own status is the worst of the Pipeline, optional Post-Processing Pipeline, and
    // Destination it dispatches to — not the rule's own volume metrics — so the explanation talks
    // about "downstream of" a rule rather than the rule itself dropping anything.
    switch (node.health) {
      case 'nodata':
        return 'One or more routes below dispatch to components with no observed data in the selected time range — see the list for which.';
      // A Pipeline/Post-Processing Pipeline can never be `degraded` on its own (see
      // `deriveHealth`) — the only real source of it anywhere is a Destination degraded on some,
      // but not all, Worker/Node processes, so that's the only cause worth naming here.
      case 'degraded':
        return `One or more routes below dispatch to a Destination degraded on some (but not all) ${processNoun} — see the list for which.`;
      case 'blocked':
        return 'One or more routes below dispatch to a component that is receiving events but not forwarding them — see the list for which.';
      default:
        return undefined;
    }
  }

  switch (node.health) {
    case 'nodata':
      return 'No events have been observed here in the selected time range.';
    case 'blocked':
      switch (node.kind) {
        case 'source':
          return 'Events are arriving from this Source but are not reaching Routes — check whether its pre-processing pipeline may be dropping them.';
        case 'destination':
        case 'outputRouter':
          return 'Events are arriving for this Destination but none are being sent — check its connectivity or configuration in Cribl.';
        default:
          return 'Events are entering this component but none are leaving it.';
      }
    // The only source of `degraded` anywhere in this app — see `deriveHealth`/`withWorkerAlert` —
    // is a Destination/Output Router blocked on some, but not all, of its real Worker/Node processes.
    case 'degraded':
      return `Some, but not all, ${processNoun} report this Destination as blocked — see the per-worker detail below.`;
    default:
      return undefined;
  }
}
