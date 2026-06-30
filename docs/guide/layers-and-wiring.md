# Layers & Wiring

## The constructor family

Three constructors, distinguished by how construction is **qualified**. Do not collapse
them into a single value-or-function overload.

| constructor                 | sync/async        | can fail | needs context |
| --------------------------- | ----------------- | -------- | ------------- |
| `Layer.value(tag, service)` | ready value       | no       | no            |
| `Layer.factory(tag, f)`     | sync              | no       | yes           |
| `Layer.make(tag, f)`        | sync **or** async | yes      | yes           |

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
