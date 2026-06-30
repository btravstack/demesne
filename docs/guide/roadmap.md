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
- **`Layer.build` does not close the scope.** Its finalizers never run, so consume
  graphs that contain `acquireRelease` layers with **`Layer.scoped`**, not `Layer.build`.

## Future

One refinement remains on the roadmap: **type-level scope enforcement**. Today `build`
will run a graph containing `acquireRelease` layers and silently drop their finalizers —
only `scoped` closes the scope. A future version could track a `Scope` requirement in the
type (the way Effect tracks it in `R`) so `build` rejects scope-needing layers at compile
time. For now it's a documented convention, not a compile error.
