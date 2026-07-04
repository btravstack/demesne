// Application — the "get one todo" use case, written with `Service`: ONE declaration is the
// Tag AND the constructor-injected ports (`this.logger` / `this.todos`, typed from the record);
// `Layer.fromService(GetTodo)` is its layer. The trade vs `Layer.class` (see list-todos.ts):
// the class extends a demesne base. Its error channel is `TodoNotFound | RepositoryError`.

import { Layer, Service } from "demesne";
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

// Bind the layer to a const (reused in the graph) so the shared service builds once.
export const GetTodoLive = Layer.fromService(GetTodo);
