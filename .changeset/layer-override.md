---
"demesne": minor
---

Add **`Layer.override`** — the test override combinator, plus **`WiredLayer`**, the branded
result type of `Layer.wire`.

`Layer.override(base, patches)` replaces specific tags' providers inside an assembled
(`Layer.wire`) graph while keeping the rest — swap a real adapter for a fake without
hand-rewiring. It is **deep**: a consumer that captured a dependency at construction (a use
case doing `ctx.get(Repo)` in its factory) sees the patch too, not just a direct `ctx.get`.
That's why `base` must be a `Layer.wire` result — only the branded `WiredLayer` carries the
source layers needed to re-assemble; a plain, already-built layer is a compile error. The
provides union gains any new tag a patch introduces, errors union, and a patch that supplies
a tag the base needed externally discharges that requirement. `Layer.wire` now returns
`WiredLayer<P, E, N>` (assignable everywhere a `Layer<P, E, N>` is expected).
