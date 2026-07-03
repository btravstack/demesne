// Composition — the whole application assembled with `Layer.wire`. Because `DatabaseLive`
// is an `acquireRelease` resource, the graph carries `Scope` in its requirements, so it can
// only be run with `Layer.scoped` (which disconnects Prisma on shutdown) — `Layer.build`
// would be a compile error. Listed in any order; wire resolves the dependency graph.

import { Layer } from "demesne";

import { CreateTodoLive } from "./application/create-todo.js";
import { GetTodoLive } from "./application/get-todo.js";
import { ListTodosLive } from "./application/list-todos.js";
import { ConfigLive } from "./config/env.js";
import { LoggerLive } from "./infra/logger.js";
import { DatabaseLive } from "./infra/prisma.js";
import { TodoRepoLive } from "./infra/todo-repository.js";

export const AppLayer = Layer.wire(
  ConfigLive,
  LoggerLive,
  DatabaseLive,
  TodoRepoLive,
  ListTodosLive,
  GetTodoLive,
  CreateTodoLive,
);
//    ^? WiredLayer<AppConfig | Logger | Database | TodoRepository | ListTodos | GetTodo
//                  | CreateTodo, ConfigError | ConnectionError, Scope>
