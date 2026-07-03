---
"demesne": minor
---

Add **`Layer.onStart`** and **`Layer.onStop`** — lifecycle hooks distinct from construction.

`Layer.onStart(layer, hook)` attaches a post-construction step (a migration, a warmup, a
health gate) that runs **after the whole graph is built, before `use`, in dependency order**
(sequentially, FIFO). The hook returns a `Result` / `AsyncResult` — a fallible step whose
error **unions into the layer's `E`**, so a failed start hook short-circuits startup before
`use` (the scope still closes). Start hooks run under `Layer.build` too, not only `scoped`.

`Layer.onStop(layer, hook)` attaches a graceful shutdown for an already-built service. It
registers a finalizer run **LIFO** with resource releases and, like `acquireRelease`, adds
**`Scope`** to the requirements — so the compiler makes you consume it with `Layer.scoped`.
The hook is infallible, mirroring `release`. (`acquireRelease` acquires _and_ releases a
resource; `onStop` adds shutdown to a service built some other way.)
