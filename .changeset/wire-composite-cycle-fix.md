---
"demesne": patch
---

Fix: `Layer.wire` no longer reports a false "dependency cycle" for a composite member.

A `make` / `acquireRelease` reached through a memoized combinator (`onStart` / `onStop` /
`collect` / `merge` / `provideTo`) nested inside `Layer.wire`, and reading a wire sibling,
turned its not-yet-ready dependency read into an **async** `MissingDependency` Defect that
`buildMemo` cached across `wire`'s deferral rounds — so the layer deferred forever and `wire`
surfaced a misleading "dependency cycle" Defect. `buildMemo` now evicts `MissingDependency`
Defects, so composed layers resolve correctly as direct `wire` members (e.g.
`Layer.wire(ConfigLive, Layer.onStart(makeNeedingConfig, migrate))`). A genuine cycle now
reports a diagnostic Defect that **names the services** involved instead of a bare "cycle".
