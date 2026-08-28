import { api, groupScoped, type ApiListResponse } from './client';

// Raw shapes, trimmed to the fields this app actually reads — confirmed against this project's
// own openapi.json (RouteConf, Pipeline, InputResponse/OutputResponse, OutputRouter,
// PipelineFunctionChain / FunctionConfSchemaChain). See CLAUDE.md for the source paths.

interface RawRouteConf {
  id: string;
  name: string;
  final: boolean;
  disabled?: boolean;
  pipeline: string;
  filter?: string;
  output: string;
  description?: string;
}

interface RawRouteTable {
  id: string;
  routes: RawRouteConf[];
}

export interface RawPipelineFunction {
  id: string;
  disabled?: boolean;
  filter?: string;
  /** Brief human-authored description of what this Function instance does, if the pipeline author wrote one. */
  description?: string;
  /** If true, stop passing events to downstream Functions after this one executes. */
  final?: boolean;
  /** Only meaningful when `id === 'chain'`: `conf.processor` is the target pipeline id. */
  conf?: { processor?: string; [key: string]: unknown };
}

export interface RawPipeline {
  id: string;
  conf: {
    functions?: RawPipelineFunction[];
    output?: string;
    description?: string;
  };
}

interface RawQuickConnect {
  /** Optional Pipeline/Pack to process data before sending to the Destination. */
  pipeline?: string;
  /** Destination to send data to, bypassing Routes entirely. */
  output: string;
}

export interface RawInput {
  id: string;
  type: string;
  disabled?: boolean;
  /** Pre-processing pipeline id, if configured. */
  pipeline?: string;
  /** If false, this Source sends straight to a Destination, bypassing Routes. */
  sendToRoutes?: boolean;
  /** "QuickConnect": direct Source -> (optional Pipeline) -> Destination links, bypassing Routes. */
  connections?: RawQuickConnect[];
  description?: string;
}

interface RawOutputRule {
  filter: string;
  output: string;
  final?: boolean;
  description?: string;
}

export interface RawOutput {
  id: string;
  type: string;
  disabled?: boolean;
  /** Post-processing pipeline id, if configured. */
  pipeline?: string;
  description?: string;
  /** Present only when `type === 'router'`. */
  rules?: RawOutputRule[];
  /** Present only on the built-in "default" output (`type === 'default'`, confirmed against this
   *  project's own openapi.json — `OutputDefault.defaultId`, titled "Default Output ID"): which
   *  real Destination this fallback actually forwards to. `null`/absent when unconfigured. */
  defaultId?: string | null;
  /** Present on `cribl_tcp`/`cribl_http` outputs — the real Worker(s) this Cribl-to-Cribl
   *  Destination sends to (confirmed live: `[{host, port, weight, tls}]`, one entry per
   *  load-balanced target). Only `host` is read — see `lib/crossDeploymentChain.ts`. */
  hosts?: { host: string }[];
}

export interface RawStatusEntry {
  id: string;
  type?: string;
  status?: {
    health?: 'Green' | 'Yellow' | 'Red' | 'Unknown';
    healthCounts?: Record<string, number>;
    timestamp?: number;
    /**
     * Present only when persistent queue is actually enabled on this Source/Destination — absent
     * otherwise, not present-with-an-"off" state (confirmed against `AggregatedPQStatus` in this
     * project's own `openapi.json`, which declares exactly `health`/`healthCounts`/`error`/
     * `timestamp` here — no size/depth figures at this, group-scoped level; those would need the
     * separate per-worker status call, same as every other per-worker-only detail in this app).
     */
    pq?: { health?: 'Green' | 'Yellow' | 'Red' | 'Unknown'; healthCounts?: Record<string, number>; error?: { message?: string } };
  };
}

async function getRouteTables(groupId: string): Promise<RawRouteTable[]> {
  const res = await api.get<ApiListResponse<RawRouteTable>>(groupScoped(groupId, '/routes'));
  return res.items;
}

async function getPipelines(groupId: string): Promise<RawPipeline[]> {
  const res = await api.get<ApiListResponse<RawPipeline>>(groupScoped(groupId, '/pipelines'));
  return res.items;
}

/** A lightweight Source-id-only fetch, without the rest of `fetchTopologyBundle`'s heavier
 *  per-group fetch (routes/pipelines/outputs/status) — used where only the id list is needed
 *  (e.g. License Usage's per-source labels, Node Inventory's per-worker volume). */
export async function listInputs(groupId: string): Promise<RawInput[]> {
  const res = await api.get<ApiListResponse<RawInput>>(groupScoped(groupId, '/system/inputs'));
  return res.items;
}

const getInputs = listInputs;

/** A lightweight Destination-id-only fetch, without the rest of `fetchTopologyBundle`'s heavier
 *  per-group fetch (routes/pipelines/inputs/status) — used where only the id list is needed (e.g.
 *  Node Inventory's per-worker volume correction, the license per-source breakdown). */
export async function listOutputs(groupId: string): Promise<RawOutput[]> {
  const res = await api.get<ApiListResponse<RawOutput>>(groupScoped(groupId, '/system/outputs'));
  return res.items;
}

const getOutputs = listOutputs;

async function getInputStatus(groupId: string): Promise<RawStatusEntry[]> {
  const res = await api.get<ApiListResponse<RawStatusEntry>>(
    groupScoped(groupId, '/system/status/inputs?metrics=true'),
  );
  return res.items;
}

async function getOutputStatus(groupId: string): Promise<RawStatusEntry[]> {
  const res = await api.get<ApiListResponse<RawStatusEntry>>(
    groupScoped(groupId, '/system/status/outputs?metrics=true'),
  );
  return res.items;
}

export interface RawTopologyBundle {
  groupId: string;
  routeTables: RawRouteTable[];
  pipelines: RawPipeline[];
  inputs: RawInput[];
  outputs: RawOutput[];
  inputStatus: RawStatusEntry[];
  outputStatus: RawStatusEntry[];
}

/** Fetches everything needed to build one Worker Group's flow graph, in parallel. */
export async function fetchTopologyBundle(groupId: string): Promise<RawTopologyBundle> {
  const [routeTables, pipelines, inputs, outputs, inputStatus, outputStatus] = await Promise.all([
    getRouteTables(groupId),
    getPipelines(groupId),
    getInputs(groupId),
    getOutputs(groupId),
    getInputStatus(groupId),
    getOutputStatus(groupId),
  ]);
  return { groupId, routeTables, pipelines, inputs, outputs, inputStatus, outputStatus };
}
