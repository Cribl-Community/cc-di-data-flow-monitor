// Thin fetch wrapper over window.CRIBL_API_URL. The platform proxies and authenticates every
// call transparently (see AGENTS.md) — this file never handles a token.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** 401/403 — the signed-in user lacks a declared policy or role for this path. */
export class PermissionError extends ApiError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = 'PermissionError';
  }
}

export interface ApiListResponse<T> {
  items: T[];
  count: number;
}

async function safeJson(res: Response): Promise<{ message?: string } | undefined> {
  try {
    return (await res.json()) as { message?: string };
  } catch {
    return undefined;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = window.CRIBL_API_URL + path;

  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await safeJson(res);
    const message = body?.message ?? res.statusText ?? `Request failed with status ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      throw new PermissionError(res.status, message);
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  // Confirmed live: Cribl's own KV store PUT returns 201 with a genuinely EMPTY body (no
  // Content-Length, no Content-Type) — not 204. A bare `res.json()` throws on that (JSON.parse
  // of an empty string), which used to make `setKv` silently report failure even though the PUT
  // had already landed. Reading the text first and treating an empty body as "no return value"
  // (same as 204) makes this safe for any endpoint that legitimately returns an empty 2xx body,
  // not just this one.
  const text = await res.text();
  if (text.length === 0) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

export const api = {
  get: <T>(path: string, init?: RequestInit): Promise<T> => request<T>(path, init),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  /** `keepalive` (Fetch API, RFC-standard) tells the browser to still deliver this request even
   *  if the page/iframe that started it is torn down before the response arrives — the normal
   *  behavior otherwise is to abort an in-flight request on navigation-away. Used by `setKv` for
   *  exactly that reason: a save that's still in flight the instant the app closes/is switched
   *  away from should still land, not be silently cancelled. Only safe for small bodies (this
   *  app's own KV writes are a few hundred bytes of JSON, well under the platform's own ~64KB cap
   *  on keepalive requests), so it's opt-in per call rather than the default for every `put`.
   *
   *  `Content-Type: text/plain`, not `application/json` — confirmed live against the real org
   *  (see CLAUDE.md's dated entry): sending `application/json` on a KV store PUT makes Cribl's own
   *  backend parse the body into a real object and then store it via plain `String(value)` instead
   *  of re-serializing, silently corrupting every object/array value into literal text like
   *  `"[object Object]"`. The request body here is still real JSON text (`JSON.stringify(body)`
   *  below is unchanged) — only the header changes, which is enough to make Cribl's KV store treat
   *  the body as an opaque string and store/return it verbatim. This is the only caller of
   *  `api.put` in the app (grep-confirmed), so this isn't scoped narrower than that. */
  put: <T>(path: string, body?: unknown, opts?: { keepalive?: boolean }): Promise<T> =>
    request<T>(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive: opts?.keepalive,
    }),
  /**
   * Deletes are volatile per platform policy — callers must gate this behind an explicit,
   * confirmed user action naming exactly what will be deleted. Never call on load/render/timer.
   */
  delete: <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' }),
};

/** Prefix a Cribl REST path with the currently selected config group's context. */
export function groupScoped(groupId: string, path: string): string {
  return `/m/${encodeURIComponent(groupId)}${path}`;
}

/**
 * Prefix a Cribl REST path with a specific Worker process's context — a sibling of
 * `groupScoped`, confirmed live (see CLAUDE.md) from the real Leader UI's own URL-building code:
 * `/m/:groupId` scopes to a whole Worker Group, `/w/:workerId` scopes to one Worker process
 * within it. Group-scoped status endpoints return health *aggregated across every worker in the
 * group*, which can read healthy on average while one specific worker's connection is actually
 * down — this is what per-worker status calls use instead to see that worker's real state.
 */
export function workerScoped(workerId: string, path: string): string {
  return `/w/${encodeURIComponent(workerId)}${path}`;
}
