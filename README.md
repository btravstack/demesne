# demesne

> **Type-safe dependency injection — the wiring sibling of [`unthrown`](https://github.com/btravstack/unthrown).**
> A container holds your services' domain (a typed `Context`) and provides it.
> Requirements **and** construction errors are tracked in the type system: you cannot
> `build` until every dependency is wired, and the set of wiring failures is a static
> union you handle once at the edge.

```sh
pnpm add demesne unthrown
```

`unthrown` is a peer dependency — demesne builds to an `unthrown` `AsyncResult`, so
async and failure are first-class while error handling stays delegated to `unthrown`.

## The problem

Decorator / `reflect-metadata` DI containers bind a **token** to an implementation at
runtime. The token and the type it is supposed to carry can drift apart — a provider
returns the wrong shape, a dependency is never registered — and you find out as a
**runtime** failure, often far from the wiring. The graph's failure modes are
invisible to the compiler.

demesne moves both of those into types. A dependency you forgot to wire is a
**compile error**. Every way construction can fail is a **static union** in the
result type, so you handle it once, exhaustively, at the edge.

## The model

Three concepts:

- **`Tag<Self, Service>`** — a typed key. Its nominal identity (the class + a literal
  `Id`) is what appears in the requirement union `R`; the second parameter is the
  service shape. Two structurally identical services never collide. Define a service
  by inlining its shape — the class **is** the tag:

  ```ts
  class LoggerService extends Tag("LoggerService")<
    LoggerService,
    {
      readonly log: (msg: string) => void;
    }
  >() {}
  ```

  The identifier now names the tag, not the shape; recover the shape by name with
  `type ServiceOf<T> = T extends Tag<unknown, infer S> ? S : never` when a signature
  needs it.

- **`Context<R>`** — an immutable map from tag to service. `get` only accepts a tag
  whose identity is in `R` (reading an absent service is a compile error). It is
  **contravariant** in `R`: a `Context<A | B>` works wherever a `Context<A>` is asked.
- **`Layer<Provides, E, Needs>`** — a recipe that builds the services in `Provides`,
  possibly requiring `Needs` and possibly failing with `E`. Both `Needs` and `E`
  accumulate as **unions**: `merge` widens them, `provideTo` subtracts from `Needs`.
  You can `build` only once `Needs` is `never`.

Constructors, by how construction is qualified:

| constructor           | sync/async        | can fail | needs context |
| --------------------- | ----------------- | -------- | ------------- |
| `value(tag, service)` | ready value       | no       | no            |
| `factory(tag, f)`     | sync              | no       | yes           |
| `make(tag, f)`        | sync **or** async | yes      | yes           |

## Example

A small graph — a logger, config, a database connection, and an order repository —
built in five steps. Everything below is one program; it's split only to walk through it.

### 1. Define the services (ports)

The class **is** the tag; inline the service shape. A service's own operations are
unthrown results too, so `findById` returns an `AsyncResult` rather than `Order | null`.

```ts
import { Tag } from "demesne";
import { type AsyncResult } from "unthrown";

// Recover a service's shape from its tag when a signature wants it by name.
type ServiceOf<T> = T extends Tag<unknown, infer S> ? S : never;

class LoggerService extends Tag("LoggerService")<
  LoggerService,
  {
    readonly log: (msg: string) => void;
  }
>() {}

class AppConfig extends Tag("AppConfig")<AppConfig, { readonly dbUrl: string }>() {}

class DatabaseService extends Tag("DatabaseService")<
  DatabaseService,
  {
    readonly query: (sql: string) => readonly unknown[];
  }
>() {}

// Order is a domain entity, not a service — it stays a named type.
type Order = { readonly id: string; readonly total: number };

class OrderRepository extends Tag("OrderRepository")<
  OrderRepository,
  {
    readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
  }
>() {}
```

### 2. Model the errors

Two kinds: failures that can happen while **wiring** (construction), and a failure a
**wired service** can return from an operation.

```ts
import { TaggedError } from "unthrown";

// Construction (wiring) errors ...
class ConfigError extends TaggedError("ConfigError")<{ reason: string }> {}
class ConnectionError extends TaggedError("ConnectionError")<{ url: string }> {}
// ... and an operation error a wired service can return.
class OrderNotFound extends TaggedError("OrderNotFound")<{ id: string }> {}
```

### 3. Write the layers

One constructor per construction qualification: `value` (ready), `factory` (sync,
infallible), `make` (fallible and/or async).

```ts
import { factory, make, value, type Context } from "demesne";
import { Err, fromPromise, Ok, type Result } from "unthrown";

// value: a ready service — needs nothing, cannot fail.
const LoggerLive = value(LoggerService, { log: (m) => console.log(`[log] ${m}`) });

// make: sync but FALLIBLE — returns a Result; its error joins the E channel.
const ConfigLive = make(AppConfig, (): Result<ServiceOf<typeof AppConfig>, ConfigError> => {
  const url = "postgres://localhost/app";
  return url.startsWith("postgres://")
    ? Ok({ dbUrl: url })
    : Err(new ConfigError({ reason: "DB_URL must be a postgres:// url" }));
});

// make: ASYNC and fallible — needs AppConfig; fromPromise qualifies the rejection.
const connectDb = (url: string): Promise<ServiceOf<typeof DatabaseService>> =>
  url.includes("localhost")
    ? Promise.resolve({ query: () => [] })
    : Promise.reject(new Error("connection refused"));

const DatabaseLive = make(DatabaseService, (ctx: Context<AppConfig>) => {
  const { dbUrl } = ctx.get(AppConfig);
  return fromPromise(connectDb(dbUrl), () => new ConnectionError({ url: dbUrl }));
});

// factory: the factory itself is sync + infallible (it just assembles the repo),
// but the repo's findById returns an AsyncResult carrying a modeled OrderNotFound.
const OrderRepoLive = factory(OrderRepository, (ctx: Context<DatabaseService>) => {
  const db = ctx.get(DatabaseService);
  return {
    findById: (id) => {
      const row = db.query(`select * from orders where id = '${id}'`)[0] as Order | undefined;
      return (row ? Ok(row) : Err(new OrderNotFound({ id }))).toAsync();
    },
  };
});
```

### 4. Wire the graph

`provideTo` feeds one layer into another and **discharges** the shared requirement;
`merge` combines independent layers. Requirements and errors accumulate as unions.

```ts
import { merge, provideTo } from "demesne";

const DatabaseWired = provideTo(DatabaseLive, ConfigLive);
//    ^? Layer<DatabaseService, ConnectionError | ConfigError, never>
const RepoWired = provideTo(OrderRepoLive, DatabaseWired);
const AppLayer = merge(merge(LoggerLive, RepoWired), DatabaseWired);
//    ^? Layer<LoggerService | OrderRepository | DatabaseService, ConnectionError | ConfigError, never>
```

### 5. Build at the edge

`build` is callable only once `Needs` is `never`. You then handle **two distinct
unthrown results**: the wiring union from `build`, and — one level down — each service
operation's own union.

```ts
import { build } from "demesne";

const wiring = await build(AppLayer);
//    ^? Result<Context<LoggerService | OrderRepository | DatabaseService>, ConnectionError | ConfigError>

if (wiring.isOk()) {
  const ctx = wiring.unwrap();
  ctx.get(LoggerService).log("app wired");

  // A service operation is itself an unthrown AsyncResult — await it and handle
  // its own error union the same way.
  const message = await ctx
    .get(OrderRepository)
    .findById("order-1")
    .match({
      ok: (order) => `found order ${order.id}`,
      err: (notFound) => `no such order: ${notFound.id}`,
      defect: (cause) => `query panicked: ${String(cause)}`,
    });
  console.log(message);
} else {
  const e = wiring.unwrapErr();
  console.error(e._tag === "ConfigError" ? `config failed: ${e.reason}` : `db failed: ${e.url}`);
}
```

Forget to wire `ConfigLive`, and `build(AppLayer)` is a **compile error** — `Needs`
is not `never`. Add a new fallible `make`, and its error type appears in the union
that `match` must handle.

## Design notes

- **Requirements are declared at boundaries.** A consumer states the ports it needs
  in its `Context<R>` signature, rather than having them inferred from usage. This is
  the deliberate trade versus Effect's inferred `R` channel — for hexagonal / DDD
  code, an explicit port list is a feature.
- **No monad.** demesne does the wiring and nothing else. Async and failure are
  first-class only because construction builds to an `unthrown` `AsyncResult`.
- **`build` is a property, not a method.** Method parameters are checked bivariantly
  in TypeScript, which would let an un-wired layer slip past. A property function
  type keeps strict contravariance in `Needs`, so a missing dependency is a real
  compile error.
- **Qualify at the boundary.** Async / fallible work enters only through `make`; a
  raw `Promise` must never enter a combinator. Re-enter the typed world with
  `fromPromise` / `fromSafePromise`, exactly as in `unthrown`.

## Configuration (recipe)

Reading config from the environment and validating it is just a **fallible `make`** fed
by [`@unthrown/standard-schema`](https://github.com/btravstack/unthrown/tree/main/packages/standard-schema) —
demesne adds no config primitive of its own (that would break "does one thing: wiring").
The schema → `Result` bridge already lives in unthrown's ecosystem; demesne only wires
the validated result.

Inject the raw environment as a **port** rather than reaching for `process.env` inside
the layer — it keeps config testable (fake env in tests, real env at the edge) and is
the boundary-declared style demesne favours.

```ts
import { build, type Context, make, provideTo, Tag, value } from "demesne";
import { fromSchema, type SchemaIssues } from "@unthrown/standard-schema";
import { type Result, TaggedError } from "unthrown";
import { z } from "zod"; // any Standard Schema validator (zod / valibot / arktype)

// The raw environment is a provided port.
class Env extends Tag("Env")<Env, Record<string, string | undefined>>() {}

const ConfigSchema = z.object({ dbUrl: z.string().url() });
class AppConfig extends Tag("AppConfig")<AppConfig, z.infer<typeof ConfigSchema>>() {}

// A modeled, discriminated error for the E channel (nicer at the edge than a raw
// issues array). Drop the `mapErr` if `SchemaIssues` is fine for you.
class ConfigError extends TaggedError("ConfigError")<{ issues: SchemaIssues }> {}

// Sync + fallible: validate the injected env against the schema.
const AppConfigLive = make(AppConfig, (ctx: Context<Env>) =>
  fromSchema(ConfigSchema)(ctx.get(Env)).mapErr((issues) => new ConfigError({ issues })),
);
//    ^? Layer<AppConfig, ConfigError, Env>

// Wire the env at the composition edge.
const result = await build(provideTo(AppConfigLive, value(Env, process.env)));
//    ^? Result<Context<AppConfig>, ConfigError>
```

Use `fromSchemaAsync` instead if your schema validates asynchronously — it returns an
`AsyncResult`, which `make` accepts unchanged. If you find yourself repeating this trio,
it promotes cleanly into a thin `@demesne/standard-schema` adapter package (the monorepo
is built to grow that way) — but it does **not** belong in the core.

## Roadmap

demesne ships the wiring core today. Two capabilities are deliberately **not yet**
implemented (see [`CLAUDE.md`](./CLAUDE.md) for the invariants):

1. **Memoization** — a shared `MemoMap` so each layer constructs **once** across a
   `build`. Today a layer referenced from two branches is built once _per branch_.
2. **Scopes / `acquireRelease`** — ordered resource teardown. Today layers acquire
   but never release.

## License

[MIT](./LICENSE) © Benoit TRAVERS
