import type { CaptureLevel } from '../lib/types';
import { ApiError, PermissionError, groupScoped } from './client';

// POST /m/:gid/system/capture streams NDJSON — confirmed live against the test org that the
// group-scoped path is required to target that Worker Group's own workers (an unscoped call
// still succeeded in this single-group test org, but would be ambiguous in a multi-group one).
// The shared api.post() helper always parses a single JSON body, so this talks to fetch()
// directly to read the stream incrementally.

export interface CaptureParams {
  groupId: string;
  /** 0 = Before pre-processing Pipeline, 1 = Before Routes, 2 = Before post-processing Pipeline, 3 = Before Destination. */
  level: CaptureLevel;
  /** JS expression evaluated per event; omit to capture everything at this checkpoint. */
  filter?: string;
  /** Seconds to keep the capture open. Default 5. */
  duration?: number;
  /** Default 100, max 10000. */
  maxEvents?: number;
  workerId?: string;
  workerThreshold?: number;
  stepDuration?: number;
}

export interface CapturedEvent {
  _raw?: string;
  _time?: number;
  [key: string]: unknown;
}

/**
 * Starts a live capture and calls `onEvent` for each captured event as it streams in. Resolves
 * once the stream ends (capture duration elapsed or `maxEvents` reached). Pass `signal` to stop
 * early — this is a read-only, non-destructive operation and does not require the confirmation
 * flow used for DELETE/overwrite calls.
 */
export async function startCapture(
  params: CaptureParams,
  onEvent: (event: CapturedEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { groupId, ...body } = params;
  const res = await fetch(window.CRIBL_API_URL + groupScoped(groupId, '/system/capture'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    let message = res.statusText || `Capture request failed with status ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      /* no JSON body */
    }
    if (res.status === 401 || res.status === 403) throw new PermissionError(res.status, message);
    throw new ApiError(res.status, message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as CapturedEvent);
      } catch {
        // Skip a malformed line rather than aborting the whole capture.
      }
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    try {
      onEvent(JSON.parse(trailing) as CapturedEvent);
    } catch {
      /* ignore trailing partial line */
    }
  }
}
