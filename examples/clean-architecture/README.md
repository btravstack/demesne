# @demesne-examples/clean-architecture

The example from the [demesne README](../../README.md#example), implemented as a real,
type-checked program laid out by clean-architecture layer:

```
src/
  domain/order.ts              # entities + domain errors (no demesne, no I/O)
  application/ports.ts         # the ports the application depends on (tags)
  application/get-order.ts     # a use case — declares its needs via Context<…>
  application/plugins.ts       # a plugin collection: member + collect (multi-binding)
  adapters/                    # concrete Layers implementing the ports (the only I/O)
    logger.ts
    config.ts
    database.ts
    order-repository.ts
  bootstrap.ts                 # assemble the app around a repository provider (shared)
  app.ts                       # the assembled graph: bootstrap(realRepo) (+ onStart migration)
  main.ts                      # the composition root: build, run, fan out to plugins
  app.test.ts                  # end-to-end: bootstrap(fake), override, forkScope, onStop
```

Beyond the core wiring, it exercises the full combinator surface:

- **`bootstrap`** (`bootstrap.ts`) assembles the app around an `OrderRepository` provider;
  `app.ts` calls `bootstrap(realRepo)` and the tests call `bootstrap(fakeRepo)`, so both
  build the **same app** — only the repository differs. **`Layer.onStart`** attaches a
  startup migration to the assembled graph.
- **`Layer.member` / `Layer.collect`** accumulate a plugin collection (`AuditSinks`) that
  `main.ts` fans an event out to.
- **`Layer.override`** (in `app.test.ts`) is the alternative to re-bootstrapping: it patches
  the repository on the already-assembled `AppLayer` — deeply, so the use case that captured
  it sees the fake.
- **`Layer.forkScope`** layers a per-request scope on the built app, and **`Layer.onStop`**
  runs a teardown under `Layer.scoped`.

It depends on `demesne` via `workspace:*` and is compiled by `tsc` against the
package's **built** type declarations in CI (`pnpm typecheck`), and its `app.test.ts`
runs under vitest (`pnpm test`). That makes it a guard: the snippets in the README can't
drift out of sync with a program that actually compiles, runs, and passes its tests.

```sh
# validate (what CI runs)
pnpm --filter @demesne-examples/clean-architecture typecheck
pnpm --filter @demesne-examples/clean-architecture test

# run it
pnpm --filter @demesne-examples/clean-architecture dev
```
