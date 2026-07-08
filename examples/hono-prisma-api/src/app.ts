// Composition — the Prisma-backed application, assembled through the shared `bootstrap`, plus
// a startup health-check attached with `Layer.onStart`. `DatabaseLive` is an `acquireRelease`
// resource, so the graph carries `Scope` and can only be run with `Layer.scoped` (which
// disconnects Prisma on shutdown) — `Layer.build` would be a compile error.

import { type Context, Layer } from "demesne";
import { type AsyncResult, fromPromise, TaggedError } from "unthrown";

import { ConfigLive } from "./config/env.js";
import { HttpServerLive } from "./http/server.js";
import { Database, DatabaseLive } from "./infra/prisma.js";
import { TodoRepoLive } from "./infra/todo-repository.js";
import { bootstrap } from "./bootstrap.js";

// A startup-check failure is one more way construction can fail — it joins the error union.
class MigrationError extends TaggedError("MigrationError")<{ cause: unknown }> {}

// The Prisma-backed repository, composed by hand: config → database → repository. It provides
// TodoRepository (plus Database and AppConfig, which the assembled graph also exposes — the
// server reads the PORT, the startup check reads the Database) and carries `Scope` from the
// acquireRelease connection. `dbWired` is shared by reference, so Prisma connects once.
const dbWired = Layer.provideTo(DatabaseLive, ConfigLive);
const PrismaRepository = Layer.merge(ConfigLive, dbWired, Layer.provideTo(TodoRepoLive, dbWired));

// `boot` bound once and shared by reference: the merge keeps the bootstrap provisions
// (AppConfig for the port, Database for the health check, HttpApp) visible alongside the
// listener, and the shared reference builds everything once.
const boot = bootstrap(PrismaRepository);
export const AppLayer = Layer.merge(boot, Layer.provideTo(HttpServerLive, boot));
//    ^? Layer<Logger | AuditSinks | AppConfig | Database | TodoRepository | ListTodos
//             | GetTodo | CreateTodo | HttpApp | HttpServer,
//             ConfigError | ConnectionError | ListenError, Scope>

// Attach a startup check to the ASSEMBLED graph: it runs AFTER the whole graph is built (the
// pool connected), before the app serves anything — a real query verifying the schema is
// reachable. Being fallible/async, its error unions into the graph's `E`.
export const AppStarted = Layer.onStart(
  AppLayer,
  (ctx: Context<Database>): AsyncResult<void, MigrationError> =>
    fromPromise(ctx.get(Database).todo.count(), (cause) => new MigrationError({ cause })).map(
      () => undefined,
    ),
);
