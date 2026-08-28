import { useCallback, useEffect, useRef } from 'react';

/**
 * Runs `effect` whenever any value in `deps` changes — except the very first render, where every
 * page's own initial-load effect already covers the real first fetch. Used to trigger a background
 * refresh when a *filter* (e.g. the shared status filter) changes without doubling up on the fetch
 * a page's own data hooks already run on mount, and without re-fetching on values (Worker Group,
 * time range, metric unit) that already trigger a real refetch through their own hook dependencies.
 */
export function useSkipFirstEffect(effect: () => void, deps: unknown[]): void {
  const isFirst = useRef(true);
  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    effect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller's own explicit list.
  }, deps);
}

/**
 * Returns a stable function that calls `fn` `delayMs` after the last time it was itself invoked,
 * collapsing a burst of rapid calls — every keystroke in a text filter box — into one real
 * background refresh shortly after typing stops, rather than one network round trip per character.
 */
export function useDebouncedCallback(fn: () => void, delayMs: number): () => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => fnRef.current(), delayMs);
  }, [delayMs]);
}
