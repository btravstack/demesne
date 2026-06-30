# Getting Started

## Install

demesne builds to an [`unthrown`](https://github.com/btravstack/unthrown) `AsyncResult`,
so `unthrown` is a peer dependency — install both:

```sh
pnpm add demesne unthrown
```

::: tip Requirements
demesne requires `unthrown` `^2.0.0` and a TypeScript strict-mode setup. It ships dual
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

Next: [Core Concepts](./core-concepts) for `Tag` / `Context` / `Layer`, then
[Layers & Wiring](./layers-and-wiring) to compose a real graph.

::: info Runnable example
A complete, type-checked program — laid out by clean-architecture layer and compiled in
CI — lives in
[`examples/clean-architecture`](https://github.com/btravstack/demesne/tree/main/examples/clean-architecture).
:::
