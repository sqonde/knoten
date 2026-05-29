# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

`@sqonde/knoten` - a tiny React data-fetching library: `useQuery`,
`useMutation`, `invalidate`. Built on Zustand. ESM-only. The whole library
is one file (`src/query.ts`), small enough to read in one sitting. Keep it
that way.

The package was extracted from [Messwerk](https://github.com/sqonde) (a
push-based monitoring server) so it could be reused independently. Behaviour
must stay drop-in compatible with how Messwerk uses it.

## Common commands

```bash
bun install              # Install deps
bun test                 # Run unit + hook tests (bun:test + happy-dom)
bun run typecheck        # tsc over the whole repo (src incl. tests)
bun run build            # Build dist/index.js (ESM) + dist/index.d.ts
bun run format           # Prettier
bun run release:patch    # Bump patch + commit + tag + push (triggers npm publish)
bun run release:minor    # Bump minor + …
bun run release:major    # Bump major + …
```

`bun pm pack --dry-run` shows what ends up in the published tarball.

## Public API

Exports live in `src/index.ts` and must stay stable:

- `useQuery<T, E = Error>(key, fetcher, options?)` → `{ data, error, isLoading, isRefetching, isFetching, refetch }`
- `useMutation<T, V = void, E = Error>(mutator, options?)` → `{ mutate, isLoading, error, data, isSuccess, reset }`
- `invalidate(keyPrefix)` - refetches every active query whose key starts with `keyPrefix`

Types are also exported: `Fetcher`, `UseQueryOptions`, `UseQueryResult`,
`UseMutationOptions`, `UseMutationResult`. Removing or renaming any of these
is a breaking change → minimum minor bump for additions, major bump for
removals/renames.

## Load-bearing invariants

These keep the library small and predictable. Don't break them.

### 1. Peer dependencies only - no extra runtime deps

`react` and `zustand` are `peerDependencies`. We don't ship our own copies.
Anything else (date libs, lodash, axios, …) is **out of scope** - Knoten is
deliberately tiny.

### 2. ESM-only, browser target

`bun build … --target=browser --external react --external zustand` produces
`dist/index.js`. No CJS build, no Node-specific code. If something needs
`document` or `window`, it must check for it (see `isBrowserActive()`).

### 3. Errors are passed through unchanged (except `AbortError`)

Whatever the fetcher/mutator throws lands in `error` as-is, typed by the
consumer-supplied `E` generic (default `Error`). The only exception:
`AbortError` from aborted in-flight requests is swallowed, because aborts
aren't real errors. Don't add an error class, normalization layer, or
extractor here - Knoten stays decoupled from any specific error shape.

### 4. Generation counter + AbortController guard every fetch

Each call to `refetch()` bumps `generationRef`, aborts the previous in-flight
request, and ignores any response whose generation no longer matches. Don't
remove this - it's what makes rapid invalidations and prop changes safe. The
guard is **per-hook-instance** (`generationRef`/`controllerRef` are refs): it
protects a hook against its own stale/aborted responses, not against two
mounted hooks writing the same shared key (benign by the same-key → same-data
convention). When a request is abandoned (key change, `enabled: false`,
unmount) its entry's `isFetching` is released so the key can't get stuck.

### 5. Polling is visibility- and online-aware

The polling effect listens to `visibilitychange` + `online`/`offline`.
Polling pauses when the tab is hidden and resumes (with an immediate
refetch) when it returns. Don't add a "poll always" option - that's a
footgun for users' batteries.

### 6. Behaviour is verified in-repo, with both unit and hook tests

Two suites run under `bun test`:

- `src/query.test.ts` - pure unit tests of the shipped `serializeKey`,
  `isPrefixMatch`, and `isAbortError` (reached via the non-public
  `__internals` export, so they can't drift from the real code). No DOM
  needed.
- `src/query.hooks.test.tsx` - end-to-end hook/component tests using
  `@testing-library/react` on a happy-dom global (registered via
  `bunfig.toml` → `happydom.ts`). They render the real hooks against the
  real Zustand store and assert every behavioural guarantee: loading
  states, error pass-through, abort on key-change/disable/unmount,
  invalidation across siblings, and the mutation lifecycle.

This is Knoten's own regression net - behaviour and dependency-version
changes are caught **here**, not in a downstream consumer like Messwerk.
The test deps (`@testing-library/*`, `react-dom`, `@happy-dom/*`) are
devDependencies and never ship (`files` is just `dist`), so invariant #1
still holds for the published package. Add a hook test for every
behavioural change.

### 7. The cache is permanent for the page's lifetime

Entries are created on first use and never evicted - no TTL, no GC. This is
the intended cache for stable, low-cardinality keys. Be wary of unbounded /
parameterized keys like `['search', term]`, which grow the store without
limit. (`useMutation` entries are the exception: keyed by `useId()`, they are
deleted on unmount so they don't leak.)

### 8. `initialData` seeds the cache and suppresses the initial fetch

When `initialData` is given, the entry is seeded with it and the automatic
initial fetch is skipped - on mount *and* on the first enable. It is treated
as already-fetched data, not a placeholder a fetch will replace. Consumers
who want a real fetch after enabling should `refetch()` / `invalidate()`. A
query with no loaded data (no entry, or an entry abandoned mid-flight) does
refetch on mount / key-change / re-enable; entries that hold data or an error
are reused (cache-first, no auto-retry).

## Commit + release conventions

- **Short, single-line conventional commits.** `fix:`, `feat:`, `refactor:`,
  `docs:`, `chore:`, `test:`. Body only when the *why* is non-obvious.
- **No `Co-Authored-By: Claude …` trailer.** Even when I produce most of the
  diff. The git log should read like one author wrote it.
- **Never auto-commit or auto-push.** Always wait for explicit approval
  before `git commit`, `git push`, or `git tag`.
- **Releases happen via `bun run release:*`.** That bumps `package.json`,
  creates a `vX.Y.Z` tag, and pushes - the GitHub Actions `publish.yml`
  workflow then runs `bun publish` on tag-push.

## File map

- `src/index.ts` - public re-exports
- `src/query.ts` - the entire library (cache store, `useQuery`, `useMutation`, `invalidate`)
- `src/query.test.ts` - pure unit tests (serialization, prefix, abort) via `__internals`
- `src/query.hooks.test.tsx` - end-to-end hook/component tests (happy-dom + Testing Library)
- `happydom.ts` / `bunfig.toml` - register the happy-dom test environment
- `tsconfig.json` - editor/typecheck config
- `tsconfig.build.json` - emits only `.d.ts` to `dist/`
- `.github/workflows/ci.yml` - test + build on push/PR
- `.github/workflows/publish.yml` - `bun publish` on `v*` tag (uses `NPM_TOKEN` secret)
