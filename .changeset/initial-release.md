---
"demesne": minor
---

Initial release of **demesne** — type-safe dependency injection that complements
`unthrown`. A container holds your services' domain (a typed `Context`) and
provides it; requirements and construction errors are tracked in the type system,
so you cannot `build` until every dependency is wired, and the set of wiring
failures is a static union you handle once at the edge as an `unthrown`
`AsyncResult`.

Surface: `Tag` / `Context` / `Layer`, the `value` / `factory` / `make`
constructors, and the `merge` / `provideTo` / `build` combinators.
