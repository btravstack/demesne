# Resources & Scopes

A build threads a **scope** through every layer. The scope does two jobs: it memoizes
shared layers, and it collects resource finalizers for ordered teardown.

## Memoization

A layer referenced from two branches constructs **once** per `build` — the scope's memo
map keys layers by reference, so the shared layer's service is built a single time and
reused (concurrent `merge` branches share the in-flight construction, not just the
result).

```ts
const Pool = Layer.make(Database, () => connect()); // expensive, shared

const A = Layer.provideTo(RepoA, Pool);
const B = Layer.provideTo(RepoB, Pool);

await Layer.build(Layer.merge(A, B)); // `Pool` constructs ONCE, not once per branch
```

Memoization is per `build` / `scoped` call — two separate builds reconstruct.

## `acquireRelease` + `scoped`

A resource layer **acquires** something and registers its **release** with the scope.
`Layer.scoped(layer, use)` builds the graph, runs `use` with the resulting context, then
closes the scope — releasing every resource in **reverse acquisition order (LIFO)**,
whether `use` succeeded, failed, or the build failed partway.

```ts
import { Layer, Tag, type Context } from "demesne";
import { fromPromise, type Result, TaggedError } from "unthrown";

class Pool extends Tag("Pool")<Pool, { readonly query: (sql: string) => Promise<unknown[]> }>() {}
class PoolError extends TaggedError("@app/PoolError", { name: "PoolError" })<{ cause: unknown }> {}

const PoolLive = Layer.acquireRelease(
  Pool,
  () => fromPromise(openPool(), (cause) => new PoolError({ cause })),
  (pool) => pool.end(), // released after `use`
);

const result = await Layer.scoped(PoolLive, (ctx) =>
  fromPromise(ctx.get(Pool).query("select 1"), (cause) => new PoolError({ cause })),
);
// the pool is closed here — even if the query failed
```

Notes:

- **`release` is expected to be infallible.** Teardown is best-effort: a throwing
  release does not abort the others.

## Type-level scope enforcement

You can't accidentally leak a resource, because the **types** force you to use `scoped`.
`acquireRelease` returns a layer whose requirements include a phantom **`Scope`** — the
same technique Effect uses (`Scope` in the `R` channel):

```ts
const PoolLive = Layer.acquireRelease(Pool, acquire, release);
//    ^? Layer<Pool, PoolError, Scope>
```

`merge` and `provideTo` propagate that `Scope` (no layer ever _provides_ it), so any
graph containing a resource layer carries `Scope` in its requirements. And since
`Layer.build` is callable only when requirements are `never`, it **rejects a resource
graph at compile time**:

```ts
Layer.build(PoolLive);
//          ^^^^^^^^ ❌ Type error — the graph needs a Scope; use Layer.scoped

await Layer.scoped(PoolLive, use); // ✅ discharges the Scope and closes it
```

`Layer.scoped` accepts both scope-needing graphs and scope-free ones (`never` is
assignable to `Scope`), while still rejecting a graph with a real unmet service. So the
"remember to use `scoped`" convention is now a compile error, not a footgun.

## Request / child scopes

Long-lived singletons (a connection pool, a config) should be built **once** and shared,
while some services are **per-request** — a transaction, a request id, a unit-of-work.
`Layer.forkScope(parent, requestLayer, use)` layers a short-lived child scope on top of an
already-built parent context:

```ts
import { Layer, Tag, type Context } from "demesne";
import { fromPromise, TaggedError } from "unthrown";

class Txn extends Tag("Txn")<Txn, { readonly exec: (sql: string) => Promise<void> }>() {}
class TxnError extends TaggedError("@app/TxnError", { name: "TxnError" })<{ cause: unknown }> {}

// Per-request: opens a transaction against the shared Pool, commits/rolls back on release.
const RequestLive = Layer.acquireRelease(
  Txn,
  (ctx: Context<Pool>) => fromPromise(ctx.get(Pool).begin(), (cause) => new TxnError({ cause })),
  (txn) => txn.commit(),
);

// The parent scope's lifetime IS the `use` callback — the app is built once, the server
// runs inside `use`, and each request handler forks a child scope off the built context.
const outcome = await Layer.scoped(AppLive, (appCtx) => {
  // One fork per request: shares the parent singletons, adds Txn, releases it (LIFO) at the end.
  const handleRequest = () =>
    Layer.forkScope(appCtx, RequestLive, (reqCtx) =>
      fromPromise(reqCtx.get(Txn).exec("insert ..."), (cause) => new TxnError({ cause })),
    );
  // each fork's transaction is released when it ends; the pool and the rest of the parent stay alive

  return serveUntilShutdown(handleRequest); // resolves on shutdown — only then does the parent close
});
```

Notes:

- **The parent is untouched.** `forkScope` only releases resources acquired by
  `requestLayer`; the parent context (and its singletons) outlive the fork and can be
  forked again.
- **Fresh instances per fork.** Each call builds `requestLayer` anew, so every request
  gets its own `Txn` — call `forkScope` once per request.
- **The request layer may only need parent services.** Its requirements are constrained to
  `Parent | Scope`: reading a service the parent doesn't provide is a **compile error**.
- **Errors union.** A failure while building the request layer (`E`) or in `use` (`E2`)
  surfaces as `AsyncResult<A, E | E2>`; the fork is closed either way.

## Lifecycle hooks

Construction builds a service; some services need a step **after** the whole graph is
assembled — a migration, a cache warmup, a health gate — and some need a graceful
**shutdown** distinct from resource release. `Layer.onStart` and `Layer.onStop` attach
these to any layer.

```ts
import { Layer, Tag, type Context } from "demesne";
import { fromPromise, type Result, TaggedError } from "unthrown";

class MigrationError extends TaggedError("@app/MigrationError", { name: "MigrationError" })<{
  cause: unknown;
}> {}

// run AFTER the whole graph is built, before `use`, in dependency order:
const DbLive = Layer.onStart(PoolLive, (ctx: Context<Pool>) =>
  fromPromise(migrate(ctx.get(Pool)), (cause) => new MigrationError({ cause })),
);

// a graceful shutdown for an already-built service (adds `Scope`, so consume with `scoped`):
const ServerLive = Layer.onStop(HttpServerLive, (ctx: Context<HttpServer>) =>
  ctx.get(HttpServer).drain(),
);

const result = await Layer.scoped(Layer.merge(DbLive, ServerLive /* … */), use);
// build everything → run start hooks (dep order) → use → run stop hooks + releases (LIFO)
```

Notes:

- **`onStart` runs after construction, in dependency order.** Hooks run once the whole
  graph is built (a dependent's hook after its dependencies'), **sequentially**, before
  `use`. They run under `Layer.build` too, not only `scoped`. (Order is
  construction-completion order — dependency-respecting, but two hooks on _independent_
  branches have no guaranteed relative order.)
- **A failed start hook aborts startup.** `onStart`'s hook returns a `Result` /
  `AsyncResult`; its error **unions into the layer's `E`**, and the first failure
  short-circuits before `use` — but the scope still closes (releasing whatever was
  acquired).
- **`onStop` is the teardown counterpart.** It registers a finalizer (run **LIFO** with
  the resource releases) and, like `acquireRelease`, adds **`Scope`** to the requirements —
  so the compiler makes you consume it with `scoped`. The hook is infallible, like
  `release`. (A service that both acquires and releases is just `acquireRelease`; `onStop`
  adds shutdown to a service built some other way.)
- **A hook-wrapped layer composes like any other.** `onStart(SomeLive, …)` can be threaded
  with `provideTo` / `merge` just like `SomeLive` itself — the hook rides along on the layer,
  running after the whole graph is built (see
  [Layers & Wiring](./layers-and-wiring#compose-the-whole-graph-by-hand)).

## Future

The wiring core is complete. Further ideas will be tracked in the repository's
`CLAUDE.md`.
