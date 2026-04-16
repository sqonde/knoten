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

const refetchRegistry = new Map<string, () => Promise<void>>();

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
  for (const [key, refetch] of refetchRegistry) {
    if (isPrefixMatch(prefix, key)) {
      refetch();
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

  const refetch = useCallback(async () => {
    // Abort any in-flight request and bump generation
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const myGen = ++generationRef.current;

    setEntry(serialized, { isFetching: true, error: null });

    try {
      const data = await fetcherRef.current(controller.signal);
      if (myGen !== generationRef.current) return; // stale
      setEntry(serialized, { data, isFetching: false, error: null });
    } catch (err) {
      if (myGen !== generationRef.current || isAbortError(err)) return; // stale or aborted
      setEntry(serialized, { isFetching: false, error: err });
    }
  }, [serialized, setEntry]);

  // Register in invalidation registry
  useEffect(() => {
    refetchRegistry.set(serialized, refetch);
    return () => {
      refetchRegistry.delete(serialized);
    };
  }, [serialized, refetch]);

  // Abort in-flight request on unmount
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      generationRef.current++; // invalidate any pending responses
    };
  }, []);

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
    if (!entry) {
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
    data: (entry?.data as T) ?? options?.initialData,
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
  reset: () => void;
};

export function useMutation<T, V = void, E = Error>(
  mutator: (variables: V) => Promise<T>,
  options?: UseMutationOptions<T, E>
): UseMutationResult<T, V, E> {
  const setEntry = useCacheStore((s) => s.set);
  const mutationKey = useId();

  const entry = useCacheStore((s) => s.entries[mutationKey]);

  const mutate = useCallback(
    async (variables: V): Promise<T | undefined> => {
      setEntry(mutationKey, { isFetching: true, error: null });
      try {
        const data = await mutator(variables);
        setEntry(mutationKey, { isFetching: false, error: null, data });
        if (options?.invalidates) {
          invalidate(options.invalidates);
        }
        options?.onSuccess?.(data);
        return data;
      } catch (err) {
        setEntry(mutationKey, { isFetching: false, error: err });
        options?.onError?.(err as E);
        return undefined;
      }
    },
    [mutationKey, setEntry, mutator, options?.invalidates, options?.onSuccess, options?.onError]
  );

  const reset = useCallback(() => {
    setEntry(mutationKey, { isFetching: false, error: null });
  }, [mutationKey, setEntry]);

  return {
    mutate,
    isLoading: entry?.isFetching ?? false,
    error: (entry?.error as E | null) ?? null,
    reset,
  };
}
