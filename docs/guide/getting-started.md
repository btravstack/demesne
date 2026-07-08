# Getting Started

## Install

demesne builds to an [`unthrown`](https://github.com/btravstack/unthrown) `AsyncResult`,
so `unthrown` is a peer dependency — install both:

```sh
pnpm add demesne unthrown
```

::: tip Requirements
demesne requires `unthrown` `^3.0.0` and a TypeScript strict-mode setup. It ships dual
CJS/ESM with full type declarations.
:::

## Your first graph

A service is a **tag** (the class _is_ the tag; the shape is inlined). A **layer**
builds it. You `Layer.build` once every requirement is wired.

```ts
import { type Context, Layer, Tag } from "demesne";
import { Err, Ok, type Result, TaggedError } from "unthrown";

// 1. A port.
class AppConfig extends Tag("AppConfig")<AppConfig, { readonly dbUrl: string }>() {}

// 2. A modeled construction error.
class ConfigError extends TaggedError("ConfigError")<{ reason: string }> {}

// 3. A layer — sync but fallible. The service shape comes from the tag and the
//    error type is inferred from the Err you return, so neither is annotated.
const ConfigLive = Layer.make(AppConfig, () => {
  const url = "postgres://localhost/app"; // from env in real code
  return url.startsWith("postgres://")
    ? Ok({ dbUrl: url })
    : Err(new ConfigError({ reason: "DATABASE_URL must be a postgres:// url" }));
});
//    ^? Layer<AppConfig, ConfigError, never>

// 4. Build at the edge and handle the result.
const result = await Layer.build(ConfigLive);
//    ^? Result<Context<AppConfig>, ConfigError>

console.log(
  result.match({
    ok: (ctx) => ctx.get(AppConfig).dbUrl,
    err: (e) => `config failed: ${e.reason}`,
    defect: (cause) => `panic: ${String(cause)}`,
  }),
);
```

## What you just got

- **`ctx.get(AppConfig)`** only type-checks because `AppConfig` is in the context — read
  a tag you didn't provide and it's a compile error.
- **`result`** is an `unthrown` `Result` whose error channel is exactly `ConfigError` —
  add another fallible layer and that union grows, and `match` must handle it.

## Wire one service from another

Real graphs have dependencies. A service is usually a **class built from ports** — so declare
its dependencies as a tag list and `Layer.class` does the `new` for you (no hand-written
factory), type-checked against the constructor. `Layer.provideTo` feeds one layer into another,
**discharging** the requirement it satisfies.

```ts
import { Layer, type ServiceOf, Tag } from "demesne";
// ...continuing from above (AppConfig / ConfigLive), plus `ServiceOf` in the import.

class Database extends Tag("Database")<
  Database,
  { readonly query: (sql: string) => unknown[] }
>() {}

// A plain class — no demesne import — that needs AppConfig in its constructor.
class PgDatabase {
  constructor(private readonly config: ServiceOf<AppConfig>) {}
  query(_sql: string) {
    void this.config.dbUrl; // connect with the configured url…
    return [];
  }
}

// demesne constructs `new PgDatabase(config)` for you; the tag list is checked against the ctor.
const DatabaseLive = Layer.class(Database, [AppConfig], PgDatabase);
//    ^? Layer<Database, never, AppConfig>

// Feed ConfigLive in to discharge the AppConfig requirement, then build (Needs is now never).
const DatabaseWired = Layer.provideTo(DatabaseLive, ConfigLive);
//    ^? Layer<Database, ConfigError, never>

const ctx = (await Layer.build(DatabaseWired)).unwrap();
ctx.get(Database).query("select 1");
```

A dependency you forget to thread stays in `Needs`, and `Layer.build` names it as a compile
error. Prefer **one** declaration and don't mind the class extending a demesne base? [`Service`
fuses the tag, the injected fields and the layer](./layers-and-wiring#constructor-injection-layer-class-and-service).
And to _see_ a graph you've composed, `Layer.toDot(DatabaseWired)` prints it as Graphviz DOT.

Next: [Core Concepts](./core-concepts) for `Tag` / `Context` / `Layer`, then
[Layers & Wiring](./layers-and-wiring) to compose a real graph.

::: info Runnable example
A complete, type-checked program — a clean-architecture Hono REST API with zod, Prisma and the
full combinator surface, compiled and tested in CI — lives in
[`examples/hono-prisma-api`](https://github.com/btravstack/demesne/tree/main/examples/hono-prisma-api).
:::
