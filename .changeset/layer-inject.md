---
"demesne": minor
---

`Layer.inject` — record-based injection for function-shaped services, and a full-DI example.

- **`Layer.inject(tag, {deps}, f)`** builds any value (typically a closure — a one-method
  use case) by injecting a deps record into a plain function: no interactor class, no
  hand-annotated `Context<...>`, no `ctx.get` lines. It is the function-shaped sugar beside
  `Layer.class` (tag list → constructor) and `Service` (fused class): sync and infallible
  like `factory` (a throw becomes a `Defect`), with `Needs` declared by the record. The
  record is runtime-known, so `inject` layers get **exact** edges in `Layer.describe` /
  `Layer.toDot`. `f` also receives the typed context, which serves as a `forkScope` parent —
  an injected service (e.g. an HTTP app) can open per-request scopes.
- **Example overhaul (`examples/hono-prisma-api`)**: one-method use cases are now
  function-shaped tags built with `inject`; the Hono app is an injected `HttpApp` service; a
  middleware opens a `forkScope` per request (fresh `RequestId` + request-tagged logger,
  `x-request-id` response header); and the HTTP listener is an `acquireRelease` resource, so
  `server.ts` is just `Layer.scoped(AppStarted, waitForShutdown)`.
