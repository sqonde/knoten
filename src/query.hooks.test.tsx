import { describe, test, expect, afterEach, mock } from 'bun:test';
import { renderHook, render, screen, waitFor, fireEvent, act, cleanup } from '@testing-library/react';
import { useQuery, useMutation, invalidate, __internals } from './query';

// End-to-end hook/component tests: real React + real Zustand store + controllable
// fetchers. This is Knoten's own regression net — it lets us catch behaviour or
// dependency-version changes here, without relying on a downstream consumer.

afterEach(() => {
  cleanup();
  __internals.cacheStore.setState({ entries: {} });
  __internals.refetchRegistry.clear();
});

/** A promise whose settlement we control, so aborts/timing are deterministic. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useQuery — baseline', () => {
  test('initial load: isLoading then data, with isFetching/isRefetching transitions', async () => {
    const d = deferred<string>();
    const { result } = renderHook(() => useQuery(['load'], () => d.promise));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.isFetching).toBe(true);
    expect(result.current.isRefetching).toBe(false);
    expect(result.current.data).toBeUndefined();

    act(() => d.resolve('value'));
    await waitFor(() => expect(result.current.data).toBe('value'));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isFetching).toBe(false);
  });

  test('error is passed through unchanged (custom error class survives)', async () => {
    class ApiError extends Error {
      constructor(public status: number) {
        super('boom');
        this.name = 'ApiError';
      }
    }
    const { result } = renderHook(() =>
      useQuery<string, ApiError>(['err'], async () => {
        throw new ApiError(503);
      })
    );

    await waitFor(() => expect(result.current.error).toBeInstanceOf(ApiError));
    expect(result.current.error?.status).toBe(503);
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  test('AbortError from a superseded request never surfaces as error', async () => {
    let first = true;
    const second = deferred<string>();
    const fetcher = (signal?: AbortSignal) => {
      if (first) {
        first = false;
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        });
      }
      return second.promise;
    };
    const { result } = renderHook(() => useQuery(['abort'], fetcher));

    // refetch() aborts the first in-flight request → its AbortError must be swallowed.
    act(() => {
      result.current.refetch();
    });
    act(() => second.resolve('ok'));
    await waitFor(() => expect(result.current.data).toBe('ok'));
    expect(result.current.error).toBeNull();
  });

  test('background refetch keeps data while isRefetching is true', async () => {
    let calls = 0;
    const hold = deferred<string>();
    const fetcher = () => {
      calls += 1;
      return calls === 1 ? Promise.resolve('first') : hold.promise;
    };
    const { result } = renderHook(() => useQuery(['bg'], fetcher));
    await waitFor(() => expect(result.current.data).toBe('first'));

    act(() => {
      result.current.refetch();
    });
    await waitFor(() => expect(result.current.isRefetching).toBe(true));
    expect(result.current.data).toBe('first'); // retained during refresh
    expect(result.current.isLoading).toBe(false);

    act(() => hold.resolve('second'));
    await waitFor(() => expect(result.current.data).toBe('second'));
    expect(result.current.isRefetching).toBe(false);
  });
});

describe('useQuery — null handling', () => {
  test('regression (D): a fetched null is surfaced, not masked by initialData', async () => {
    const { result } = renderHook(() =>
      useQuery<string | null>(['nullable'], async () => null, { initialData: 'seed' })
    );
    // initialData seeds the cache and suppresses the initial fetch.
    expect(result.current.data).toBe('seed');

    // An explicit refetch resolves to null; null must now win (pre-fix: 'seed').
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data).toBeNull();
    expect(result.current.isFetching).toBe(false);
  });
});

describe('useQuery — abandoned requests', () => {
  test('regression (B): changing key mid-flight aborts and releases the old key', async () => {
    const signals = new Map<string, AbortSignal | undefined>();
    const makeFetcher = (k: string) => (signal?: AbortSignal) => {
      signals.set(k, signal);
      return new Promise<string>(() => {}); // never settles on its own
    };
    const { rerender } = renderHook(({ k }) => useQuery(['check', k], makeFetcher(k)), {
      initialProps: { k: 'A' },
    });

    await waitFor(() => expect(signals.has('A')).toBe(true));
    rerender({ k: 'B' }); // switch before A resolves
    await waitFor(() => expect(signals.has('B')).toBe(true));

    expect(signals.get('A')?.aborted).toBe(true);
    const aEntry = __internals.cacheStore.getState().entries['["check","A"]'];
    expect(aEntry?.isFetching).toBe(false); // pre-fix: stuck true forever
  });
});

describe('useMutation — baseline', () => {
  test('mutate resolves with value, toggles isLoading, fires onSuccess', async () => {
    const onSuccess = mock(() => {});
    const { result } = renderHook(() =>
      useMutation(async (n: number) => n * 2, { onSuccess })
    );
    expect(result.current.isLoading).toBe(false);

    let returned: number | undefined;
    await act(async () => {
      returned = await result.current.mutate(21);
    });
    expect(returned).toBe(42);
    expect(onSuccess).toHaveBeenCalledWith(42);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test('mutate surfaces error and fires onError on throw', async () => {
    const onError = mock(() => {});
    const { result } = renderHook(() =>
      useMutation(async () => {
        throw new Error('nope');
      }, { onError })
    );

    let returned: unknown = 'sentinel';
    await act(async () => {
      returned = await result.current.mutate();
    });
    expect(returned).toBeUndefined();
    expect(result.current.error).toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('regression (C): the mutation entry is removed from the store on unmount', async () => {
    const entryCount = () => Object.keys(__internals.cacheStore.getState().entries).length;
    expect(entryCount()).toBe(0);

    const { result, unmount } = renderHook(() => useMutation(async () => 'done'));
    await act(async () => {
      await result.current.mutate();
    });
    expect(entryCount()).toBe(1); // stored under this instance's useId

    unmount();
    expect(entryCount()).toBe(0); // pre-fix: leaks forever
  });
});

describe('invalidate — baseline (end to end through React)', () => {
  test('a mounted matching query refetches; a non-matching one does not', async () => {
    let usersCalls = 0;
    let metricsCalls = 0;
    renderHook(() => useQuery(['users'], async () => `users-${++usersCalls}`));
    renderHook(() => useQuery(['metrics'], async () => `metrics-${++metricsCalls}`));

    await waitFor(() => expect(usersCalls).toBe(1));
    await waitFor(() => expect(metricsCalls).toBe(1));

    act(() => invalidate(['users']));
    await waitFor(() => expect(usersCalls).toBe(2));
    expect(metricsCalls).toBe(1); // untouched
  });

  test('regression (A): invalidation survives a same-key sibling unmounting', async () => {
    let calls = 0;
    const fetcher = async () => `v${++calls}`;
    renderHook(() => useQuery(['shared'], fetcher)); // first instance (survivor)
    const sibling = renderHook(() => useQuery(['shared'], fetcher)); // later instance

    await waitFor(() => expect(calls).toBe(1)); // shared cache → one initial fetch
    sibling.unmount(); // the later-registered instance leaves

    const before = calls;
    act(() => invalidate(['shared']));
    // Survivor must still refetch (pre-fix: the registry entry was deleted → 0 refetches).
    await waitFor(() => expect(calls).toBe(before + 1));
  });

  test('component flow: mutate with invalidates refreshes the list', async () => {
    const server = ['a'];
    function List() {
      const { data } = useQuery(['items'], async () => [...server]);
      return (
        <ul>
          {(data ?? []).map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      );
    }
    function AddButton() {
      const { mutate } = useMutation(
        async () => {
          server.push('b');
        },
        { invalidates: ['items'] }
      );
      return (
        <button type="button" onClick={() => mutate()}>
          add
        </button>
      );
    }
    render(
      <>
        <List />
        <AddButton />
      </>
    );

    await waitFor(() => expect(screen.getByText('a')).toBeDefined());
    fireEvent.click(screen.getByText('add'));
    await waitFor(() => expect(screen.getByText('b')).toBeDefined());
  });
});
