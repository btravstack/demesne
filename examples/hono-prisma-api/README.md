# @demesne-examples/hono-prisma-api

The canonical demesne example: a **clean-architecture RPC API** — a `todos` resource (list /
get / create) — that shows how `demesne`, `unthrown` (with its **`@unthrown/prisma`** and
**`@unthrown/orpc`** bridges), **Hono**, **oRPC**, **zod** and **Prisma** (Postgres) fit
together, and exercises the combinator surface (`provideTo` / `merge` / `member` / `collect` /
`forkScope` / `onStart` / `onStop` / `acquireRelease` / `scoped`).

```
src/
  domain/todo.ts               # entity + tagged errors (no demesne, no Prisma, no HTTP)
  application/ports.ts         # Logger + TodoRepository ports (tags; domain types only)
  application/plugins.ts       # AuditSinks plugin collection: member + collect
  application/get-todo.ts      # use case via `Service` — one fused declaration (tag+inject+layer)
  application/{list,create}-*  # use cases via `Layer.inject` — function-shaped, built from a deps record
  config/env.ts                # zod schema → AppConfig (Layer.make → ConfigError)
  infra/prisma.ts              # PrismaClient as a resource (acquireRelease → Scope)
  infra/todo-repository.ts     # TodoRepository backed by Prisma, rows → domain Todo
  infra/logger.ts              # console Logger
  http/request.ts              # per-request scope: RequestId + RequestLogger (forked per request)
  http/routes.ts               # HttpApp: an oRPC router on a Hono app, an injected service (Layer.inject)
  http/server.ts               # HttpServer listener as a resource (acquireRelease → Scope)
  bootstrap.ts                 # assemble the app around a repository provider (shared)
  app.ts                       # bootstrap(prismaRepo) + the listener (+ onStart check) — carries Scope
  server.ts                    # Layer.scoped(AppStarted, waitForShutdown) — serve for the scope's lifetime
  app.test.ts                  # typed-client + combinator tests via bootstrap(fake) — no database
prisma/schema.prisma           # the Todo model
prisma.config.ts               # Prisma 7 config (migrate connection URL)
```

## How the pieces meet

- **zod → unthrown → demesne (config).** `config/env.ts` parses `process.env` with a zod
  schema; `safeParse` returns a result that `Layer.make` lifts, so an invalid environment is
  a modeled `ConfigError` in the wiring error union — never a thrown exception.
- **Prisma as a demesne resource.** `infra/prisma.ts` uses `Layer.acquireRelease` to
  `$connect` on build and `$disconnect` on teardown. That puts `Scope` in the graph's
  requirements, so the app can only be run with `Layer.scoped` (`server.ts`) — the connection
  pool is closed on shutdown, guaranteed by the type system. Prisma 7's driver-adapter
  (`@prisma/adapter-pg`) takes the URL from the zod-validated config, not the schema. The
  client is `$extends`ed with **`@unthrown/prisma`**, so every consumer sees `try*` query
  methods returning `AsyncResult`s with per-operation tagged errors — no raw Prisma promises.
- **Ports keep Prisma out of the core.** The `TodoRepository` port speaks only domain types;
  the Prisma-backed adapter maps the bridge's tagged errors into domain ones —
  `RecordNotFound` (P2025) becomes `TodoNotFound`, everything else folds into
  `RepositoryError` — and rows into `Todo`.
- **Injection, two ways.** `list-todos.ts` / `create-todo.ts` are FUNCTION-shaped: the tag's
  service IS the function type, and `Layer.inject(tag, deps, f)` builds it from a deps record —
  call sites read it and call it directly (`ctx.get(CreateTodo)(input)`). `get-todo.ts` uses
  `Service` instead: state or several methods is when a class earns its keep — one declaration
  fuses the tag and the injected `this.logger` / `this.todos`, with `Layer.fromService(GetTodo)`
  bound to a `const` as its layer. Neither writes a hand-rolled `ctx => new UseCase(...)` factory.
- **One bootstrap for the app and the tests (the test seam).** `bootstrap.ts` assembles the
  app around a repository provider by hand (`provideTo` / `merge` — demesne has no auto-wiring);
  `app.ts` calls `bootstrap(prismaRepo)`, the tests call `bootstrap(fake)`, so both build the
  **same app** — only the storage differs, and the tests need no database. Parameterizing the
  graph like this is how you swap a real adapter for a fake. A startup check (`Layer.onStart`)
  runs a real query after the graph is built (the listener is already accepting) and gates the
  entry point's `use`.
- **The HTTP edge is IN the DI.** `http/routes.ts` builds `HttpApp` — an oRPC router served by
  a Hono app — with `Layer.inject`, from the wired use cases, the audit collection and the
  Logger; the catch-all handler opens a `Layer.forkScope` off the app's own context on every
  request (fresh `RequestId`, a request-tagged `RequestLogger` that stamps `[id]` on every
  line, an `x-request-id` response header), hands the forked context to the procedures as the
  oRPC context, and closes the fork when the request ends. zod validates inputs at the
  procedure boundary.
- **Typed errors END-TO-END (`@unthrown/orpc`).** Every procedure is a `handlerResult`: the
  handler returns a `Result`, and one `mapErr` per procedure is the domain → transport triage —
  `TodoNotFound` → a declared `errors.NOT_FOUND()`, `RepositoryError` → `STORAGE_FAILED` —
  which oRPC marks _inferable_, so the client sees the exact error-code union. On the caller
  side (`app.test.ts`), `createResultClient` wraps the oRPC client: every call returns an
  `AsyncResult` whose `Err` channel is those declared `ORPCError`s, and anything undeclared
  (an input-validation `BAD_REQUEST`, a network failure, a bug collapsed to
  `INTERNAL_SERVER_ERROR`) stays a `Defect` — the same Ok / Err / Defect split as everywhere
  else in the app.
- **The listener is a resource too.** `http/server.ts`'s `HttpServerLive` is an
  `acquireRelease` that starts the Node HTTP server on build and closes it on teardown, so the
  graph's `Scope` covers both the listener and the Prisma pool — `server.ts`
  (`Layer.scoped(AppStarted, waitForShutdown)`) closes them LIFO on shutdown: the listener stops
  accepting, then Prisma disconnects.
- **Plugins & scopes.** A plugin collection (`Layer.member` / `Layer.collect`) accumulates
  audit sinks that the create route fans an event out to. The tests also exercise
  `Layer.forkScope` (the per-request child scope) and `Layer.onStop` (teardown on scope close)
  directly.

## Prisma 7 notes

The Prisma client is **generated** from `prisma/schema.prisma` into `src/generated/prisma`
(git-ignored). Generation runs automatically on `pnpm install` (a `postinstall` hook) and
before `typecheck` / `test`, and needs **no database** and no engine binary download (Prisma
7's client is TypeScript over a WASM query compiler). The client is imported with an explicit
`.ts` extension (`allowImportingTsExtensions`), and the connection URL lives in
`prisma.config.ts` / `AppConfig`, not the schema.

## Run it

```sh
# 1. a Postgres to talk to
cp .env.example .env                     # edit DATABASE_URL

# 2. create the table (Prisma reads the URL from prisma.config.ts)
pnpm --filter @demesne-examples/hono-prisma-api exec prisma migrate dev --name init

# 3. serve (Ctrl-C triggers a clean shutdown → listener then Prisma close via the scope, LIFO)
pnpm --filter @demesne-examples/hono-prisma-api dev
# oRPC procedures under /rpc: todos.list · todos.get {"id":"…"} · todos.create {"title":"…"}
```

## Validate (what CI runs)

```sh
pnpm --filter @demesne-examples/hono-prisma-api typecheck   # prisma generate && tsc
pnpm --filter @demesne-examples/hono-prisma-api test        # vitest — no database needed
```
