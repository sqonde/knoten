# Changelog

All notable changes to `@sqonde/knoten` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed (breaking)

- `useQuery` and `useMutation` now accept a second/third generic `E` (default
  `Error`) that types the `error` field. Errors thrown by the fetcher or
  mutator are passed through unchanged instead of being normalized to a
  string. `AbortError` is still swallowed.
- Signatures: `useQuery<T, E = Error>(…)` → `UseQueryResult<T, E>`,
  `useMutation<T, V = void, E = Error>(…)` → `UseMutationResult<T, V, E>`.

### Removed (breaking)

- `requestId` is no longer surfaced on `UseQueryResult` or
  `UseMutationResult`. Consumers who need request-ID correlation should type
  their own error class (e.g. `class ApiError extends Error { requestId }`)
  and pull the ID off `error` at the call site via the `E` generic.
- Internal `extractError` helper, which matched `{ requestId, message }`
  shapes, has been removed.

### Migration from 0.1.x

```ts
// Before
const { data, error, requestId } = useQuery(['x'], fetchX);
if (error) return <p>{error} (id: {requestId})</p>;

// After
const { data, error } = useQuery<X, ApiError>(['x'], fetchX);
if (error) return <p>{error.message} (id: {error.requestId})</p>;
```

## [0.1.1] - 2026-04-16

### Changed

- `useMutation` now derives its internal cache key via React's `useId()`
  instead of `useRef(\`__mutation_${Date.now()}_${Math.random()}\`).current`.
  Stable across renders, collision-free, and idiomatic for React 18+.

## [0.1.0] - 2026-04-16

Initial public release, extracted from the Messwerk dashboard.

### Added

- `useQuery(key, fetcher, options?)` with `initialData`, `interval`, and
  `enabled` options. Returns `data`, `error`, `requestId`, `isLoading`,
  `isRefetching`, `isFetching`, and `refetch`.
- `useMutation(mutator, options?)` with `invalidates`, `onSuccess`, and
  `onError`. Returns `mutate`, `isLoading`, `error`, `requestId`, and
  `reset`.
- `invalidate(keyPrefix)` — refetches every active query whose key starts
  with the given prefix.
- Generation counter + `AbortController` guard every fetch; stale responses
  are dropped on rapid refetch or prop changes.
- Polling pauses on `visibilitychange` (tab hidden) and `offline`, resuming
  with an immediate refetch when the tab becomes visible and online.
- Structural error extraction: objects with `{ requestId, message }` are
  surfaced without any class coupling.

[Unreleased]: https://github.com/sqonde/knoten/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/sqonde/knoten/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sqonde/knoten/releases/tag/v0.1.0
