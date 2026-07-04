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
instance types nominal. The one runtime-unsound corner is **duplicate ids**: two distinct
tag classes sharing an `Id` are distinct types but the same runtime map key, so one silently
reads the other's service — `Tag` therefore **warns** (once per id, never throws) when an id
repeats. Ids must be globally unique. _(Guarded by: reading an absent tag is a compile error;
the spec asserts the duplicate-id warning.)_

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
The consequence is that the identifier names the **tag** (its nominal identity in `R`),
not the service shape — so domain entities (e.g. `Order`) stay named types, and any
signature that needs a service's shape by name recovers it with the exported
**`ServiceOf<T>`** helper (it accepts the tag instance type, `ServiceOf<Logger>`, or
`typeof tag`). The tag type being distinct from the service shape is load-bearing for
nominal identity — do **not** make the tag usable directly as the service, and do
**not** reintroduce a parallel `interface` per service.

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
Layer operation from a Context one: `Layer.{value,factory,make,acquireRelease,member,merge,
provideTo,collect,onStart,onStop,build,scoped,forkScope}` and
`Context.{empty}`. Assembly is single-pass and fully type-checked — graphs are composed by
hand with `provideTo` / `merge`; there is **no auto-wiring** (see the "no `wire`" note in
Accepted constraints). `Context` and `Layer` are each **both a
type and a value** (`Context<R>` / `Context.empty()`, `Layer<P, E, N>` /
`Layer.make(...)`). `Tag` stays top-level — it names a service and builds neither. Do
not re-flatten these into top-level function exports.

### 10. A `BuildState` is threaded through every build (memoization + teardown)

Every `build` receives an internal `BuildState` carrying a **memo map** and a
**finalizer list**.

- **Memoization.** `buildMemo` keys layers by **reference**: a layer shared across
  branches (same object) constructs **once** per build, and the in-flight `AsyncResult`
  is reused (so concurrent `merge` branches don't double-build). The memo map is
  per-`build`/`scoped` call — separate builds reconstruct. _(Guarded by the spec: a
  layer shared across two branches constructs once; separate builds reconstruct.)_
- **Ordered teardown.** `acquireRelease(tag, acquire, release)` registers `release`
  with the scope. `scoped(layer, use)` builds, runs `use`, then closes the scope —
  running finalizers in **reverse acquisition order (LIFO)**, whether `use` succeeded,
  failed, or the build failed partway. `release` is expected to be infallible; teardown
  is best-effort (a throwing release does not abort the others). _(Guarded by the spec:
  LIFO order, release-on-failure, best-effort teardown.)_

### 11. `Scope` is a phantom requirement — `build` rejects unreleased resources

`acquireRelease` returns `Layer<Self, E, Needs | Scope>`, where **`Scope`** is a phantom
marker (never a runtime value) tracked in the `Needs` channel — the same trick Effect
uses with `Scope` in `R`. `merge` / `provideTo` propagate it (no layer ever _provides_
`Scope`), so any graph containing a resource layer carries `Scope` in `Needs`. Because
`build` requires `Needs = never`, it is a **compile error** to `build` a scope-needing
graph — it can never silently drop finalizers. `scoped` takes `Layer<P, E, Scope>`,
which (by `Layer`'s covariance in `Needs`) accepts both `Scope` graphs and scope-free
ones (`never <: Scope`), while still rejecting a real unmet service. Do **not** relax
`scoped` back to `Needs = never` or drop `Scope` from `acquireRelease`. _(Guarded by the
type-level tests: `build` rejects a resource layer; `scoped` accepts it and a plain one;
a real unmet service is rejected.)_

### 12. `forkScope` layers a request scope on a built parent

`forkScope(parent, requestLayer, use)` builds `requestLayer` against an already-built
`parent` context — a **fresh `BuildState` per call**, so every fork gets its own instances
— runs `use` with the merged `Context<Parent | ReqP>`, then closes **only the fork's**
scope (LIFO). The parent (and its singletons) is never torn down and can be forked again.
The request layer's requirements are constrained to `Parent | Scope`, so reading a service
the parent doesn't provide is a compile error; errors union as `AsyncResult<A, E | E2>`
(build error `E`, `use` error `E2`), and the fork closes on either. This is the
per-request lifetime — call it **once per request**. Do **not** thread the parent's
`BuildState` into the fork (that would leak request resources into the app scope) or reuse
one fork across requests. _(Guarded by the spec: shares parent + adds request services;
releases request resources LIFO with the parent untouched; fresh instances per fork;
release-on-`use`-failure. And the type-level tests: parent inferred; a request layer
needing a non-parent service is rejected.)_

### 13. Multi-bindings: `member` contributes, `collect` concatenates

A **collection tag** is a tag whose service is a `readonly Item[]`. `member(collectionTag, f)`
is a single contribution — it mirrors `factory` (sync, infallible) and provides the tag with
a **one-element** array; a fallible / async contribution is a `make` returning a one-element
array instead (the constructor family stays distinct by qualification — do **not** collapse
`member` into a value-or-Result overload). `collect(collectionTag, members)` builds every
member in **parallel** (memoized, first `Err` short-circuits, à la `merge`), reads each
member's array for the tag's key, **concatenates them in listed order** (flattening, so a
member may contribute several items), and provides the tag with the full array. Members are
constrained to `Layer<Self, any, any>` for the same `Self` (a foreign tag is a compile
error); errors and requirements union across members via `ErrorOf`/`NeedsOf`, and an empty
list is an empty collection (`Layer<Self, never, never>`). collect must **not** use
`mergeContext` (same-key provisions would overwrite, not accumulate) — it reads and concats
each member's array by hand. No runtime registry; the port list stays declared at boundaries.
_(Guarded by the spec: listed-order concat, per-member needs discharged with `provideTo`,
mixed member + `make` flattening, empty collection, first-`Err` short-circuit, and a member
whose context lacks the key. And the type-level tests: member Needs inferred, collect unions
error/needs, empty collection type, foreign tag rejected.)_

### 14. Lifecycle hooks: `onStart` runs post-build (FIFO), `onStop` tears down (LIFO)

`onStart(layer, hook)` and `onStop(layer, hook)` attach lifecycle steps **distinct from
construction**, threaded through the same `BuildState`. `onStart` pushes to `startHooks`; the
terminals (`build` / `scoped` / `forkScope`) run them via `runStartHooks` **after the whole
graph is built, before `use`, sequentially, in registration order (construction-completion
order)**. That is dependency-respecting for a _dependent_ hook (it registers after its deps,
since the dependent builds later), but **not a total topological sort**: two hooks on
_independent_ parallel branches (built under `merge`/`collect`) run in a nondeterministic
relative order. Don't rely on cross-branch start-hook ordering. A start hook is **fallible** — it returns a
`Result` / `AsyncResult` whose error **unions into the layer's `E`**, and the first `Err`
short-circuits startup before `use` (the scope still closes). `onStop` pushes a **finalizer**
(same list as `acquireRelease`, run **LIFO** on scope close) and therefore adds **`Scope`** to
`Needs` — the graph must be consumed with `scoped`; its hook is **infallible**, mirroring
`release`. Both are **combinators** (decorate an existing layer), so they must **infer the
whole layer as `L extends Layer<any,any,any>`** and pull channels with `ProvidesOf`/`ErrorOf`/
`NeedsOf`; inferring `N` from a `Layer<P,E,N>` parameter directly degrades to `any`
(contravariant position). Do **not** run start hooks eagerly at
construction (they must see the fully-built graph), and do **not** make `onStop` fallible or
scope-free (teardown is best-effort and needs the `Scope` discipline). `onStop` is **not**
redundant with `acquireRelease`: the latter acquires _and_ releases a resource; `onStop` adds
shutdown to a service built some other way. _(Guarded by the spec: dependency-order start
before `use`, start under plain `build`, failed-hook abort with error union, scope-closes-on-
failed-hook, LIFO stop order. And the type-level tests: `onStart` unions the hook error and
keeps `Needs`; `onStop` adds `Scope` so `build` rejects it and `scoped` accepts it.)_

## Accepted constraints (design choices)

Deliberate design choices, documented so they aren't rediscovered as bugs:

- **No auto-wiring (`wire` was removed).** demesne does **not** resolve build order at
  runtime. Automatic assembly is fundamentally at odds with the model: with eager,
  synchronous `ctx.get` and erased types, the only way to discover order is to run factories
  and retry the ones that read a not-yet-ready dep — which re-runs side effects (and leaks
  resources whose `acquire` opens before a deferred read), and turns cycles into runtime
  Defects rather than compile errors. So there is exactly one way to assemble: hand-thread
  with `provideTo` / `merge`, which is single-pass, deterministic, and fully type-checked
  (a missing dependency is a compile error). This is the sharp edge of the thesis: everything
  is discharged before you run. (`override` rode on `wire` and was removed with it.)
- **Custom combinators must infer the whole layer.** A user-written combinator that takes
  `Layer<P, E, N>` and infers `N` gets `any` — `Needs` is contravariant and degrades. The
  built-in decorators (`onStart`, `onStop`) infer `L extends Layer<any,any,any>` and pull
  channels via `ProvidesOf` / `ErrorOf` / `NeedsOf`. Anyone extending demesne must do the same.
- **The test seam is parameterization, not `override`.** To swap a real adapter for a fake,
  make the volatile dependency a parameter of the composition (a `bootstrap(repository)`
  function threaded with `provideTo` / `merge`); the server passes the real adapter, a test
  passes an in-memory fake. The swap is deep (every consumer that captured the port sees the
  fake) and fully type-checked.
- **No manual `Scope` handle.** A scope's lifetime IS the `use` callback of `scoped` /
  `forkScope`; there is no "open, hold, close later" handle. A long-lived app keeps the `use`
  promise open until a shutdown signal (see the example's `server.ts`), then teardown runs.
  Resource lifetimes stay lexically bounded (bracket-style) — deliberate, not Effect's
  freestanding `Scope.make`.
- **`unthrown` is a lockstep peer.** demesne re-uses unthrown's `Result` / `AsyncResult` and
  never re-implements them; the `peerDependencies` range (`^3`) tracks unthrown's major, so a
  breaking unthrown release requires a matching demesne major.

## Roadmap — ideas from the wider DI ecosystem

The wiring core is complete. Three roadmap items are **now implemented**: `Layer.forkScope`
(request / child scopes, see invariant #12); `Layer.member` / `Layer.collect` (multi-bindings,
see invariant #13); and `Layer.onStart` / `Layer.onStop` (lifecycle hooks, see invariant #14).
`Layer.wire` (automatic assembly) and `Layer.override` (deep test override) were implemented
and then **removed** — they were the only parts that resolved at runtime, which is inherently
at odds with the "everything discharged before you run" thesis (see Accepted constraints).
Remaining future work, borrowed selectively from mature DI systems **without** violating the
thesis:

1. **Graph introspection / DOT export** (from fx, Dagger) — a debugging aid. A read-only
   diagnostic; since assembly is hand-threaded `provideTo` / `merge`, a truthful graph would
   walk the composed `Layer` structure at runtime (types are erased).

Already solved elegantly, document it as the answer: **assisted injection**
(injected deps + call-time args) is the constructor-injected use-case pattern
(`new UseCase(ports).execute(arg)`) — most frameworks bolt on a whole mechanism for this.

**Do NOT adopt** (they break the thesis): reflection / decorator auto-wiring (trades
compile-time safety for runtime), a monad / effect runtime (error handling stays with
`unthrown`), codegen (types already give compile-time safety), inferring `Needs` from usage
(requirements are declared at boundaries), or **runtime auto-assembly** (this is exactly what
`wire` did and why it was cut — order resolution belongs to the human composing `provideTo` /
`merge`, checked by the compiler). See `docs/guide/comparison.md` for the full landscape.

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
