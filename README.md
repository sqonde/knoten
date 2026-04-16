# @sqonde/knoten

Hi 👋 - Knoten ("knot" in German) is a small, friendly little library that
gives React three things: `useQuery`, `useMutation`, and `invalidate`. Nothing
more, nothing magical. Just the data-fetching basics, the way I always wished
they were.

## Why does this exist?

Honest answer: I'm a happy little Zustand fanboy 💚. When I needed proper
data fetching in a React app - caching, polling, invalidation - I kept
reaching for TanStack Query but kept wishing it just *was* Zustand
underneath. So I built it that way.

Knoten is small, transparent, and sits comfortably on top of the state
library I already love. No new mental model. No clever tricks. A few hundred
lines of code that you can read in one sitting and reason about over a
coffee.

Knoten was carved out of the dashboard for *Messwerk*, the push-based
monitoring system I build for [elbtik.de](https://elbtik.de) - my small
freelance network-infrastructure business. The dashboard needed proper
data fetching, and rather than reach for a heavy library, I wanted
something small that I could fully understand. This is the result, kindly
extracted so others can use it too.

## Install

```bash
bun add @sqonde/knoten react zustand
```

`react` and `zustand` are peer dependencies - please install them yourself,
so we don't end up with two competing copies of either floating around in
your bundle.

## `useQuery`

```tsx
import { useQuery } from '@sqonde/knoten';

function Users() {
  const { data, isLoading, error } = useQuery(
    ['users'],
    (signal) => fetch('/api/users', { signal }).then((r) => r.json()),
    { interval: 5000 }, // poll every 5s while the tab is visible & online
  );

  if (isLoading) return <p>Loading…</p>;
  if (error) return <p>Error: {error.message}</p>;
  return <ul>{data.map((u) => <li key={u.id}>{u.name}</li>)}</ul>;
}
```

**Options:** `initialData`, `interval` (poll while the tab is active), `enabled`.

**Result:** `data`, `error`, `isLoading` (initial load),
`isRefetching` (background refresh), `isFetching` (either), `refetch`.

Polling pauses when the tab is hidden or you go offline, and picks back up
the moment you're back. It tries hard not to waste your bandwidth or your
battery.

## `useMutation` + `invalidate`

```tsx
import { useMutation } from '@sqonde/knoten';

function CreateUser() {
  const { mutate, isLoading } = useMutation(
    (name: string) =>
      fetch('/api/users', { method: 'POST', body: JSON.stringify({ name }) })
        .then((r) => r.json()),
    {
      invalidates: ['users'], // refetches every useQuery whose key starts with ['users']
      onSuccess: (user) => console.log('created', user),
    },
  );

  return (
    <button disabled={isLoading} onClick={() => mutate('Alice')}>
      Add Alice
    </button>
  );
}
```

You can also call `invalidate(['admin'])` directly - it refetches every
active query whose key starts with `['admin', ...]` (e.g. `['admin', 'users']`,
`['admin', 'tenants']`). Prefix matching keeps things ergonomic.

## Typing errors

Whatever your fetcher or mutator throws lands in `error` as-is — no
normalization, no wrapping. By default `error` is typed as `Error | null`,
but you can narrow it to your own class via the second generic:

```ts
class ApiError extends Error {
  requestId: string | null;
  // …
}

const { error } = useQuery<User[], ApiError>(['users'], fetchUsers);
// error is ApiError | null — error?.requestId is yours to use
```

The same works for `useMutation<Data, Vars, ApiError>(…)`.

Knoten stays out of your way - there's no built-in `fetch` wrapper, no
CSRF handling, no retry logic. Bring your own; Knoten will happily get
along with it.

## Contributing

I'd love your help. 🤝

If you're a **human** with an idea, a bug, a question, or just a friendly
hello - open an [issue](https://github.com/sqonde/knoten/issues) or a PR.
Knoten is intentionally small, but it can always be a little kinder, a
little clearer, a little better. Tiny improvements are very welcome.

If you're an **AI agent** helping someone work on this - welcome aboard,
you're part of the team too. The same rules apply: be honest about what you
change, write a real test for it, and keep the surface area small. The goal
is something humans and AI can both enjoy maintaining together.

## About me

Hey, I'm Moritz. [elbtik.de](https://elbtik.de) is my small freelance
network-infrastructure business, where I design, install, and monitor
networks for restaurants, hotels, medical practices, and coworking
spaces. Knoten is one of the little tools that came out of that work,
and elbtik is very much a Herzensprojekt of mine. If you found Knoten
helpful, swing by and say hi - I'd love to hear what you're building.

## License

MIT - use it, fork it, share it, make it yours.
