# @demesne-examples/hono-prisma-api

A small **REST API** that shows how `demesne`, `unthrown`, **Hono**, **zod** and **Prisma**
(Postgres) fit together — a `todos` resource with list / get / create.

```
src/
  domain/todo.ts               # entity + tagged errors (no demesne, no Prisma, no HTTP)
  application/ports.ts         # Logger + TodoRepository ports (tags; domain types only)
  application/*-todo(s).ts     # use cases — constructor-injected, one `execute` method
  config/env.ts                # zod schema → AppConfig (Layer.make → ConfigError)
  infra/prisma.ts              # PrismaClient as a resource (acquireRelease → Scope)
  infra/todo-repository.ts     # TodoRepository backed by Prisma, rows → domain Todo
  infra/logger.ts              # console Logger
  http/routes.ts               # Hono routes: Result → HTTP (.match → 200/201/404/400/500)
  app.ts                       # Layer.wire(...) — the assembled graph (carries Scope)
  server.ts                    # Layer.scoped(...) — serve for the scope's lifetime
  app.test.ts                  # end-to-end HTTP tests with an in-memory fake repo (no DB)
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
  That's why `app.test.ts` can wire an **in-memory fake** in its place and test the whole HTTP
  stack **without a database**.
- **unthrown → Hono (the edge).** `http/routes.ts` resolves use cases from the demesne
  `Context` and maps each `Result` with `.match<Response>`: `ok` → 200/201, a domain
  `TodoNotFound` → 404, any other modeled error → 500, a `defect` (unmodeled throw) → 500.
  zod validates the request body (400 on failure).

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
