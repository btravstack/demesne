---
"demesne": minor
---

Add `Layer.wire(...layers)` — automatic assembly (inspired by ZIO's `ZLayer.make` /
MacWire). List a set of layers in any order and wire resolves the dependency graph for
you, instead of hand-threading `Layer.provideTo` / `Layer.merge`. It provides the union
of every service, unions the errors, and its remaining `Needs` are exactly the services
no layer in the set provides — so a self-contained set is `Needs = never` (ready to
`build`) and a missing dependency stays in the type (a compile error at `build`). At
runtime it resolves the order in rounds (a layer that reads a not-yet-built dependency is
deferred); a first `Err` short-circuits and a dependency cycle surfaces as a `Defect`.
