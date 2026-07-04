// Bootstrap — the single place the application is assembled. Both the server and the tests
// build the app through `bootstrap(...)`, differing ONLY in how todos are stored: the server
// hands it the Prisma-backed repository, a test hands it an in-memory fake.
//
// demesne has no auto-wiring — the graph is composed by hand with `merge` / `provideTo`,
// which is single-pass and fully type-checked. Logger feeds the audit collection and the use
// cases; the repository (whatever it provides) is merged in and threaded into the use cases.

import { Layer } from "demesne";

import { CreateTodoLive } from "./application/create-todo.js";
import { GetTodo } from "./application/get-todo.js";
import { ListTodosLive } from "./application/list-todos.js";
import { AuditSinksLive } from "./application/plugins.js";
import { TodoRepository } from "./application/ports.js";
import { LoggerLive } from "./infra/logger.js";

// Generic over the whole repository layer so its provisions/errors/requirements flow into the
// result — the Prisma repository additionally provides Config/Database and needs a Scope; the
// fake provides only the port and needs nothing.
export const bootstrap = <R extends Layer<TodoRepository, unknown, unknown>>(repository: R) => {
  // the audit collection reads Logger (its console sink); discharge that need up front
  const audit = Layer.provideTo(AuditSinksLive, LoggerLive);
  // the use cases each need Logger + TodoRepository — feed both in. GetTodo is a `Service`, so
  // its layer is `GetTodo.layer`; the other two are `Layer.class` layers (`*Live`).
  const useCases = Layer.merge(ListTodosLive, GetTodo.layer, CreateTodoLive);
  const useCasesWired = Layer.provideTo(useCases, Layer.merge(LoggerLive, repository));
  // expose Logger, the audit collection, the repository (and whatever else it provides), and
  // the wired use cases; shared layers (LoggerLive, the repository) build once (memoized).
  return Layer.merge(LoggerLive, audit, repository, useCasesWired);
};
