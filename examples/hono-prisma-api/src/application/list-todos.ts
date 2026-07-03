// Application — the "list todos" use case. Constructor-injected ports, one public `execute`
// method, no demesne types inside. A `Layer.factory` performs the injection so it joins the
// typed graph.

import { type Context, Layer, type ServiceOf, Tag } from "demesne";
import type { AsyncResult } from "unthrown";

import type { RepositoryError, Todo } from "../domain/todo.js";
import { Logger, TodoRepository } from "./ports.js";

class ListTodosInteractor {
  constructor(
    private readonly logger: ServiceOf<Logger>,
    private readonly todos: ServiceOf<TodoRepository>,
  ) {}

  execute(): AsyncResult<readonly Todo[], RepositoryError> {
    this.logger.info("listing todos");
    return this.todos.list();
  }
}

export class ListTodos extends Tag("ListTodos")<ListTodos, ListTodosInteractor>() {}

export const ListTodosLive = Layer.factory(
  ListTodos,
  (ctx: Context<Logger | TodoRepository>) =>
    new ListTodosInteractor(ctx.get(Logger), ctx.get(TodoRepository)),
);
