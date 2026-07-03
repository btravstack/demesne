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
class PoolError extends TaggedError("PoolError")<{ cause: unknown }> {}

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
import { fromPromise, type Result, TaggedError } from "unthrown";

// Built once, at startup — shared by every request.
const appCtx = (await Layer.scoped(AppLive, (ctx) => Ok(ctx))).unwrap();

class Txn extends Tag("Txn")<Txn, { readonly exec: (sql: string) => Promise<void> }>() {}
class TxnError extends TaggedError("TxnError")<{ cause: unknown }> {}

// Per-request: opens a transaction against the shared Pool, commits/rolls back on release.
const RequestLive = Layer.acquireRelease(
  Txn,
  (ctx: Context<Pool>) => fromPromise(ctx.get(Pool).begin(), (cause) => new TxnError({ cause })),
  (txn) => txn.commit(),
);

// One fork per request: shares the parent singletons, adds Txn, releases it (LIFO) at the end.
const result = await Layer.forkScope(appCtx, RequestLive, (ctx) =>
  fromPromise(ctx.get(Txn).exec("insert ..."), (cause) => new TxnError({ cause })),
);
// the transaction is released here; the pool and the rest of the parent stay alive
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

## Future

The wiring core is complete. Further ideas will be tracked in the repository's
`CLAUDE.md`.
