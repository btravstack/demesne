# Why demesne?

A _demesne_ is the domain a lord holds in his own hands and provisions directly. So is
this library: a `Context<R>` is the typed domain of services you hold, and a `Layer` is
a recipe that constructs part of it.

## The problem

Decorator / `reflect-metadata` DI containers bind a **token** to an implementation at
runtime. The token and the type it is supposed to carry can drift apart — a provider
returns the wrong shape, a dependency is never registered — and you find out as a
**runtime** failure, often far from the wiring. The graph's failure modes are invisible
to the compiler.

demesne moves both of those into types:

- A dependency you forgot to wire is a **compile error**.
- Every way construction can fail is a **static union** in the result type, so you
  handle it once, exhaustively, at the edge.

## The thesis (does one thing: wiring)

demesne is **not** a monad and has no effect runtime of its own. Async and failure are
first-class only because construction _builds to an [`unthrown`](https://github.com/btravstack/unthrown)
`AsyncResult`_ — error handling stays delegated to `unthrown`. The name states the
concern: the domain you hold in hand and provision directly, nothing more.

`unthrown` is a **peer dependency**, not a bundled one. demesne re-uses its `Result` /
`AsyncResult` / `Ok` / `Err` / `fromPromise` / `allAsync` / `TaggedError`; it never
re-implements them.

## Two things tracked in the type system

1. **Requirements** (`Needs`) — every port a graph still depends on. You cannot
   `Layer.build` until `Needs` is `never`.
2. **Construction errors** (`E`) — every way wiring can fail. `Layer.build` produces an
   `AsyncResult<Context<P>, E>` whose error is the static union of all of them.

Both accumulate as unions: `Layer.merge` widens them, `Layer.provideTo` subtracts from
`Needs`. This is what makes a missing dependency a real compile error and the failure
set something you handle once.

## The deliberate trade vs Effect

Without a monad there is no `R` channel threaded through every call. Instead a consumer
**declares the ports it needs** in its `Context<R>` signature. For hexagonal / DDD code,
an explicit port list at the boundary is a _feature_, not a limitation — see
[Clean Architecture](./clean-architecture).
