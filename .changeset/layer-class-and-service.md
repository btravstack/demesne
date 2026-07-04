---
"demesne": minor
---

Add `Layer.class` and `Service` — constructor injection without a hand-written factory.

Most services are a class built from ports, and writing `ctx => new UseCase(ctx.get(A),
ctx.get(B))` by hand is boilerplate. Two sugars let demesne do the instantiation, with the
dependencies type-checked against the constructor — the `asClass` (Awilix) / `Effect.Service`
ergonomic, kept fully compile-time-safe. Both are infallible (`E = never`; a throwing
constructor becomes a `Defect`, like `factory`).

- **`Layer.class(tag, [deps], Ctor)`** — constructs a **plain** class (no demesne import) from
  a tag list. The list is checked against the constructor's parameters (wrong order / type /
  arity is a compile error), and its tags' identities become the layer's `Needs`.
- **`Service<Self>()(id, { deps })`** + **`Layer.fromService(Cls)`** — the fused
  `Effect.Service` analog: one class declaration is the Tag and the injected `this.dep` fields
  (typed from the record), and `Layer.fromService(Cls)` builds its layer. The trade is that the
  class extends a demesne base; for a `Service`, the tag's identity and service shape coincide
  (`Tag<Self, Self>`). Instances also construct directly for tests (`new Cls({ dep })`, no
  container).

The two are complementary — `Layer.class` injects **any** constructor (including one you don't
own); `Service` fuses tag + injection for a class you author. Unchanged: `value` / `factory` /
`make` / `acquireRelease` remain the primitives; these are additive.
