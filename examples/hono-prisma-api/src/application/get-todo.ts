// Application — the "get one todo" use case, written with `Service`: ONE declaration is the
// Tag, the constructor-injected ports (`this.logger` / `this.todos`, typed from the record),
// AND the buildable `GetTodo.layer`. The trade vs `Layer.class` (see list-todos.ts): the class
// extends a demesne base. Its error channel is `TodoNotFound | RepositoryError` (404 vs 500).

import { Service } from "demesne";
import type { AsyncResult } from "unthrown";

import type { RepositoryError, Todo, TodoNotFound } from "../domain/todo.js";
import { Logger, TodoRepository } from "./ports.js";

export class GetTodo extends Service<GetTodo>()("GetTodo", {
  logger: Logger,
  todos: TodoRepository,
}) {
  execute(id: string): AsyncResult<Todo, TodoNotFound | RepositoryError> {
    this.logger.info(`getting todo ${id}`);
    return this.todos.findById(id);
  }
}
