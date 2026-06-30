---
layout: home
title: demesne — type-safe dependency injection for TypeScript
description: A container holds your services' domain and provides it. Requirements and construction errors are tracked in the type system. The wiring sibling of unthrown.

hero:
  name: "demesne"
  text: "Type-safe dependency injection"
  tagline: A container holds your services' domain and provides it — with requirements and construction errors tracked in the type system. The wiring sibling of unthrown.
  image:
    src: /logo.svg
    alt: demesne
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Why demesne?
      link: /guide/why-demesne
    - theme: alt
      text: GitHub
      link: https://github.com/btravstack/demesne

features:
  - icon: 🧩
    title: Requirements as a static union
    details: A dependency you forgot to wire is a compile error. You cannot build until every requirement is discharged — Needs must be never.
  - icon: 🎯
    title: Errors as a static union
    details: Every way construction can fail is in the result type. Handle the whole union once, at the edge, as an unthrown AsyncResult.
  - icon: 🛡️
    title: Boundaries, not magic
    details: No decorators, no reflect-metadata, no runtime container that drifts from the types. Ports are declared in Context<R> signatures.
  - icon: 🪶
    title: Does one thing — wiring
    details: No monad, no effect runtime of its own. Async and failure are first-class only because construction builds to an unthrown AsyncResult.
---

## At a glance

```ts
import { type Context, Layer, Tag } from "demesne";
import { Err, Ok, type Result, TaggedError } from "unthrown";

// A port: the class IS the tag; the service shape is inlined.
class AppConfig extends Tag("AppConfig")<AppConfig, { readonly dbUrl: string }>() {}

class ConfigError extends TaggedError("ConfigError")<{ reason: string }> {}

// A layer — sync but fallible. The error type is inferred from the Err you return.
const ConfigLive = Layer.make(AppConfig, () => {
  const url = "postgres://localhost/app";
  return url.startsWith("postgres://")
    ? Ok({ dbUrl: url })
    : Err(new ConfigError({ reason: "DATABASE_URL must be a postgres:// url" }));
});

// Build at the edge — the error channel is the static union of every failure.
const result = await Layer.build(ConfigLive);
//    ^? Result<Context<AppConfig>, ConfigError>

const dbUrl = result.match({
  ok: (ctx) => ctx.get(AppConfig).dbUrl,
  err: (e) => `config failed: ${e.reason}`,
  defect: (cause) => `panic: ${String(cause)}`,
});
```

Forget to wire a dependency and `Layer.build` is a **compile error**. Add a new
fallible layer and its error type appears in the union your `match` must handle.
demesne does the wiring; [`unthrown`](https://github.com/btravstack/unthrown) does the
error handling.
