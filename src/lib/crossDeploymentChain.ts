import type { RawOutput } from '../api/topology';

const CROSS_DEPLOYMENT_OUTPUT_TYPES = new Set(['cribl_tcp', 'cribl_http']);

/**
 * Resolves which real Worker Group (if any) a Cribl-to-Cribl Destination (`cribl_tcp`/
 * `cribl_http`) actually hands its data off to. Confirmed live against a real org: such an
 * output's own `hosts[]` names real Worker hostnames — cross-referenced here against
 * `/master/workers`' own `group` field (see `workerGroupByHostname`'s callers). Tries each
 * configured host in order (a load-balanced output can list more than one) and returns the first
 * that resolves to a *different* group than `ownGroupId` — a hop that resolves back to its own
 * group isn't a cross-deployment story worth surfacing. Returns `undefined` for any other output
 * type, an unresolvable host (e.g. a raw IP/DNS name with no matching registered Worker), or a
 * same-group loopback.
 */
export function resolveChainTarget(
  output: Pick<RawOutput, 'type' | 'hosts'>,
  ownGroupId: string,
  workerGroupByHostname: ReadonlyMap<string, string>,
): string | undefined {
  if (!CROSS_DEPLOYMENT_OUTPUT_TYPES.has(output.type)) return undefined;
  for (const { host } of output.hosts ?? []) {
    const targetGroupId = workerGroupByHostname.get(host);
    if (targetGroupId && targetGroupId !== ownGroupId) return targetGroupId;
  }
  return undefined;
}

/** Builds the `host -> groupId` lookup `resolveChainTarget` needs, from a real `/master/workers`
 *  response — one app-wide call, reused across every group's own graph build. A worker with no
 *  real hostname or group (shouldn't normally happen) is simply skipped, not an error. */
export function buildWorkerGroupByHostname(workers: { group?: string; info?: { hostname?: string } }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const w of workers) {
    if (w.info?.hostname && w.group) map.set(w.info.hostname, w.group);
  }
  return map;
}
