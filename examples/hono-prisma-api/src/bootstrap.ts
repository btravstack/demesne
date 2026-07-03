// Bootstrap — the single place the application is assembled. Both the server and the tests
// build the app through `bootstrap(...)`, differing ONLY in how todos are stored: the server
// hands it the Prisma-backed repository, a test hands it an in-memory fake. The use cases,
// the logger, and — via `buildRoutes` on the built context — the HTTP routes are identical,
// so the tests exercise the very same app instead of a hand-rewired copy.

import { Layer } from "demesne";

import { CreateTodoLive } from "./application/create-todo.js";
import { GetTodoLive } from "./application/get-todo.js";
import { ListTodosLive } from "./application/list-todos.js";
import { TodoRepository } from "./application/ports.js";
import { LoggerLive } from "./infra/logger.js";

// Assemble the app around a `repository` layer (any provider of the TodoRepository port).
// Generic over the whole repository layer so its own provisions/errors/requirements flow
// into the result — the Prisma repository additionally provides Config/Database and needs a
// Scope; the fake provides only the port and needs nothing.
export const bootstrap = <R extends Layer<TodoRepository, unknown, unknown>>(repository: R) =>
  Layer.wire(LoggerLive, repository, ListTodosLive, GetTodoLive, CreateTodoLive);
