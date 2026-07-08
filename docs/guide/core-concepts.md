# Core Concepts

Three concepts, two namespaces.

## Tag

A **typed key**. Its nominal identity (the class + a literal `Id`) is what appears in
the requirement union `R`; the second type parameter is the service shape. Two
structurally identical services never collide.

Define a service by **inlining its shape** — the class _is_ the tag:

```ts
import { Tag } from "demesne";

class Logger extends Tag("Logger")<
  Logger,
  {
    readonly log: (msg: string) => void;
  }
>() {}
```

The identifier now names the **tag** (its nominal identity in `R`), **not** the service
shape — the tag type is deliberately distinct so two structurally identical services
never collide. When a signature needs the shape by name (a constructor parameter, a port
type), recover it with the exported **`ServiceOf`** helper — it accepts the tag instance
type or `typeof tag`:

```ts
import { type ServiceOf } from "demesne";

type LoggerService = ServiceOf<Logger>; // { readonly log: (msg: string) => void }
```

::: tip Domain entities stay named
A `Tag` is for a _service_ (a port). A domain entity like `Order` is just a `type` —
don't wrap it in a tag.
:::

## Context

An immutable map from tag to service. `get` only accepts a tag whose identity is in `R`
(reading an absent service is a compile error). It is **contravariant** in `R`: a
`Context<A | B>` works wherever a `Context<A>` is expected — a consumer asking for
_fewer_ services accepts a _richer_ context.

```ts
declare const ctx: Context<Logger>;
ctx.get(Logger); // ok
// ctx.get(Database) // compile error — Database is not in R
```

## Layer

A recipe that builds the services in `Provides`, possibly requiring `Needs` and possibly
failing with `E`:

```ts
Layer<Provides, E, Needs>;
```

Both `Needs` and `E` accumulate as **unions**: `Layer.merge` widens them,
`Layer.provideTo` subtracts from `Needs`. You can `Layer.build` only once `Needs` is
`never`. See [Layers & Wiring](./layers-and-wiring).

## The two namespaces

Operations are grouped so call sites read unambiguously:

- **`Layer.*`** — constructors (`value` / `factory` / `make` / `class` / `fromService`),
  resources (`acquireRelease`), multi-bindings (`member` / `collect`), lifecycle hooks
  (`onStart` / `onStop`), composition (`merge` / `provideTo`), introspection
  (`describe` / `toDot`), and the terminals (`build` / `scoped` / `forkScope`).
- **`Context.*`** — `empty` (reading a service is the instance method `ctx.get(tag)`).

`Context` and `Layer` are each **both a type and a value** — `Context<R>` /
`Context.empty()`, `Layer<P, E, N>` / `Layer.make(...)`. `Tag` and `Service` stay
top-level.
