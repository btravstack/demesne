# Roadmap

demesne ships the wiring core today. Two capabilities are deliberately **not yet**
implemented — they are stated here so they aren't mistaken for done, and the code is
shaped so they slot in later.

## Memoization (single construction of shared layers)

A layer referenced from two branches is currently built **once per branch** — i.e.
twice. There is no `MemoMap` yet.

```ts
const Shared = Layer.make(AppConfig, () => {
  /* constructed once per branch today */
  return Ok({ dbUrl });
});

const A = Layer.provideTo(UsesConfigA, Shared);
const B = Layer.provideTo(UsesConfigB, Shared);
Layer.build(Layer.merge(A, B)); // builds `Shared` twice
```

The test suite asserts the current count is `2` as a guard — it will flip to `1` when a
shared `MemoMap` lands, so each layer constructs once across a `Layer.build`.

## Scopes / `acquireRelease` (ordered teardown)

There is no scope or resource-finalization story yet: layers **acquire** but never
**release**. A `Scope` / `acquireRelease` story — ordered teardown of resources in
reverse construction order — comes later.

## What won't change

These stay out of the core on purpose:

- **No monad / effect runtime.** demesne does the wiring; `unthrown` does the errors.
- **No config / schema primitive.** Validation lives in unthrown's ecosystem — see
  [Configuration](./configuration).
- **Requirements declared at boundaries**, not inferred from usage — the deliberate
  trade vs Effect's inferred `R` channel.
