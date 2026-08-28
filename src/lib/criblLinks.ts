// Deep links from a graph node into its real configuration page in the Cribl Leader UI.
//
// Confirmed against real URLs from the test org:
//   .../stream/m/default/inputs/splunk/in_splunk_tcp
//   .../stream/m/default/outputs/splunk/local_splunk
//   .../stream/m/default/pipelines/splunk_sample
//   .../stream/m/default/routes                        (no per-rule sub-page)
//
// The domain itself is derived from `window.CRIBL_API_URL` (stripping the trailing `/api/v1`)
// rather than `window.location.origin` — the app's sandboxed iframe may well be served from a
// different origin than the Leader UI for isolation, so only CRIBL_API_URL is a reliable source
// for "what Cribl instance is this." These are absolute Leader-UI paths, so callers must render
// them with `target="_blank"` (or `"_top"`) per AGENTS.md's navigation guidance — never through
// the app's own client-side router.

import type { GroupProductFilter, NodeKind } from './types';

/** Exported for `lib/format.ts`'s `trimOrgFromHostname` — the one other place in the app that
 *  needs to know this org's own real domain, not just the config-deep-link paths built below. */
export function criblOrigin(): string {
  return window.CRIBL_API_URL.replace(/\/api\/v1\/?$/, '');
}

/** The Leader UI's own Worker Groups list page (confirmed against a real URL from the test org:
 *  `.../stream/m`, no trailing group id — distinct from `criblConfigPath`'s per-group `base`,
 *  which always has one). */
export function criblWorkerGroupsListPath(): string {
  return `${criblOrigin()}/stream/m`;
}

/** The Leader UI's own fleet-wide Workers list page (confirmed: `.../stream/workers` — no `/m/`
 *  prefix at all, since this one isn't scoped to a single Worker Group). */
export function criblWorkersListPath(): string {
  return `${criblOrigin()}/stream/workers`;
}

/**
 * Commit & Deploy has no distinct routable URL of its own (confirmed directly by the user) — it's
 * a panel opened from a "Commit & Deploy" button present on a group's own config pages. For
 * Stream that's a Worker Group's Routes page (confirmed real URL: `.../stream/m/default/routes`,
 * the same `base` this file's `criblConfigPath` already builds for `'routes'`). Edge Fleets don't
 * live under `/stream/m/...` at all — an Edge Fleet id there 404s (confirmed by the user directly:
 * "default_fleet worker group does not exist" from the Stream-shaped URL) — Edge's own real,
 * confirmed equivalent is its Nodes page: `.../edge/m/:fleetId/nodes`.
 */
export function criblCommitDeployPath(groupId: string, product: GroupProductFilter): string {
  const encodedGroupId = encodeURIComponent(groupId);
  return product === 'edge' ? `${criblOrigin()}/edge/m/${encodedGroupId}/nodes` : `${criblOrigin()}/stream/m/${encodedGroupId}/routes`;
}

/**
 * An Edge Node's own real info page (confirmed against a real URL from the test org:
 * `.../edge/m/default_fleet/nodes/55750922-4e0a-408d-87c8-e87fe049b265/info` — the segment before
 * `/info` is the Node's own real worker id, not the Fleet's). Used for the blocked/degraded Why
 * box's own "Open in Cribl" redirect on an Edge node: the Fleet-level config page
 * (`criblConfigPath`'s `.../stream/m/...` shape doesn't apply to Edge at all — see
 * `criblCommitDeployPath`'s own doc comment) has no per-node Status tab equivalent, but this Node's
 * own info page is the real place Cribl shows that specific worker's live connection detail.
 */
export function criblEdgeNodeInfoPath(fleetId: string, nodeId: string): string {
  return `${criblOrigin()}/edge/m/${encodeURIComponent(fleetId)}/nodes/${encodeURIComponent(nodeId)}/info`;
}

export function criblConfigPath(
  groupId: string,
  kind: Extract<NodeKind, 'source' | 'pipeline' | 'prePipeline' | 'postPipeline' | 'destination' | 'outputRouter' | 'routes'>,
  id: string,
  type?: string,
): string | undefined {
  const base = `${criblOrigin()}/stream/m/${encodeURIComponent(groupId)}`;
  switch (kind) {
    case 'source':
      return type ? `${base}/inputs/${encodeURIComponent(type)}/${encodeURIComponent(id)}` : undefined;
    case 'pipeline':
    case 'prePipeline':
    case 'postPipeline':
      return `${base}/pipelines/${encodeURIComponent(id)}`;
    case 'routes':
      return `${base}/routes`;
    case 'destination':
    case 'outputRouter':
      return type ? `${base}/outputs/${encodeURIComponent(type)}/${encodeURIComponent(id)}` : undefined;
    default:
      return undefined;
  }
}
