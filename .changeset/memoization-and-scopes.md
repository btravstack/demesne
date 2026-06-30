---
"demesne": minor
---

Implement the two roadmap items: layer memoization and scoped resources.

- **Memoization** — a build now threads a scope whose memo map keys layers by reference,
  so a layer shared across branches constructs **once** per `Layer.build` (the in-flight
  `AsyncResult` is shared across concurrent `merge` branches) instead of once per branch.
- **`Layer.acquireRelease` + `Layer.scoped`** — acquire a resource and register its
  release; `Layer.scoped(layer, use)` builds, runs `use`, then releases every resource in
  reverse acquisition order (LIFO), whether `use` succeeded, failed, or the build failed
  partway. Releases are best-effort. `Layer.build` does not close the scope, so consume
  resource graphs with `Layer.scoped`.
