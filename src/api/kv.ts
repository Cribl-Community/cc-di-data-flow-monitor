import { api, ApiError } from './client';

// The app-scoped KV store is the only allowed persistence mechanism for this app — browser
// storage (localStorage/sessionStorage/IndexedDB/cookies) is unreliable inside the sandboxed
// iframe and never shared across devices/sessions. See AGENTS.md.

function keyPath(key: string): string {
  return `/kvstore/${key
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')}`;
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  try {
    return await api.get<T>(keyPath(key));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return undefined;
    throw err;
  }
}

/** `keepalive: true` by default — every real caller of this in the app is a "save something the
 *  user just changed" write, exactly the case where the page/iframe closing mid-request shouldn't
 *  silently cancel it. See `api.put`'s own doc comment for the underlying mechanism/size caveat. */
export async function setKv<T>(key: string, value: T, opts: { keepalive?: boolean } = { keepalive: true }): Promise<void> {
  await api.put<void>(keyPath(key), value, opts);
}
