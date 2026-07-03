// Composition — the Prisma-backed application, assembled through the shared `bootstrap`.
// `DatabaseLive` is an `acquireRelease` resource, so the graph carries `Scope` and can only
// be run with `Layer.scoped` (which disconnects Prisma on shutdown) — `Layer.build` would be
// a compile error.

import { Layer } from "demesne";

import { bootstrap } from "./bootstrap.js";
import { ConfigLive } from "./config/env.js";
import { DatabaseLive } from "./infra/prisma.js";
import { TodoRepoLive } from "./infra/todo-repository.js";

// The Prisma-backed repository, self-contained: config → database → repository. This is the
// storage the app runs against; a test swaps it for a fake (see app.test.ts).
const PrismaRepository = Layer.wire(TodoRepoLive, DatabaseLive, ConfigLive);

export const AppLayer = bootstrap(PrismaRepository);
//    ^? WiredLayer<Logger | TodoRepository | Database | AppConfig | ListTodos | GetTodo
//                  | CreateTodo, ConfigError | ConnectionError, Scope>
