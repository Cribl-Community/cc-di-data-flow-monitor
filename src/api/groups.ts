import { api, type ApiListResponse } from './client';
import type { GroupProductFilter, ProductType, WorkerGroupSummary } from '../lib/types';

interface RawGroup {
  id: string;
  name?: string;
  description?: string;
  type?: ProductType;
  isFleet?: boolean;
  isSearch?: boolean;
  onPrem?: boolean;
  estimatedIngestRate?: number;
  /** Commit hash of the currently *deployed* configuration version — confirmed live against the
   *  test org, always present on the bare (no `fields`) response. */
  configVersion?: string;
  /** Only present when requested via the `fields` query param below — confirmed live: omitted
   *  entirely (not present-with-zeros) on a bare `GET /master/groups` call, since computing git
   *  status isn't free. `commit` is the hash of the currently *committed* version (compare against
   *  `configVersion` to know whether a deploy is pending); `localChanges` is the number of
   *  configuration edits made but not yet committed. */
  git?: { commit?: string; localChanges?: number };
}

function normalizeGroup(raw: RawGroup): WorkerGroupSummary {
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    description: raw.description,
    type: raw.type ?? 'stream',
    isFleet: raw.isFleet,
    isSearch: raw.isSearch,
    onPrem: raw.onPrem,
    estimatedIngestRate: raw.estimatedIngestRate,
    pendingCommits: raw.git?.localChanges ?? 0,
    // A deploy is "pending" once the currently committed version differs from the version
    // actually running on Workers — real, confirmed live: a group with 2 real uncommitted changes
    // still reported `git.commit === configVersion` (nothing committed yet to deploy), while every
    // clean group in the same org reported the two hashes equal too. `git.commit` is only ever
    // absent when the `fields` request below didn't resolve it; treat that as "unknown," not
    // "pending," rather than a false positive on every group until it's confirmed otherwise.
    pendingDeploy: raw.git?.commit !== undefined && raw.git.commit !== raw.configVersion,
    configVersion: raw.configVersion,
  };
}

/**
 * All config groups visible to the signed-in user: Stream Worker Groups, Edge Fleets, the Search
 * group, and Outpost groups. Confirmed live against the test org: an Edge Fleet exposes the exact
 * same `/m/:gid/routes`, `/pipelines`, `/system/inputs`, `/system/outputs` shape a Stream Worker
 * Group does — real Routes, real Pipelines, and (this org's own fleet) a real `cribl_tcp` output
 * chaining into the real Stream Worker Group's own Load Balancer. The full Signal Path / Flow
 * Explorer topology model applies to Edge Fleets with no shape changes needed.
 *
 * `?fields=git.commit,git.localChanges` — confirmed live and documented on this endpoint's own
 * `fields` query param (`openapi.json`): the `git` sub-object is omitted from a bare call
 * entirely, not returned with zeroed-out values, so this has to be requested explicitly to power
 * the top bar's commit/deploy-pending indicators (`PageHeader.tsx`).
 */
export async function listWorkerGroups(): Promise<WorkerGroupSummary[]> {
  const res = await api.get<ApiListResponse<RawGroup>>('/master/groups?fields=git.commit%2Cgit.localChanges');
  return res.items.map(normalizeGroup);
}

/**
 * Every group this app can build a real Signal Path / Flow Explorer topology for — Stream Worker
 * Groups and Edge Fleets, confirmed live to expose the identical `/m/:gid/routes`/`/pipelines`/
 * `/system/inputs`/`/system/outputs` shape. Deliberately excludes Search (`type: 'search'`, no
 * Sources/Routes/Pipelines/Destinations concept at all — a query/dataset system, not a data-in-
 * motion pipeline) and, for now, Outpost (`type: 'outpost'`) — mechanically the same shape as Edge,
 * but not yet separately verified live, so left out until it is rather than assumed compatible.
 */
export function isSupportedGroup(group: WorkerGroupSummary): boolean {
  return group.type === 'stream' || group.type === 'edge';
}

/**
 * Narrows `isSupportedGroup`'s own "everything this app can show a topology for" set down to
 * just the one product the top-left Stream/Edge toggle (`PageHeader.tsx`) currently has selected.
 */
export function isGroupOfProduct(group: WorkerGroupSummary, product: GroupProductFilter): boolean {
  return group.type === product;
}
