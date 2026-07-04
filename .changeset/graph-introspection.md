---
"demesne": minor
---

Add `Layer.describe` and `Layer.toDot` — read-only graph introspection.

Because graphs are composed by hand (`provideTo` / `merge`), it helps to see them.
`Layer.describe(root)` walks the composed layer into a normalized `{ nodes, edges }` model
(`LayerGraph`), and `Layer.toDot(root)` renders it as Graphviz DOT. It is a **debugging aid
only — no factory runs** (safe on `acquireRelease` graphs; it reflects the composed structure,
not a live build). To support it, every constructor / combinator now records optional
structural `meta` on the layer; a hand-built `{ build }` layer without `meta` is opaque and
contributes nothing.

The graph is honest about what it can know: edges are **exact** for `value` / `class` /
`Service` (their dependency keys are known at runtime) and **inferred** (`edge.inferred`,
dashed in DOT) for `factory` / `make` / `acquireRelease` / `member`, whose per-service
requirements live only in the erased `Needs` type — those edges are reconstructed from the
`provideTo` composition (exact about the wiring, may over-approximate usage).
