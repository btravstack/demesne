# @demesne-examples/hono-prisma-api

The canonical demesne example: a **clean-architecture REST API** — a `todos` resource (list /
get / create) — that shows how `demesne`, `unthrown`, **Hono**, **zod** and **Prisma**
(Postgres) fit together, and exercises the combinator surface (`provideTo` / `merge` /
`member` / `collect` / `forkScope` / `onStart` / `onStop` / `acquireRelease` / `scoped`).

```
src/
  domain/todo.ts               # entity + tagged errors (no demesne, no Prisma, no HTTP)
  application/ports.ts         # Logger + TodoRepository ports (tags; domain types only)
  application/plugins.ts       # AuditSinks plugin collection: member + collect
  application/*-todo(s).ts     # use cases — constructor-injected, one `execute` method
  config/env.ts                # zod schema → AppConfig (Layer.make → ConfigError)
  infra/prisma.ts              # PrismaClient as a resource (acquireRelease → Scope)
  infra/todo-repository.ts     # TodoRepository backed by Prisma, rows → domain Todo
  infra/logger.ts              # console Logger
  http/routes.ts               # Hono routes: Result → HTTP (.match → 200/201/404/400/500)
  bootstrap.ts                 # assemble the app around a repository provider (shared)
  app.ts                       # bootstrap(prismaRepo) (+ onStart startup check) — carries Scope
  server.ts                    # Layer.scoped(...) — serve for the scope's lifetime
  app.test.ts                  # HTTP + combinator tests via bootstrap(fake) — no database
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
  (`@prisma/adapter-pg`) takes the URL from the zod-validated config, not the schema.
- **Ports keep Prisma out of the core.** The `TodoRepository` port speaks only domain types;
  the Prisma-backed adapter maps rows to `Todo` and turns a missing row into `TodoNotFound`.
- **One bootstrap for the app and the tests (the test seam).** `bootstrap.ts` assembles the
  app around a repository provider by hand (`provideTo` / `merge` — demesne has no auto-wiring);
  `app.ts` calls `bootstrap(prismaRepo)`, the tests call `bootstrap(fake)`, so both build the
  **same app** — only the storage differs, and the tests need no database. Parameterizing the
  graph like this is how you swap a real adapter for a fake. A startup check (`Layer.onStart`)
  runs a real query before serving.
- **unthrown → Hono (the edge).** `http/routes.ts` resolves use cases from the demesne
  `Context` and maps each `Result` with `.match<Response>`: `ok` → 200/201, a domain
  `TodoNotFound` → 404, any other modeled error → 500, a `defect` (unmodeled throw) → 500.
  zod validates the request body (400 on failure).
- **Plugins & scopes.** A plugin collection (`Layer.member` / `Layer.collect`) accumulates
  audit sinks that the create route fans an event out to. The tests also show `Layer.forkScope`
  (a per-request child scope on the built app) and `Layer.onStop` (teardown on scope close).

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

# 3. serve (Ctrl-C triggers a clean shutdown → Prisma disconnects via the scope)
pnpm --filter @demesne-examples/hono-prisma-api dev
# GET /todos · GET /todos/:id · POST /todos {"title":"…"}
```

## Validate (what CI runs)

```sh
pnpm --filter @demesne-examples/hono-prisma-api typecheck   # prisma generate && tsc
pnpm --filter @demesne-examples/hono-prisma-api test        # vitest — no database needed
```
