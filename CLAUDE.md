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
bun test                 # Run the unit tests (bun:test)
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
- `useMutation<T, V = void, E = Error>(mutator, options?)` → `{ mutate, isLoading, error, reset }`
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
remove this - it's what makes rapid invalidations and prop changes safe.

### 5. Polling is visibility- and online-aware

The polling effect listens to `visibilitychange` + `online`/`offline`.
Polling pauses when the tab is hidden and resumes (with an immediate
refetch) when it returns. Don't add a "poll always" option - that's a
footgun for users' batteries.

### 6. Tests run without a DOM

`src/query.test.ts` only exercises `serializeKey`, `isPrefixMatch`, and the
`invalidate()` registry. Hook-level behaviour is covered downstream in
Messwerk's integration tests. Keep this file dependency-free (no React, no
DOM) so it stays fast.

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
- `src/query.test.ts` - unit tests for serialization + invalidation registry
- `tsconfig.json` - editor/typecheck config
- `tsconfig.build.json` - emits only `.d.ts` to `dist/`
- `.github/workflows/ci.yml` - test + build on push/PR
- `.github/workflows/publish.yml` - `bun publish` on `v*` tag (uses `NPM_TOKEN` secret)
