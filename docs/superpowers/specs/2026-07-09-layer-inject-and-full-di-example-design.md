# `Layer.inject` + full-DI example — design

**Date:** 2026-07-09
**Status:** approved (design), pending spec review

## Problem

Two DX complaints against `examples/hono-prisma-api`:

1. **Use cases are too verbose.** The `Layer.class` idiom costs three artifacts per use
   case (interactor class with `ServiceOf<...>` constructor params, a `Tag` class, a
   `Live` layer) — ~28 lines to wrap `logger.info(); return todos.create(input)`. The
   `Service` idiom (get-todo.ts) is tighter, but many use cases are one `execute` method —
   morally a function — and demesne has no terse way to build a **function-shaped**
   service: `factory` requires a hand-annotated `Context<...>` plus `ctx.get` lines,
   exactly the boilerplate `class`/`Service` eliminate for classes.
2. **The HTTP edge sits outside the DI.** `buildRoutes(ctx)` is a plain function handed
   the built `Context`: its dependency list is a hand-maintained
   `Context<ListTodos | GetTodo | CreateTodo | AuditSinks>` annotation, it cannot be
   swapped or decorated through the graph, the HTTP listener is constructed by hand in
   `server.ts`, and `forkScope` (the per-request lifetime) is demonstrated only in a test.

## Decision summary

- **New core API: `Layer.inject(tag, depsRecord, f)`** — record-based dependency
  injection for any value (the function analog of `Layer.class` / `Service`).
- **Example**: mixed use-case idiom (function-shaped via `inject` for one-method use
  cases, `Service` where a class earns its keep); routes become an injected `HttpApp`
  service; the listener becomes an `acquireRelease` resource; each request runs in a
  `forkScope` with request-scoped services.

## Part 1 — core: `Layer.inject`

### Signature and semantics

```ts
const inject = <Self, Service, const R extends Record<string, Tag<any, any>>>(
  tag: Tag<Self, Service>,
  deps: R,
  f: (deps: InjectedOf<R>, ctx: Context<NeedsOfRecord<R>>) => Service,
): Layer<Self, never, NeedsOfRecord<R>>
```

- Reuses the existing `InjectedOf` / `NeedsOfRecord` type helpers (currently used by
  `Service`). `Needs` is the union of the record's tag identities; the record **is** the
  boundary declaration (invariant #2 intact — nothing is inferred from usage).
- **Qualification: sync, infallible** — mirrors `factory`. `f` runs inside `.map`, so a
  throw becomes a `Defect`; `E = never`. No fallible/async sibling (that is `make`'s
  lane; a use-case closure's construction is inherently sync). Do **not** collapse
  `inject` into a value-or-Result overload.
- `f` receives the resolved deps **and** the typed context. The context parameter exists
  for one concrete reason: it is a legal `forkScope` parent, which is how an injected
  service (e.g. the HTTP app) opens per-request scopes without any new API. It is typed
  by the same record-derived `Needs`, so it adds no undeclared capability.
- Empty record → `Layer<Self, never, never>`.
- Runtime: resolve each record entry via `ctx.get`, build the deps object, call `f`,
  provide `tag.key`. Same shape as `fromService`'s build, minus the `new`.

### Introspection (a structural win)

The deps record is runtime-known, so `inject` records
`meta: { kind: "inject", key, needs: [...dep keys] }` and gets **exact** edges in
`Layer.describe` / `Layer.toDot` — like `class` / `Service`, unlike `factory`'s inferred
dashed edges. `LayerMeta`'s exact-needs branch becomes
`{ kind: "class" | "service" | "inject"; key; needs }`.

### CLAUDE.md (spec) updates

- **Invariant #7**: `inject` joins `class` / `Service` as the third injection sugar over
  `factory` — "record-injection for any value; the function-shaped counterpart". Stays
  infallible/sync; same "do not make it fallible" rule.
- **Invariant #9**: `inject` added to the `Layer.{...}` namespace list.
- **Invariant #15**: `inject` added to the exact-edges list.
- **Roadmap note**: justified against the thesis — it removes hand-written resolution
  without inferring requirements (the record is the declared boundary) and improves
  graph honesty (exact edges).

### Tests

- **Runtime spec**: builds with deps resolved from the record (values observed); a
  throwing `f` becomes a Defect (build resolves, `isDefect()`); empty record builds from
  nothing; the `ctx` argument supports `forkScope` (fork off an injected service's ctx);
  `describe`/`toDot` show `kind: "inject"` with exact (non-dashed) edges.
- **Type-level**: `Needs` = union of record identities (`Equal` check); service type
  checked against `f`'s return (mismatch `@ts-expect-error`); a dep whose service shape
  doesn't match `f`'s destructured usage is rejected; empty record →
  `Layer<Self, never, never>`; `ctx` param typed `Context<NeedsOfRecord<R>>`.

### Docs & release

- Guide: `layers-and-wiring.md` gains an `inject` section beside `class` / `Service`
  ("three injection sugars: tag list → constructor, fused class, record → function");
  `core-concepts.md` and both READMEs add `inject` to the surface enumeration.
- Changeset: `minor` (new API), one entry covering `Layer.inject` + example overhaul.

## Part 2 — example: the whole app through DI

### Use cases (mixed idiom — the taught recommendation)

- `create-todo.ts`, `list-todos.ts` → **function-shaped**: the tag's service shape IS the
  function type, built with `Layer.inject`:

  ```ts
  export class CreateTodo extends Tag("CreateTodo")<
    CreateTodo,
    (input: NewTodo) => AsyncResult<Todo, RepositoryError>
  >() {}

  export const CreateTodoLive = Layer.inject(
    CreateTodo,
    { logger: Logger, todos: TodoRepository },
    ({ logger, todos }) =>
      (input) => {
        logger.info(`creating todo "${input.title}"`);
        return todos.create(input);
      },
  );
  ```

  Call sites change from `.execute(input)` to a plain call: `ctx.get(CreateTodo)(input)`.

- `get-todo.ts` → unchanged (`Service`), now framed as "reach for a class when the
  service has state or several methods".
- The two `Layer.class` interactors are deleted from the example; `Layer.class` remains
  documented in the guides as the tool for injecting classes you don't author
  (third-party constructors).
- `ports.ts`, `plugins.ts` (member/collect) → unchanged.

### Request scope (`http/request.ts`, new)

- `RequestId` tag (`{ readonly id: string }`), built fresh per fork via `factory` using
  `crypto.randomUUID()`.
- `RequestLogger` — a `Logger`-shaped service prefixing every line with the request id;
  built with `Layer.inject` from `{ base: Logger, req: RequestId }` (demonstrates a fork
  layer reading both a parent service and a sibling request service).
- `RequestScopeLive = Layer.merge(RequestIdLive, Layer.provideTo(RequestLoggerLive, RequestIdLive))`
  — `RequestIdLive` shared by reference so the id builds once per fork and is exposed
  alongside the logger (`provideTo` alone would provide only `RequestLogger`; the
  middleware also reads `RequestId` for the response header). Exported as one const so
  every fork shares the same layer reference.

### Routes (`http/routes.ts`) — `HttpApp` as an injected service

- `export class HttpApp extends Tag("HttpApp")<HttpApp, Hono<Env>>() {}` where `Env`
  carries a Hono variable for the per-request forked `Context`.
- `HttpAppLive = Layer.inject(HttpApp, { list: ListTodos, get: GetTodo, create: CreateTodo, audit: AuditSinks, logger: Logger }, (deps, ctx) => buildHono(deps, ctx))`.
- A middleware opens the request scope around every request:

  ```ts
  app.use(async (c, next) => {
    await Layer.forkScope(ctx, RequestScopeLive, (reqCtx) => {
      c.set("scope", reqCtx);
      c.header("x-request-id", reqCtx.get(RequestId).id);
      return fromSafePromise(next());
    });
  });
  ```

  Handlers read `c.get("scope")` for request-scoped services (the request logger) and use
  the injected `deps` for use cases. The hand-maintained `Context<...>` annotation on
  `buildRoutes` disappears; the fork parent is `inject`'s `ctx`.

- Response mapping (`.match` → 200/201/404/500) unchanged.

### Server as a resource (`http/server.ts`, new file; replaces hand-rolled listen)

- `HttpServer` tag providing `{ readonly port: number }`;
  `HttpServerLive = Layer.acquireRelease(...)`: acquire reads `HttpApp` + `AppConfig`,
  starts `@hono/node-server`'s `serve()`, resolves once listening; release closes the
  server. Carries `Scope` like the Prisma layer.

### Composition

- `bootstrap.ts` (test seam, unchanged in role): wires logger + audit + repository +
  use cases **+ `HttpAppLive`** — everything the tests need, no listener.
- `app.ts`: `const boot = bootstrap(PrismaRepository)` bound once, then
  `AppLayer = Layer.merge(boot, Layer.provideTo(HttpServerLive, boot))` — the merge keeps
  the bootstrap provisions (AppConfig for the port log, Database for the health check)
  visible alongside `HttpServer`, and sharing `boot` by reference builds it once.
  `AppStarted = Layer.onStart(...)` health check unchanged.
- `server.ts` shrinks to: `Layer.scoped(AppStarted, (ctx) => { log port; return waitForShutdownSignal(); })` — teardown (server close, Prisma disconnect, onStop
  hooks) all flows from the scope, LIFO.

### Tests (`app.test.ts`)

- Still build through `bootstrap(inMemoryRepo)`; get `HttpApp` from the context and use
  Hono's `app.request(...)` — no sockets, unchanged approach.
- New assertions: `x-request-id` present and **different across two requests** (fresh
  fork per request on the real path); request-scoped logger lines carry the id.
- The existing forkScope/collect/onStop test blocks stay.

## Error handling

- `inject` introduces no new error channel (`E = never`; throws are Defects — consistent
  with `factory`/`class`/`Service`).
- The middleware forks per request; a failed fork build or handler rejection resolves the
  fork's `AsyncResult` (Err/Defect) and the scope closes — the middleware maps that to a
  500 if `next()` never produced a response.
- Server acquire failure (port in use) joins the graph's `E` union and surfaces at
  `Layer.scoped` in `server.ts` like every other construction error.

## Out of scope

- No fallible/async `inject` sibling; no positional-list variant (`Layer.fn`).
- No changes to `Layer.class` / `Service` / core semantics beyond adding `inject`.
- No auth/tracing middleware beyond the request-id demonstration.

## Verification plan

Full repo suite (build, both typechecks, vitest, oxlint/oxfmt, knip) plus: new core
spec/test-d cases above; example tests including the request-id assertions; a manual
`Layer.toDot` render of the example graph showing exact edges for the `inject` layers;
`pnpm check:package` for the publish surface.
