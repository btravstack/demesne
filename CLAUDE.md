# demesne — authoritative spec

**Type-safe dependency injection: a container holds your services' domain and provides it; requirements and construction errors are tracked in the type system. demesne does the wiring — `unthrown` does the error handling.**

This file is the source of truth. If code and this file disagree, one of them is a
bug. Tests must guard the invariants below; do not "fix" a failing test by weakening
an invariant.

## Thesis (do not drift)

A _demesne_ is the domain a lord holds in his own hands and provisions directly. So
is this library: a `Context<R>` is the typed domain of services you hold, and a
`Layer` is a recipe that constructs part of it. The whole point is that **two things
are tracked in the type system and discharged before you can run**:

1. **Requirements** (`Needs`) — every port a graph still depends on. You cannot
   `Layer.build` until `Needs` is `never`.
2. **Construction errors** (`E`) — every way wiring can fail. `Layer.build` produces an
   `unthrown` `AsyncResult<Context<P>, E>` whose error is the _static union_ of all
   of them, handled once at the edge.

demesne **does one thing: wiring.** It is not a monad and has no effect runtime of
its own. Async and failure are first-class only because construction _builds to an
`unthrown` `AsyncResult`_ — error handling stays delegated to `unthrown`. The name
states the concern: the domain you hold in hand and provision directly, nothing more.

`unthrown` is a **peer dependency**, not a bundled one. demesne re-uses its
`Result` / `AsyncResult` / `Ok` / `Err` / `fromPromise` / `allAsync` / `TaggedError`;
it never re-implements them.

## Load-bearing invariants (tests must guard these)

### 1. Requirements and errors accumulate as unions

`Needs` and `E` are unions. `Layer.merge` widens both (`NA | NB`, `EA | EB`).
`Layer.provideTo` **subtracts** from `Needs` with `Exclude<N, P2> | N2` while still
unioning `E` (`E | E2`). Requirements are modeled as a **union, not an intersection**,
precisely because TypeScript can remove a union member (`Exclude`) but cannot remove an
intersection member — discharging a dependency _is_ removing a member, so the union
encoding is the one that type-checks. `Layer.build` is callable only when `Needs` is
`never`. _(Guarded by the type-level tests: un-wired layer rejected by `Layer.build`;
the error channel of a merged graph is exactly `EA | EB`, not narrowable to one arm.)_

### 2. Requirements are declared at boundaries, not inferred from usage

Without a monad there is no `R` channel threaded through every call. Instead a
consumer **declares the ports it needs** in its `Context<R>` signature
(`Layer.factory(OrderRepository, (ctx: Context<DatabaseService>) => …)`). This is the deliberate trade
versus Effect's inferred `R`: for hexagonal / DDD code, an explicit port list at the
boundary is a _feature_, not a limitation. Do not try to infer `Needs` from `ctx.get`
calls inside a factory body.

### 3. Tag identity is nominal via the class + literal `Id`

Two structurally identical services must never collide in `R`. A `Tag` is created
from a class plus a literal `Id` string; the constructor returns a distinct
`TagInstance<Id, Service>` (**not** `Self`) so that `class X extends Tag("X")<X, S>()`
is legal without the class referencing itself as a base type. The literal `Id` keeps
instance types nominal. _(Guarded by: reading an absent tag is a compile error.)_

**Definition convention — inline the shape; the class IS the tag.** Prefer a single
declaration with the service shape inlined over a separate `interface` + short tag
class:

```ts
class LoggerService extends Tag("LoggerService")<
  LoggerService,
  {
    readonly log: (msg: string) => void;
  }
>() {}
```

This is exactly the self-referential form the `TagInstance` trick exists to permit.
The consequence is that the identifier names the **tag**, not the service shape — so
domain entities (e.g. `Order`) stay named types, and any signature that needs a
service's shape by name recovers it with
`type ServiceOf<T> = T extends Tag<unknown, infer S> ? S : never` (definable in
userland, since `Tag` is exported). Do **not** reintroduce a parallel `interface` per
service.

### 4. The `Layer` type's `build` member is a property, not a method — NEVER change this

The `Layer<P, E, N>` type's `build` member (distinct from the `Layer.build(...)`
runner) is declared as a **property of function type**
(`readonly build: (ctx: Context<Needs>) => …`), not a method
(`build(ctx): …`). Method parameters are checked **bivariantly** in TypeScript; a
method would let a `Context<never>` be passed where a `Context<SomeNeed>` is required
and an un-wired `Layer` would slip past `Layer.build`. A property function type restores
strict **contravariance** in `Needs`, which is exactly what makes a missing
dependency a real compile error. **Never turn the `build` member into a method.**

### 5. `Context` is contravariant in `R`

`Context<in R>` carries a phantom `_R: (r: R) => void`. A `Context<A | B>` is
assignable wherever a `Context<A>` is expected — a consumer asking for _fewer_
services accepts a _richer_ context. _(Guarded by the type-level test.)_

### 6. Construction qualification mirrors `unthrown`

Async / fallible work enters **only** through `Layer.make`, whose factory returns a
`Result` or `AsyncResult`. A raw `Promise` must **never** enter a combinator: an
unqualified rejection would silently become a `Defect` instead of a modeled error.
Re-enter the typed world at the boundary with `fromPromise` / `fromSafePromise`. The
`Layer.make` implementation lifts both sync `Result` and `AsyncResult` uniformly via
`Ok(undefined).toAsync().flatMap(() => f(ctx))` — no runtime type-sniffing.

### 7. The constructor family stays distinct

Three constructors, by construction qualification — do **not** collapse them into a
single value-or-function overload:

- **`Layer.value(tag, service)`** — an already-built value. Needs nothing, cannot fail.
- **`Layer.factory(tag, f)`** — built synchronously and infallibly from the context.
- **`Layer.make(tag, f)`** — may fail and/or be async; `f` returns a `Result`/`AsyncResult`
  whose error type becomes the layer's `E`.

### 8. `Layer.merge` builds in parallel; failure semantics are fixed

`Layer.merge` is **variadic** — it combines any number of independent layers (at least
one) and builds them concurrently via `allAsync`. The **first `Err` short-circuits**; a
thrown value becomes a **`Defect`** (it dominates). Provides, errors, and requirements
all union across every layer. _(Guarded by the runtime spec: timing interleave, Err
short-circuit, throw → Defect, and an N-way merge.)_

### 9. Operations are namespaced under `Layer` / `Context`

The public value surface is grouped into companion objects so a reader can tell a
Layer operation from a Context one: `Layer.{value,factory,make,merge,provideTo,build}`
and `Context.{empty}`. `Context` and `Layer` are each **both a type and a value**
(`Context<R>` / `Context.empty()`, `Layer<P, E, N>` / `Layer.make(...)`). `Tag` stays
top-level — it names a service and builds neither. Do not re-flatten these into
top-level function exports.

## Roadmap invariants — NOT yet met (state them so they aren't mistaken for done)

These are deliberately **out of scope** for the initial release. The code is shaped
so they slot in later; do not assume them in consumer code yet.

- **Single construction of shared layers (memoization).** A layer referenced from
  two branches is currently built **once per branch** (i.e. twice). There is no
  `MemoMap` yet. The runtime spec asserts the current count is `2` as a guard — flip
  it to `1` when memoization lands. Do **not** implement memoization as part of init.
- **Ordered teardown (scopes / `acquireRelease`).** There is no scope or resource
  finalization story yet; layers acquire but never release. A `Scope` /
  `acquireRelease` story comes later.

## Toolchain (mirrors `unthrown`)

pnpm + turborepo monorepo. Build with **tsdown** (dual CJS/ESM + `.d.mts`/`.d.cts`).
Lint/format with **oxlint** + **oxfmt**. Strict shared tsconfig at
`@demesne/tsconfig/base.json`. Tests: **vitest** for `*.spec.ts` (runtime) and `tsc`
for `*.test-d.ts` (type-level); `typecheck` runs both. Docs via **typedoc**. Release
via **changesets** + conventional commits, with **lefthook** hooks and **knip**.

> **Note on the core.** `packages/core/src/index.ts` originated as a verified DI core,
> vendored verbatim at init, and is now maintained here (e.g. `merge` was made
> variadic). It deliberately uses `interface` declarations and internal `any` casts
> (the value-level wiring is necessarily unsafe under the typed surface).
> `.oxlintrc.json` and `.oxfmtrc.json` therefore scope off `no-explicit-any` /
> `consistent-type-definitions` (and formatting) **only** for that one file; the rules
> stay enforced everywhere else.
