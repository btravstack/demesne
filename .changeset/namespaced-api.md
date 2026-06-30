---
"demesne": minor
---

Group the public value surface under `Layer` and `Context` namespaces (companion
objects) so call sites read unambiguously: `Layer.value` / `Layer.factory` /
`Layer.make` / `Layer.merge` / `Layer.provideTo` / `Layer.build`, and `Context.empty`.
`Context` and `Layer` are each both a type and a value (`Context<R>` /
`Context.empty()`, `Layer<P, E, N>` / `Layer.make(...)`); `Tag` stays top-level. The
previous flat function exports (`make`, `merge`, `build`, …) are removed.
