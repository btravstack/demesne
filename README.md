# demesne

> **Type-safe dependency injection — the wiring sibling of [`unthrown`](https://github.com/btravstack/unthrown).**
> A container holds your services' domain (a typed `Context`) and provides it.
> Requirements **and** construction errors are tracked in the type system: you cannot
> `build` until every dependency is wired, and the set of wiring failures is a static
> union you handle once at the edge.

📖 **[Documentation](https://btravstack.github.io/demesne/)** ·
[Guide](https://btravstack.github.io/demesne/guide/getting-started) ·
[API Reference](https://btravstack.github.io/demesne/api/core/)

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

  The identifier now names the tag (its nominal identity in `R`), **not** the service
  shape. When a signature needs the shape by name, recover it with the exported
  `ServiceOf<Logger>` helper.

- **`Context<R>`** — an immutable map from tag to service. `get` only accepts a tag
  whose identity is in `R` (reading an absent service is a compile error). It is
  **contravariant** in `R`: a `Context<A | B>` works wherever a `Context<A>` is asked.
- **`Layer<Provides, E, Needs>`** — a recipe that builds the services in `Provides`,
  possibly requiring `Needs` and possibly failing with `E`. Both `Needs` and `E`
  accumulate as **unions**: `Layer.merge` widens them, `Layer.provideTo` subtracts
  from `Needs`. You can `Layer.build` only once `Needs` is `never`.

Operations are grouped under two namespaces so call sites read unambiguously:
`Layer.*` (constructors, combinators, `build`) and `Context.*` (`empty`). `Context`
and `Layer` are each both a **type** and a **value** — `Context<R>` / `Context.empty()`,
`Layer<P, E, N>` / `Layer.make(...)`. `Tag` stays top-level.

Layer constructors, by how construction is qualified:

| constructor                                   | sync/async        | can fail | needs context | teardown |
| --------------------------------------------- | ----------------- | -------- | ------------- | -------- |
| `Layer.value(tag, service)`                   | ready value       | no       | no            | no       |
| `Layer.factory(tag, f)`                       | sync              | no       | yes           | no       |
| `Layer.make(tag, f)`                          | sync **or** async | yes      | yes           | no       |
| `Layer.acquireRelease(tag, acquire, release)` | sync **or** async | yes      | yes           | yes      |

## Example

demesne maps directly onto a clean / hexagonal architecture: the **domain** stays pure,
the **application** depends only on **ports**, **adapters** implement those ports, and a
single **composition root** binds them together. Here is one small use case — fetch an
order — organised by layer. (It's one program, split by layer for the walk-through.)

### Domain

Entities and domain errors. Pure TypeScript — no demesne, no I/O.

```ts
// domain/order.ts
import { TaggedError } from "unthrown";

type Order = { readonly id: string; readonly total: number };

// the order doesn't exist — a domain-level failure, modeled as a value
class OrderNotFound extends TaggedError("OrderNotFound")<{ id: string }> {}
```

### Ports

The boundaries the application speaks to, as `Tag`s (the class **is** the tag; the
shape is inlined). A port's own operations return unthrown results too, so `findById`
is an `AsyncResult` rather than a bare `Order | null`.

```ts
// application/ports.ts
import { Tag } from "demesne";
import { type AsyncResult } from "unthrown";

class Logger extends Tag("Logger")<
  Logger,
  {
    readonly log: (msg: string) => void;
  }
>() {}

class OrderRepository extends Tag("OrderRepository")<
  OrderRepository,
  {
    readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
  }
>() {}
```

### Application

A use case, **wired by demesne**. The implementation is a class with constructor-injected
ports and a single public `execute` method — it uses no demesne types, so its signature
says only what it asks for (an order id) and returns. A `Layer.factory` performs the
constructor injection, so the use case joins the typed graph: `Layer.build` won't compile
until its ports are wired, and the rest of the app resolves it with `ctx.get(GetOrder)`.

```ts
// application/get-order.ts
import { type Context, Layer, type ServiceOf, Tag } from "demesne";
import { type AsyncResult } from "unthrown";
import { Logger, OrderRepository } from "./ports.js";

// The use case logic — constructor DI, one public method, framework-agnostic.
class GetOrderInteractor {
  constructor(
    private readonly logger: ServiceOf<Logger>,
    private readonly orders: ServiceOf<OrderRepository>,
  ) {}

  execute(id: string): AsyncResult<Order, OrderNotFound> {
    this.logger.log(`looking up order ${id}`);
    return this.orders.findById(id);
  }
}

// The use case as a port other code resolves from the context.
export class GetOrder extends Tag("GetOrder")<GetOrder, GetOrderInteractor>() {}

// The application layer: constructor injection performed inside a factory.
export const GetOrderLive = Layer.factory(
  GetOrder,
  (ctx: Context<Logger | OrderRepository>) =>
    new GetOrderInteractor(ctx.get(Logger), ctx.get(OrderRepository)),
);
```

### Adapters

Concrete `Layer`s that implement the ports — the only layer that touches
infrastructure. Its own plumbing tags (`AppConfig`, `Database`) and infrastructure
errors live here, and each constructor matches a construction qualification:
`Layer.value` (ready), `Layer.make` (fallible / async), `Layer.factory` (sync).

```ts
// adapters/*.ts
import { type Context, Layer, type ServiceOf, Tag } from "demesne";
import { Err, fromPromise, Ok, TaggedError } from "unthrown";

// infrastructure-only tags — not application ports
class AppConfig extends Tag("AppConfig")<AppConfig, { readonly dbUrl: string }>() {}
class Database extends Tag("Database")<
  Database,
  {
    readonly query: (sql: string) => readonly unknown[];
  }
>() {}

// infrastructure errors — these surface as the wiring error union
class ConfigError extends TaggedError("ConfigError")<{ reason: string }> {}
class ConnectionError extends TaggedError("ConnectionError")<{ url: string }> {}

// console logger — ready, cannot fail
const LoggerLive = Layer.value(Logger, { log: (m) => console.log(`[log] ${m}`) });

// env-backed config — sync but fallible. The service shape comes from the tag and
// the error type is inferred from the `Err` you return, so neither is annotated.
const ConfigLive = Layer.make(AppConfig, () => {
  const url = "postgres://localhost/app"; // from env in real code
  return url.startsWith("postgres://")
    ? Ok({ dbUrl: url })
    : Err(new ConfigError({ reason: "DATABASE_URL must be a postgres:// url" }));
});
//    ^? Layer<AppConfig, ConfigError, never>

// pooled connection — async + fallible; needs AppConfig
const connectDb = (url: string): Promise<ServiceOf<Database>> =>
  url.includes("localhost")
    ? Promise.resolve({ query: () => [] })
    : Promise.reject(new Error("connection refused"));

const DatabaseLive = Layer.make(Database, (ctx: Context<AppConfig>) => {
  const { dbUrl } = ctx.get(AppConfig);
  return fromPromise(connectDb(dbUrl), () => new ConnectionError({ url: dbUrl }));
});

// the OrderRepository port, backed by Database. The factory is sync + infallible;
// the repo's findById returns an AsyncResult carrying a modeled OrderNotFound.
const OrderRepoLive = Layer.factory(OrderRepository, (ctx: Context<Database>) => {
  const db = ctx.get(Database);
  return {
    findById: (id) => {
      const row = db.query(`select * from orders where id = '${id}'`)[0] as Order | undefined;
      return (row ? Ok(row) : Err(new OrderNotFound({ id }))).toAsync();
    },
  };
});
```

### Composition root

Bind adapters to ports, then wire the **application layer** of use cases on top.
`Layer.build` runs the whole graph once at the edge (handling every **wiring** failure
as a static union); you then resolve a use case from the built context and call
`execute`. The built context exposes only the use cases — the infrastructure stays
hidden.

```ts
// main.ts
import { Layer } from "demesne";

// Infrastructure — adapters wired to their ports.
const DatabaseWired = Layer.provideTo(DatabaseLive, ConfigLive);
const OrderRepoWired = Layer.provideTo(OrderRepoLive, DatabaseWired);
const ServicesLayer = Layer.merge(LoggerLive, OrderRepoWired);
//    ^? Layer<Logger | OrderRepository, ConnectionError | ConfigError, never>

// Application — use cases, constructor-injected from the services.
const AppLayer = Layer.provideTo(GetOrderLive, ServicesLayer);
//    ^? Layer<GetOrder, ConnectionError | ConfigError, never>

const wiring = await Layer.build(AppLayer);
//    ^? Result<Context<GetOrder>, ConnectionError | ConfigError>

if (wiring.isOk()) {
  // Resolve the wired use case and run it — demesne already injected its ports.
  const order = await wiring.unwrap().get(GetOrder).execute("order-1");
  console.log(
    order.match({
      ok: (o) => `order ${o.id}: ${o.total}`,
      err: (notFound) => `no such order: ${notFound.id}`,
      defect: (cause) => `query panicked: ${String(cause)}`,
    }),
  );
} else {
  // every WIRING failure, handled once as a static union
  const e = wiring.unwrapErr();
  console.error(e._tag === "ConfigError" ? `config failed: ${e.reason}` : `db failed: ${e.url}`);
}
```

Forget to wire `ConfigLive`, and `Layer.build(AppLayer)` is a **compile error** —
`Needs` is not `never`. Add a new fallible `Layer.make` anywhere in an adapter, and its
error type appears in the wiring union that `match` must handle.

> This whole example is a real program in
> [`examples/clean-architecture`](./examples/clean-architecture) — one file per layer,
> compiled by `tsc` against demesne's built types in CI. The snippets above can't drift
> from working code.

## Design notes

- **Requirements are declared at boundaries.** A consumer states the ports it needs
  in its `Context<R>` signature, rather than having them inferred from usage. This is
  the deliberate trade versus Effect's inferred `R` channel — for hexagonal / DDD
  code, an explicit port list is a feature.
- **No monad.** demesne does the wiring and nothing else. Async and failure are
  first-class only because construction builds to an `unthrown` `AsyncResult`.
- **A `Layer`'s `build` member is a property, not a method.** Method parameters are
  checked bivariantly in TypeScript, which would let an un-wired layer slip past. A
  property function type keeps strict contravariance in `Needs`, so a missing
  dependency is a real compile error. (This is the `build` field on the `Layer` type —
  distinct from the `Layer.build(...)` runner.)
- **Qualify at the boundary.** Async / fallible work enters only through `Layer.make`;
  a raw `Promise` must never enter a combinator. Re-enter the typed world with
  `fromPromise` / `fromSafePromise`, exactly as in `unthrown`.

## Configuration (recipe)

Reading config from the environment and validating it is just a **fallible `Layer.make`**
fed by [`@unthrown/standard-schema`](https://github.com/btravstack/unthrown/tree/main/packages/standard-schema) —
demesne adds no config primitive of its own (that would break "does one thing: wiring").
The schema → `Result` bridge already lives in unthrown's ecosystem; demesne only wires
the validated result.

Inject the raw environment as a **port** rather than reaching for `process.env` inside
the layer — it keeps config testable (fake env in tests, real env at the edge) and is
the boundary-declared style demesne favours.

```ts
import { type Context, Layer, Tag } from "demesne";
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
const AppConfigLive = Layer.make(AppConfig, (ctx: Context<Env>) =>
  fromSchema(ConfigSchema)(ctx.get(Env)).mapErr((issues) => new ConfigError({ issues })),
);
//    ^? Layer<AppConfig, ConfigError, Env>

// Wire the env at the composition edge.
const result = await Layer.build(Layer.provideTo(AppConfigLive, Layer.value(Env, process.env)));
//    ^? Result<Context<AppConfig>, ConfigError>
```

Use `fromSchemaAsync` instead if your schema validates asynchronously — it returns an
`AsyncResult`, which `Layer.make` accepts unchanged. If you find yourself repeating this trio,
it promotes cleanly into a thin `@demesne/standard-schema` adapter package (the monorepo
is built to grow that way) — but it does **not** belong in the core.

## Resources & memoization

A build threads a **scope** through every layer:

- **Memoization** — a layer shared across branches constructs **once** per `build`
  (keyed by reference), and the result is reused. No more double-construction.
- **`acquireRelease` + `scoped`** — acquire a resource and register its release;
  `Layer.scoped(layer, use)` builds, runs `use`, then releases every resource in
  reverse order (LIFO), whether `use` succeeded or failed.

```ts
const PoolLive = Layer.acquireRelease(
  Pool,
  () => fromPromise(openPool(), (c) => new PoolError({ cause: c })),
  (pool) => pool.close(), // released after `use`, in reverse acquisition order
);

const summary = await Layer.scoped(provideTo(RepoLive, PoolLive), (ctx) =>
  ctx.get(OrderRepository).findById("order-1"),
);
// pool is closed here, even if findById failed
```

> `Layer.build` does not close the scope (finalizers never run) — use `Layer.scoped`
> for graphs with `acquireRelease` layers.

## Roadmap

The wiring core is complete (memoization and scoped resources included). A possible
future refinement is **type-level scope enforcement** — tracking a `Scope` requirement
in the type so `build` rejects unreleased resource layers at compile time (today that's
a documented convention, not a compile error). See [`CLAUDE.md`](./CLAUDE.md).

## License

[MIT](./LICENSE) © Benoit TRAVERS
