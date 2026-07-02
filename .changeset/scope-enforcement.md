---
"demesne": minor
---

Enforce scoped resource release at the type level. `Layer.acquireRelease` now returns
`Layer<Self, E, Needs | Scope>`, where the exported **`Scope`** is a phantom requirement
tracked in the `Needs` channel (the technique Effect uses with `Scope` in `R`). `merge`
and `provideTo` propagate it, so any graph containing an `acquireRelease` layer carries
`Scope` — and since `Layer.build` requires `Needs = never`, **building a resource graph
is now a compile error**; you must use `Layer.scoped` (which discharges the `Scope` and
closes it). `Layer.scoped` still accepts scope-free graphs. This removes the previous
"remember to use `scoped` or you leak" footgun.
