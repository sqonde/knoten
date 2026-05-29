import { useEffect, useRef, useCallback, useId } from 'react';
import { create } from 'zustand';

// ============================================================================
// CACHE STORE
// ============================================================================

type QueryEntry = {
  data: unknown;
  error: unknown;
  isFetching: boolean;
};

type CacheState = {
  entries: Record<string, QueryEntry>;
  set: (key: string, update: Partial<QueryEntry>) => void;
  get: (key: string) => QueryEntry | undefined;
  delete: (key: string) => void;
};

const EMPTY_ENTRY: QueryEntry = {
  data: undefined,
  error: null,
  isFetching: false,
};

const useCacheStore = create<CacheState>((set, get) => ({
  entries: {},
  set: (key, update) =>
    set((state) => ({
      entries: {
        ...state.entries,
        [key]: { ...EMPTY_ENTRY, ...state.entries[key], ...update },
      },
    })),
  get: (key) => get().entries[key],
  delete: (key) =>
    set((state) => {
      if (!(key in state.entries)) return state; // no-op → no re-render
      const { [key]: _removed, ...rest } = state.entries;
      return { entries: rest };
    }),
}));

// ============================================================================
// ERROR HELPERS
// ============================================================================

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

// ============================================================================
// INVALIDATION REGISTRY
// ============================================================================

const refetchRegistry = new Map<string, Set<() => Promise<void>>>();

function serializeKey(key: unknown[]): string {
  return JSON.stringify(key);
}

function isPrefixMatch(prefix: string, candidate: string): boolean {
  if (prefix === candidate) return true;
  const prefixBase = prefix.slice(0, -1);
  return candidate.startsWith(prefixBase + ',');
}

export function invalidate(keyPrefix: unknown[]): void {
  const prefix = serializeKey(keyPrefix);
  for (const [key, refetchers] of refetchRegistry) {
    if (isPrefixMatch(prefix, key)) {
      for (const refetch of refetchers) refetch();
    }
  }
}

// ============================================================================
// ENVIRONMENT HELPERS
// ============================================================================

function isBrowserActive(): boolean {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return true;
  return !document.hidden && navigator.onLine;
}

// ============================================================================
// useQuery
// ============================================================================

export type Fetcher<T> = (signal?: AbortSignal) => Promise<T>;

export type UseQueryOptions<T> = {
  initialData?: T;
  interval?: number;
  enabled?: boolean;
};

export type UseQueryResult<T, E = Error> = {
  data: T | undefined;
  error: E | null;
  /** True when a request is in flight AND no data exists yet (initial load). */
  isLoading: boolean;
  /** True when a request is in flight AND data already exists (background refresh). */
  isRefetching: boolean;
  /** True whenever a request is in flight (either initial or background). */
  isFetching: boolean;
  refetch: () => Promise<void>;
};

export function useQuery<T, E = Error>(
  key: unknown[],
  fetcher: Fetcher<T>,
  options?: UseQueryOptions<T>
): UseQueryResult<T, E> {
  const serialized = serializeKey(key);
  const enabled = options?.enabled ?? true;

  const entry = useCacheStore((s) => s.entries[serialized]);
  const setEntry = useCacheStore((s) => s.set);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Generation counter - ignore responses from stale/aborted requests
  const generationRef = useRef(0);
  // AbortController for the currently in-flight request
  const controllerRef = useRef<AbortController | null>(null);
  // Key of the request currently in flight, so an abandoned request's entry can
  // be released instead of being left stuck on isFetching:true.
  const inFlightKeyRef = useRef<string | null>(null);

  const refetch = useCallback(async () => {
    // Abort any in-flight request and bump generation. If that request was for a
    // *different* key (a key change), release its entry so it doesn't stay stuck
    // on isFetching:true. A same-key refetch (e.g. polling) is left alone - the
    // new request sets isFetching again below.
    const prevKey = inFlightKeyRef.current;
    controllerRef.current?.abort();
    if (prevKey !== null && prevKey !== serialized) {
      setEntry(prevKey, { isFetching: false });
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    inFlightKeyRef.current = serialized;
    const myGen = ++generationRef.current;

    setEntry(serialized, { isFetching: true, error: null });

    try {
      const data = await fetcherRef.current(controller.signal);
      if (myGen !== generationRef.current) return; // stale
      inFlightKeyRef.current = null;
      setEntry(serialized, { data, isFetching: false, error: null });
    } catch (err) {
      if (myGen !== generationRef.current || isAbortError(err)) return; // stale or aborted
      inFlightKeyRef.current = null;
      setEntry(serialized, { isFetching: false, error: err });
    }
  }, [serialized, setEntry]);

  // Register in invalidation registry. One Set of refetchers per key, so two
  // components sharing a key both stay registered (and a sibling unmounting
  // doesn't unregister the survivors).
  useEffect(() => {
    let refetchers = refetchRegistry.get(serialized);
    if (!refetchers) {
      refetchers = new Set();
      refetchRegistry.set(serialized, refetchers);
    }
    refetchers.add(refetch);
    return () => {
      refetchers.delete(refetch);
      if (refetchers.size === 0 && refetchRegistry.get(serialized) === refetchers) {
        refetchRegistry.delete(serialized);
      }
    };
  }, [serialized, refetch]);

  // Abort in-flight request on unmount, and release its entry so a later remount
  // on the same key isn't left looking at a stuck isFetching:true.
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      generationRef.current++; // invalidate any pending responses
      const k = inFlightKeyRef.current;
      if (k !== null) setEntry(k, { isFetching: false });
      inFlightKeyRef.current = null;
    };
  }, [setEntry]);

  // Abort the in-flight request when the query becomes disabled, and release its
  // entry. Mirrors the unmount cleanup; the generation bump drops any late response.
  useEffect(() => {
    if (enabled) return;
    controllerRef.current?.abort();
    generationRef.current++;
    const k = inFlightKeyRef.current;
    if (k !== null) setEntry(k, { isFetching: false });
    inFlightKeyRef.current = null;
  }, [enabled, setEntry]);

  // Initial fetch
  useEffect(() => {
    if (!enabled) return;
    if (options?.initialData !== undefined && !entry) {
      setEntry(serialized, {
        data: options.initialData,
        isFetching: false,
        error: null,
      });
      return;
    }
    // Fetch when there's no entry, or the entry exists but never loaded data
    // (e.g. a previous request was abandoned by a key change, disable, or
    // unmount). Entries that already hold data or an error are reused -
    // cache-first, with no automatic retry of errors.
    const needsFetch =
      !entry || (entry.data === undefined && entry.error === null && !entry.isFetching);
    if (needsFetch) {
      refetch();
    }
  }, [serialized, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Polling with visibility + online awareness
  useEffect(() => {
    if (!enabled || !options?.interval) return;

    const intervalMs = options.interval;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(() => {
        if (isBrowserActive()) refetch();
      }, intervalMs);
    };

    const stop = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const resume = () => {
      // Immediate refetch on resume to avoid stale data
      refetch();
      start();
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else if (navigator.onLine) {
        resume();
      }
    };

    const onOnline = () => {
      if (!document.hidden) resume();
    };

    const onOffline = () => {
      stop();
      // Abort the in-flight request since network is gone
      controllerRef.current?.abort();
    };

    if (isBrowserActive()) start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [serialized, enabled, options?.interval, refetch]);

  const hasData = entry?.data !== undefined || options?.initialData !== undefined;
  const isFetching = entry?.isFetching ?? (options?.initialData === undefined && enabled && !entry);

  return {
    // Once an entry exists its data is authoritative - including a genuine
    // `null` returned by the fetcher. initialData only fills in before then.
    data: entry ? (entry.data as T) : options?.initialData,
    error: (entry?.error as E | null) ?? null,
    isLoading: isFetching && !hasData,
    isRefetching: isFetching && hasData,
    isFetching,
    refetch,
  };
}

// ============================================================================
// useMutation
// ============================================================================

export type UseMutationOptions<T, E = Error> = {
  invalidates?: unknown[];
  onSuccess?: (data: T) => void;
  onError?: (error: E) => void;
};

export type UseMutationResult<T, V, E = Error> = {
  mutate: (variables: V) => Promise<T | undefined>;
  isLoading: boolean;
  error: E | null;
  /** The last successful result, or undefined before the first success / after reset(). */
  data: T | undefined;
  /** True once a mutation has succeeded and has not been reset or errored since. */
  isSuccess: boolean;
  reset: () => void;
};

export function useMutation<T, V = void, E = Error>(
  mutator: (variables: V) => Promise<T>,
  options?: UseMutationOptions<T, E>
): UseMutationResult<T, V, E> {
  const setEntry = useCacheStore((s) => s.set);
  const deleteEntry = useCacheStore((s) => s.delete);
  const mutationKey = useId();

  const entry = useCacheStore((s) => s.entries[mutationKey]);

  // Read the latest mutator/options through refs so `mutate` stays referentially
  // stable even when callers pass them inline (mirrors useQuery's fetcherRef).
  const mutatorRef = useRef(mutator);
  mutatorRef.current = mutator;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Mutation entries are keyed by a per-instance useId(), so drop ours on
  // unmount - otherwise the store grows without bound as mutation-bearing
  // components (dialogs, row actions) mount and unmount.
  useEffect(() => () => deleteEntry(mutationKey), [mutationKey, deleteEntry]);

  const mutate = useCallback(
    async (variables: V): Promise<T | undefined> => {
      setEntry(mutationKey, { isFetching: true, error: null });
      try {
        const data = await mutatorRef.current(variables);
        setEntry(mutationKey, { isFetching: false, error: null, data });
        const opts = optionsRef.current;
        if (opts?.invalidates) {
          invalidate(opts.invalidates);
        }
        opts?.onSuccess?.(data);
        return data;
      } catch (err) {
        setEntry(mutationKey, { isFetching: false, error: err });
        optionsRef.current?.onError?.(err as E);
        return undefined;
      }
    },
    [mutationKey, setEntry]
  );

  const reset = useCallback(() => {
    setEntry(mutationKey, { isFetching: false, error: null, data: undefined });
  }, [mutationKey, setEntry]);

  return {
    mutate,
    isLoading: entry?.isFetching ?? false,
    error: (entry?.error as E | null) ?? null,
    data: entry?.data as T | undefined,
    isSuccess: entry?.data !== undefined && !entry?.error,
    reset,
  };
}

// ============================================================================
// TEST SEAM
// ============================================================================

// Internal handles for the test suite only. NOT re-exported from src/index.ts,
// so this is not part of the public API. Lets the in-repo tests exercise the
// real serialization/prefix/abort logic and inspect the cache + registry.
export const __internals = {
  serializeKey,
  isPrefixMatch,
  isAbortError,
  refetchRegistry,
  cacheStore: useCacheStore,
};
