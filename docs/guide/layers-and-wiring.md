# Layers & Wiring

## The constructor family

Constructors, distinguished by how construction is **qualified**. Do not collapse the
first three into a single value-or-function overload.

| constructor                                    | sync/async        | can fail | needs context | teardown |
| ---------------------------------------------- | ----------------- | -------- | ------------- | -------- |
| `Layer.value(tag, service)`                    | ready value       | no       | no            | no       |
| `Layer.factory(tag, f)`                        | sync              | no       | yes           | no       |
| `Layer.make(tag, f)`                           | sync **or** async | yes      | yes           | no       |
| `Layer.acquireRelease(tag, acquire, release)`  | sync **or** async | yes      | yes           | yes      |

```ts
// value — an already-built service.
const LoggerLive = Layer.value(Logger, { log: (m) => console.log(m) });

// factory — built synchronously and infallibly from the context.
const RepoLive = Layer.factory(OrderRepository, (ctx: Context<Database>) => {
  const db = ctx.get(Database);
  return { findById: (id) => /* … */ };
});

// make — may fail and/or be async; returns a Result or AsyncResult.
const ConfigLive = Layer.make(AppConfig, () =>
  ok ? Ok({ dbUrl }) : Err(new ConfigError({ reason })),
);
```

### Inference: you rarely annotate

`Layer.make<Self, Service, E, Needs>` infers both channels:

- **`Service`** is pinned by the **tag**, so the value shape never needs annotating.
- **`E`** is inferred from what `f` **returns** — returning `Err(new ConfigError(...))`
  makes `E = ConfigError` on its own.

```ts
const ConfigLive = Layer.make(AppConfig, () =>
  cond ? Ok({ dbUrl }) : Err(new ConfigError({ reason })),
);
//    ^? Layer<AppConfig, ConfigError, never>   — inferred, no annotation
```

Annotate only to **declare a failure the body doesn't currently produce** (a path that
returns only `Ok` today but is contractually fallible — inference would give
`E = never`), or for a `throw`-only body.

## Qualify at the boundary

Async / fallible work enters **only** through `Layer.make`. A raw `Promise` must never
enter a combinator — an unqualified rejection would silently become a `Defect` instead
of a modeled error. Re-enter the typed world with `fromPromise` / `fromSafePromise`,
exactly as in `unthrown`:

```ts
const DatabaseLive = Layer.make(Database, (ctx: Context<AppConfig>) => {
  const { dbUrl } = ctx.get(AppConfig);
  return fromPromise(connectDb(dbUrl), () => new ConnectionError({ url: dbUrl }));
});
```

## Combinators

### `Layer.provideTo` — discharge a requirement

Feed one layer into another. `provideTo(self, dep)` builds `dep` first; on success
`self` builds with the merged context. Errors union; the shared requirement is
**subtracted** from `Needs` (`Exclude<N, P2> | N2`).

```ts
const DatabaseWired = Layer.provideTo(DatabaseLive, ConfigLive);
//    ^? Layer<Database, ConnectionError | ConfigError, never>
```

### `Layer.merge` — combine independent layers

Variadic: combine **any number** of independent layers in one call. They build in
**parallel** (`allAsync`); the first `Err` short-circuits and a thrown value becomes a
`Defect`. Provides, errors, and requirements all union across every layer.

```ts
const AppLayer = Layer.merge(LoggerLive, RepoWired, DatabaseWired);
//    ^? Layer<Logger | OrderRepository | Database, ConnectionError | ConfigError, never>
```

### `Layer.wire` — assemble a set automatically

`merge` builds its layers _independently_ (they don't feed each other); `provideTo`
threads one into another _by hand_. **`Layer.wire`** does the threading for you: each
layer's requirements may be satisfied by **any other layer in the set**, so you list them
in any order and wire resolves the dependency graph.

```ts
// before — hand-threaded, order matters
const DatabaseWired = Layer.provideTo(DatabaseLive, ConfigLive);
const RepoWired = Layer.provideTo(OrderRepoLive, DatabaseWired);
const AppLayer = Layer.merge(LoggerLive, RepoWired, DatabaseWired);

// after — one call, any order
const AppLayer = Layer.wire(OrderRepoLive, LoggerLive, ConfigLive, DatabaseLive);
//    ^? Layer<OrderRepository | Logger | AppConfig | Database, ConnectionError | ConfigError, never>
```

wire provides the **union of every service** (intermediates included), unions the errors,
and its remaining `Needs` are exactly the services **no layer in the set provides**. So a
self-contained set is `Needs = never` (ready to `build`), and a missing dependency stays
in the type — `build` names it as a compile error.

::: tip Runtime & limits
wire builds each layer a round at a time against the services built so far (a layer that
reads a not-yet-built dependency is deferred), so **order doesn't matter**. A first `Err`
short-circuits; a genuine dependency **cycle** surfaces as a `Defect` that names the
services involved (the types can't catch cycles). Composed layers (`onStart`, `collect`,
`provideTo`, …) are fine as members. One caveat: because a deferred layer's build is
**re-run** each round, a factory / `acquire` passed to wire should be idempotent and read
its dependencies **before** any side effect — otherwise the effect repeats (and an
`acquire` that opens a resource before reading a deferred dep leaks it).
:::

### `Layer.override` — swap providers in an assembled graph

The testing seam. **`Layer.override(base, patches)`** takes a `Layer.wire`-assembled graph
and a list of patch layers whose providers **win**, keeping everything else — swap a real
adapter for a fake without hand-rewiring the graph.

```ts
const AppLayer = Layer.wire(GetOrderLive, LoggerLive, OrderRepoLive, DatabaseLive, ConfigLive);

// in a test — same graph, one provider swapped:
const TestApp = Layer.override(AppLayer, [Layer.value(OrderRepository, fakeRepo)]);
const ctx = (await Layer.build(TestApp)).unwrap();
ctx.get(OrderRepository); // the fake — and so does every layer that consumed it
```

The override is **deep**: a use case that captured `OrderRepository` in its constructor
sees the fake too — not just a direct `ctx.get`. That's why `base` must be a `wire` result
(only that carries the source layers to re-assemble); a plain, already-built layer has
consumed its dependencies and is a compile error here. The provides union gains any new
tag a patch introduces, errors union, and a patch that supplies a tag the base needed
externally **discharges** that requirement.

::: tip Patches are usually `Layer.value`
Overrides are typically `Layer.value(Tag, fake)`. A patch may also be a `factory` / `make`,
but it may only depend on services available **outside** the base (the base's own services
aren't threaded into it). The base's original provider for a patched tag still runs — so if
you override a resource (`acquireRelease`) tag, the base resource is still acquired and
released; its value is simply discarded.
:::

### `Layer.member` + `Layer.collect` — multi-bindings

Sometimes a port has **many** implementations that all matter — request middlewares,
health checks, event subscribers, plugins. **`Layer.collect`** accumulates them into a
single `readonly Item[]` service, with no runtime registry.

Define a **collection tag** whose service is the array, then contribute members:

```ts
type Plugin = { readonly name: string; readonly handle: (r: Req) => Res };
class Plugins extends Tag("Plugins")<Plugins, readonly Plugin[]>() {}

// each `member` is one contribution, built from its own ports:
const AuthLive = Layer.member(Plugins, (ctx: Context<Config>) => authPlugin(ctx.get(Config)));
const MetricsLive = Layer.member(Plugins, () => metricsPlugin());
const TracingLive = Layer.member(Plugins, () => tracingPlugin());

const AllPlugins = Layer.collect(Plugins, [AuthLive, MetricsLive, TracingLive]);
//    ^? Layer<Plugins, never, Config>   — Plugins resolves to readonly Plugin[]

const app = Layer.wire(ConfigLive, AllPlugins, /* …consumers of Plugins… */);
ctx.get(Plugins); // [auth, metrics, tracing] — in listed order
```

collect builds the members in **parallel** (memoized, first `Err` short-circuits),
concatenates their items **in listed order**, and provides the tag with the full array.
Errors and requirements **union** across every member; an empty list is an empty collection.

::: tip Fallible / async contributions, and multiple items
`member` mirrors `factory` — synchronous and infallible. For a contribution that can fail
or is async, use `Layer.make(Plugins, …)` returning a `Result` / `AsyncResult` of a
**one-element array**; collect accepts any layer that provides the collection tag, and
**flattens** each member's array, so a single member may contribute several items.
:::

### `Layer.build` — run a fully-wired layer

Callable only once `Needs` is `never`. The `AsyncResult` still carries `E`, since
construction itself may fail — you handle it at the edge.

```ts
const result = await Layer.build(AppLayer);
//    ^? Result<Context<Logger | OrderRepository | Database>, ConnectionError | ConfigError>
```

::: warning `Layer.build` vs the `build` member
`Layer.build(layer)` is the runner. It's distinct from the `build` _member_ on the
`Layer` type, which is a **property** (not a method) on purpose — that's what gives
`Needs` its strict contravariance, making a missing dependency a real compile error.
:::

A build also **memoizes**: a layer shared across branches constructs once. For resources
that need teardown, see [Resources & Scopes](./roadmap).

### `Layer.acquireRelease` + `Layer.scoped` — resources

`Layer.acquireRelease(tag, acquire, release)` builds a service and registers its release.
`Layer.scoped(layer, use)` builds, runs `use`, then releases every resource in reverse
order (LIFO) — even if `use` fails.

```ts
const PoolLive = Layer.acquireRelease(
  Pool,
  () => fromPromise(openPool(), (cause) => new PoolError({ cause })),
  (pool) => pool.end(),
);
//    ^? Layer<Pool, PoolError, Scope>

const result = await Layer.scoped(PoolLive, (ctx) => useThePool(ctx.get(Pool)));
// pool released here, whatever the outcome
```

`acquireRelease` puts a phantom `Scope` in the layer's requirements, so `Layer.build`
**rejects a resource graph at compile time** — you're forced to use `Layer.scoped`.
Full details in [Resources & Scopes](./roadmap).
