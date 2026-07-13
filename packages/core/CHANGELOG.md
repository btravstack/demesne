# demesne

## 0.2.0

### Minor Changes

- 918ec7c: Add **`Layer.forkScope`** — request / child scopes on top of a built parent context.

  `Layer.forkScope(parent, requestLayer, use)` builds `requestLayer` against an
  already-built `parent` (a fresh scope per call, so every fork gets its own instances),
  runs `use` with the merged `Context<Parent | ReqP>`, then releases **only the fork's**
  resources (LIFO) — the parent and its singletons stay alive and can be forked again. The
  request layer's requirements are constrained to `Parent | Scope`, so reading a service the
  parent doesn't provide is a compile error; build and `use` errors union as
  `AsyncResult<A, E | E2>`, and the fork closes either way. This is the per-request lifetime
  that makes demesne usable for HTTP servers: build singletons once, `forkScope` once per
  request.

- 3a4f907: Add `Layer.describe` and `Layer.toDot` — read-only graph introspection.

  Because graphs are composed by hand (`provideTo` / `merge`), it helps to see them.
  `Layer.describe(root)` walks the composed layer into a normalized `{ nodes, edges }` model
  (`LayerGraph`), and `Layer.toDot(root)` renders it as Graphviz DOT. It is a **debugging aid
  only — no factory runs** (safe on `acquireRelease` graphs; it reflects the composed structure,
  not a live build). To support it, every constructor / combinator now records optional
  structural `meta` on the layer; a hand-built `{ build }` layer without `meta` is opaque and
  contributes nothing.

  The graph is honest about what it can know: edges are **exact** for `value` / `class` /
  `Service` (their dependency keys are known at runtime) and **inferred** (`edge.inferred`,
  dashed in DOT) for `factory` / `make` / `acquireRelease` / `member`, whose per-service
  requirements live only in the erased `Needs` type — those edges are reconstructed from the
  `provideTo` composition (exact about the wiring, may over-approximate usage).

- 6edbe44: Initial release of **demesne** — type-safe dependency injection that complements
  `unthrown`. A container holds your services' domain (a typed `Context`) and
  provides it; requirements and construction errors are tracked in the type system,
  so you cannot `build` until every dependency is wired, and the set of wiring
  failures is a static union you handle once at the edge as an `unthrown`
  `AsyncResult`.

  Surface: `Tag` / `Context` / `Layer`, the `value` / `factory` / `make`
  constructors, and the `merge` / `provideTo` / `build` combinators.

- 4524215: Add `Layer.class` and `Service` — constructor injection without a hand-written factory.

  Most services are a class built from ports, and writing `ctx => new UseCase(ctx.get(A),
ctx.get(B))` by hand is boilerplate. Two sugars let demesne do the instantiation, with the
  dependencies type-checked against the constructor — the `asClass` (Awilix) / `Effect.Service`
  ergonomic, kept fully compile-time-safe. Both are infallible (`E = never`; a throwing
  constructor becomes a `Defect`, like `factory`).

  - **`Layer.class(tag, [deps], Ctor)`** — constructs a **plain** class (no demesne import) from
    a tag list. The list is checked against the constructor's parameters (wrong order / type /
    arity is a compile error), and its tags' identities become the layer's `Needs`.
  - **`Service<Self>()(id, { deps })`** + **`Layer.fromService(Cls)`** — the fused
    `Effect.Service` analog: one class declaration is the Tag and the injected `this.dep` fields
    (typed from the record), and `Layer.fromService(Cls)` builds its layer. The trade is that the
    class extends a demesne base; for a `Service`, the tag's identity and service shape coincide
    (`Tag<Self, Self>`). Instances also construct directly for tests (`new Cls({ dep })`, no
    container).

  The two are complementary — `Layer.class` injects **any** constructor (including one you don't
  own); `Service` fuses tag + injection for a class you author. Unchanged: `value` / `factory` /
  `make` / `acquireRelease` remain the primitives; these are additive.

- 1d29e0f: `Layer.inject` — record-based injection for function-shaped services, and a full-DI example.

  - **`Layer.inject(tag, {deps}, f)`** builds any value (typically a closure — a one-method
    use case) by injecting a deps record into a plain function: no interactor class, no
    hand-annotated `Context<...>`, no `ctx.get` lines. It is the function-shaped sugar beside
    `Layer.class` (tag list → constructor) and `Service` (fused class): sync and infallible
    like `factory` (a throw becomes a `Defect`), with `Needs` declared by the record. The
    record is runtime-known, so `inject` layers get **exact** edges in `Layer.describe` /
    `Layer.toDot`. `f` also receives the typed context, which serves as a `forkScope` parent —
    an injected service (e.g. an HTTP app) can open per-request scopes.
  - **Example overhaul (`examples/hono-prisma-api`)**: one-method use cases are now
    function-shaped tags built with `inject`; the Hono app is an injected `HttpApp` service; a
    middleware opens a `forkScope` per request (fresh `RequestId` + request-tagged logger,
    `x-request-id` response header); and the HTTP listener is an `acquireRelease` resource, so
    `server.ts` is just `Layer.scoped(AppStarted, waitForShutdown)`.

- e985d8e: Add **`Layer.onStart`** and **`Layer.onStop`** — lifecycle hooks distinct from construction.

  `Layer.onStart(layer, hook)` attaches a post-construction step (a migration, a warmup, a
  health gate) that runs **after the whole graph is built, before `use`, in dependency order**
  (sequentially, FIFO). The hook returns a `Result` / `AsyncResult` — a fallible step whose
  error **unions into the layer's `E`**, so a failed start hook short-circuits startup before
  `use` (the scope still closes). Start hooks run under `Layer.build` too, not only `scoped`.

  `Layer.onStop(layer, hook)` attaches a graceful shutdown for an already-built service. It
  registers a finalizer run **LIFO** with resource releases and, like `acquireRelease`, adds
  **`Scope`** to the requirements — so the compiler makes you consume it with `Layer.scoped`.
  The hook is infallible, mirroring `release`. (`acquireRelease` acquires _and_ releases a
  resource; `onStop` adds shutdown to a service built some other way.)

- 6d736a7: Implement the two roadmap items: layer memoization and scoped resources.

  - **Memoization** — a build now threads a scope whose memo map keys layers by reference,
    so a layer shared across branches constructs **once** per `Layer.build` (the in-flight
    `AsyncResult` is shared across concurrent `merge` branches) instead of once per branch.
  - **`Layer.acquireRelease` + `Layer.scoped`** — acquire a resource and register its
    release; `Layer.scoped(layer, use)` builds, runs `use`, then releases every resource in
    reverse acquisition order (LIFO), whether `use` succeeded, failed, or the build failed
    partway. Releases are best-effort. `Layer.build` does not close the scope, so consume
    resource graphs with `Layer.scoped`.

- 75dcbf7: Add **`Layer.member`** and **`Layer.collect`** — multi-bindings / plugin collections.

  A _collection tag_ is a tag whose service is a `readonly Item[]`. `Layer.member(tag, f)` is a
  single contribution — it mirrors `Layer.factory` (synchronous, infallible) and provides the
  tag with a one-element array. `Layer.collect(tag, members)` builds every member in parallel
  (memoized, first `Err` short-circuits), concatenates their items in listed order (flattening,
  so a member may contribute several), and provides the tag with the full array. Errors and
  requirements union across members; a foreign tag is a compile error, and an empty member list
  is an empty collection.

  This is the multi-binding pattern (Guice `@IntoSet`, Angular `multi`) with no runtime
  registry — accumulate N implementations of a port (middlewares, health checks, subscribers,
  plugins) into one array service. For a fallible or async contribution, use `Layer.make(tag,
…)` returning a one-element array; `collect` accepts any layer that provides the collection
  tag.

- 66c43f7: Group the public value surface under `Layer` and `Context` namespaces (companion
  objects) so call sites read unambiguously: `Layer.value` / `Layer.factory` /
  `Layer.make` / `Layer.merge` / `Layer.provideTo` / `Layer.build`, and `Context.empty`.
  `Context` and `Layer` are each both a type and a value (`Context<R>` /
  `Context.empty()`, `Layer<P, E, N>` / `Layer.make(...)`); `Tag` stays top-level. The
  previous flat function exports (`make`, `merge`, `build`, …) are removed.
- b150d78: Enforce scoped resource release at the type level. `Layer.acquireRelease` now returns
  `Layer<Self, E, Needs | Scope>`, where the exported **`Scope`** is a phantom requirement
  tracked in the `Needs` channel (the technique Effect uses with `Scope` in `R`). `merge`
  and `provideTo` propagate it, so any graph containing an `acquireRelease` layer carries
  `Scope` — and since `Layer.build` requires `Needs = never`, **building a resource graph
  is now a compile error**; you must use `Layer.scoped` (which discharges the `Scope` and
  closes it). `Layer.scoped` still accepts scope-free graphs. This removes the previous
  "remember to use `scoped` or you leak" footgun.
- 87a9971: Export a `ServiceOf<T>` type helper. A tag's type is its nominal identity (deliberately
  distinct from the service shape, so two structurally identical services never collide),
  so a signature that needs the shape by name — a constructor parameter, a port type —
  recovers it with `ServiceOf`. It accepts either the tag instance type
  (`ServiceOf<Logger>`) or the tag value's type (`ServiceOf<typeof Logger>`), removing the
  need to redefine the helper in every project.
- 8b96849: Require `unthrown` `^2.0.0` as a peer dependency (was `^1.0.0`). demesne's own API and
  behavior are unchanged — the unthrown surface it builds on (`Ok` / `Err` / `allAsync` /
  `fromPromise` / `fromSafePromise` / `TaggedError`, plus the `Result` / `AsyncResult`
  combinators) is identical in 2.0.0 — but consumers must now be on unthrown 2.x.
- ce7a331: Require `unthrown` `^3.0.0` as a peer dependency (was `^2.0.0`). demesne's own API and
  behavior are unchanged — the unthrown surface it builds on (`Ok` / `Err` / `allAsync` /
  `fromPromise` / `fromSafePromise` / `TaggedError`, plus the `Result` / `AsyncResult`
  combinators) is identical in 3.0.0 — but consumers must now be on unthrown 3.x.
- 933dcff: Require `unthrown` `^4.1.0` as a peer dependency (was `^3.0.0`). demesne's own API and
  behavior are unchanged — the unthrown surface it builds on (`Ok` / `Err` / `allAsync` /
  `fromPromise` / `fromSafePromise` / `TaggedError`, plus the `Result` / `AsyncResult`
  combinators) is identical in 4.1 — but consumers must now be on unthrown 4.1+, which
  type-gates `unwrap()` / `unwrapErr()` (compile only when the discarded channel is
  `never`) and renames the operator families (`orElse` → `flatMapErr`, `recover` →
  `recoverErr`, `unwrap…` → `get…`; the old names survive as deprecated aliases). The
  docs, specs and the example now use the 4.1 names, `@unthrown/vitest` matchers, and
  org-convention namespaced error tags (`"@app/ConfigError"` with a bare `Error.name`).
- fa6668a: `merge` is now variadic: it accepts any number of independent layers
  (`merge(a, b, c, …)`, at least one) instead of exactly two, unioning `Provides`,
  the error channel, and `Needs` across all of them. They still build in parallel,
  and existing two-argument calls are unchanged.

### Patch Changes

- b006fc8: Duplicate-id guard fixed to match its spec, demesne-branded runtime internals, and dual-format sourcemaps.

  - **Duplicate `Tag` id guard: warn once, strip cleanly.** The guard now warns exactly **once
    per repeated id** (it previously re-warned on every mint after the first), and the
    `process.env.NODE_ENV` check moved **inside the call with dot access** so bundler
    define-replacement folds the whole body out of production builds (the previous bracket
    access, `process.env["NODE_ENV"]`, defeated esbuild/Vite/webpack replacement — and the
    `typeof process === "undefined"` fallback left production **browser** bundles permanently
    in dev mode). The id registry is now allocated lazily, so importing the module has no side
    effects; environments without a `process` global are silent.
  - **`demesne/*` runtime branding.** The internal brand symbols were still registered as
    `Symbol.for("mini-di/…")` (the library's pre-fork name), and the absent-service error read
    `mini-di: service … not found in context`. Both now say `demesne`. Note the global-registry
    keys changed: a dependency tree mixing this version with an older copy no longer shares
    brand identity with it.
  - **`BuildState` exported as a type.** It appears in `Layer`'s public `build` property
    signature, so a hand-written `{ build }` layer needs to be able to name it. Type-only —
    instances are still created only by the build terminals.
  - **CJS sourcemap.** The build now emits sourcemaps for **both** formats (`index.cjs.map` was
    missing; only the ESM map shipped).

- 6cdc808: Packaging hardening, a duplicate-tag-id guard, and Defect-safety for `factory` / `member`.

  - **Duplicate `Tag` id guard.** Two distinct tag classes that share an `Id` are distinct
    types but the same runtime map key, so in a `Context` one would silently read the other's
    service. `Tag` now **warns** (once per id, never throws) when an id repeats — a
    **development-only** aid gated on `process.env.NODE_ENV`, so bundlers strip it and the
    library stays side-effect-free in production.
  - **`factory` / `member` capture throws as Defects.** A throw in a `factory` or `member` body
    now becomes a `Defect` (handled at the edge via `.match`) instead of escaping as an
    exception, matching `make` / `acquireRelease`. The `E` channel is unchanged (still `never`).
  - **Published surface.** The top-level `types` field now points to `index.d.cts` (correct for
    legacy `node10` CJS resolution; modern resolvers use the `exports` map either way), `files`
    ships `src/index.ts` so the declaration/source maps resolve (and drops the never-built
    `docs`), and `"sideEffects": false` is declared for better tree-shaking. `publint` and
    `@arethetypeswrong/cli` now report a clean surface across every resolution mode.
