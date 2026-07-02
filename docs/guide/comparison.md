# Comparison

How demesne relates to other dependency-injection approaches. The short version: most
DI resolves the graph at **runtime** (via reflection/decorators) and fails late; demesne
tracks the graph in the **type system** and fails at compile time — and it's the only one
that also models **construction failures as values**.

## At a glance

|                                 | **demesne**                | **Effect** (`Layer`)     | **InversifyJS / tsyringe** | **typed-inject**   | **NestJS DI**       |
| ------------------------------- | -------------------------- | ------------------------ | -------------------------- | ------------------ | ------------------- |
| Wiring model                    | typed `Layer` algebra      | typed `Layer` (in a monad) | container + bindings     | typed provider chain | module + providers |
| Missing dependency              | **compile error**          | **compile error**        | ❌ runtime throw           | **compile error**  | ❌ runtime throw    |
| Decorators / `reflect-metadata` | ❌ none                    | ❌ none                  | ✅ required                | ❌ none            | ✅ required         |
| Construction errors             | **typed union `E`**        | in the effect's `E`      | throws                     | throws             | throws              |
| Resource scopes (acquire/release) | ✅ `acquireRelease` + type-enforced `scoped` | ✅ `Scope` | ✅ (runtime scopes) | ❌ | ✅ (`OnModuleDestroy`) |
| Requirements tracking           | declared at boundaries     | inferred (`R` channel)   | implicit                   | inferred           | implicit            |
| Async construction              | ✅ (parallel via `merge`)  | ✅                       | partial                    | ❌                 | ✅                  |
| Runtime model                   | none (builds to `AsyncResult`) | a full effect runtime | a container                | a container        | a container         |
| Lifetimes                       | singleton-per-build (memoized) | scoped / global      | singleton/transient/request | singleton         | singleton/request/transient |
| Footprint                       | tiny, 0 runtime deps       | large                    | small–medium               | tiny               | large (framework)   |

## The differences that actually matter

### 1. Compile-time vs. runtime failure

Reflection/decorator containers (Inversify, tsyringe, Nest, and most of the mainstream)
bind a token to an implementation at runtime. Forget to register something and you learn
about it when the container throws — often far from the wiring, sometimes in production.

demesne puts the requirement set in the type. A layer that still needs a service has that
service in its `Needs`, and `Layer.build` is callable only when `Needs` is `never`. A
missing dependency is a **red squiggle**, not a stack trace. (Effect, ZIO, typed-inject
and the codegen tools — Dagger, wire — share this property; the reflective containers
don't.)

### 2. Construction failures are values

Wiring can fail: a bad config, a refused connection, a failed migration. Every other DI
system **throws** in that case. demesne threads those failures through the layer's `E`
channel, so `Layer.build` yields an `unthrown` `AsyncResult<Context<P>, E>` whose error is
the **static union of every way the graph can fail** — handled once, exhaustively, at the
edge. This is the property that's genuinely demesne's own, and it falls straight out of
building on [`unthrown`](https://github.com/btravstack/unthrown).

### 3. No monad (the trade vs. Effect)

demesne is essentially **Effect's `Context` / `Layer` / `Tag`, minus the effect runtime**
(the vocabulary and the tag construction are deliberately near-identical). The cost of
dropping the monad is that requirements aren't _inferred_ from usage — a consumer
**declares** the ports it needs in its `Context<R>` signature (or, for a use case, its
constructor). For hexagonal / DDD code, that explicit boundary is a feature, not a
regression. If you want the whole effect system — concurrency, interruption, streams,
retries — reach for Effect; demesne does one thing: wiring, and delegates errors to
unthrown.

## Beyond TypeScript

The `Layer` idea comes from **Scala's ZIO `ZLayer`** (and Effect ported it to TS).
Compile-time DI without reflection also lives in **Dagger** (Kotlin/Java), **google/wire**
(Go), and **MacWire** (Scala) — but via code generation, whereas demesne gets the same
guarantee from types alone. On the other end, **.NET**, **Spring**, **Guice**, and
**Koin** resolve at runtime with rich lifetime/scope models but late failure. And a whole
camp — idiomatic **Rust** (`AppState` + extractors), **Go** "pure DI", **Ruby** POROs —
argues you often need no framework at all: demesne's `Context<R>` _is_ that hand-assembled
state, just type-checked.

## When another library is the better fit

- **You want a full effect system** (concurrency, fibers, streams, retries, tracing) →
  **Effect** or **ZIO**. demesne is not that; it's the wiring slice.
- **You want zero-boilerplate auto-wiring and don't mind runtime failure** → a reflective
  container (**tsyringe**, **InversifyJS**) or a framework (**NestJS**).
- **You're already in a framework with its own DI** (Nest, Angular) → use theirs.
- **You just need to pass a few dependencies around** → you may need no DI library at all;
  a plain object of services and constructor injection is fine.

demesne is the right fit when you want **compile-time-safe wiring with typed construction
errors, no decorators, and no runtime**, sitting alongside `unthrown`.
