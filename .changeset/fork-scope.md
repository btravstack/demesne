---
"demesne": minor
---

Add **`Layer.forkScope`** — request / child scopes on top of a built parent context.

`Layer.forkScope(parent, requestLayer, use)` builds `requestLayer` against an
already-built `parent` (a fresh scope per call, so every fork gets its own instances),
runs `use` with the merged `Context<Parent | ReqP>`, then releases **only the fork's**
resources (LIFO) — the parent and its singletons stay alive and can be forked again. The
request layer's requirements are constrained to `Parent | Scope`, so reading a service the
parent doesn't provide is a compile error; build and `use` errors union as
`AsyncResult<A, E | E2>`, and the fork closes either way. This is the per-request lifetime
that makes demesne usable for HTTP servers: build singletons once, `forkScope` once per
request.
