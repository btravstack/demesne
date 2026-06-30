# @demesne-examples/clean-architecture

The example from the [demesne README](../../README.md#example), implemented as a real,
type-checked program laid out by clean-architecture layer:

```
src/
  domain/order.ts              # entities + domain errors (no demesne, no I/O)
  application/ports.ts         # the ports the application depends on (tags)
  application/get-order.ts     # a use case — declares its needs via Context<…>
  adapters/                    # concrete Layers implementing the ports (the only I/O)
    logger.ts
    config.ts
    database.ts
    order-repository.ts
  main.ts                      # the composition root: wire, build, run
```

It depends on `demesne` via `workspace:*` and is compiled by `tsc` against the
package's **built** type declarations in CI (`pnpm typecheck`). That makes it a guard:
the snippets in the README can't drift out of sync with a program that actually
compiles and runs.

```sh
# validate (what CI runs)
pnpm --filter @demesne-examples/clean-architecture typecheck

# run it
pnpm --filter @demesne-examples/clean-architecture dev
```
