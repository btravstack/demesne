// Application — the "get one todo" use case. Its error channel is the union the repository
// exposes: `TodoNotFound | RepositoryError`, which the HTTP edge maps to 404 vs 500.

import { type Context, Layer, type ServiceOf, Tag } from "demesne";
import type { AsyncResult } from "unthrown";

import type { RepositoryError, Todo, TodoNotFound } from "../domain/todo.js";
import { Logger, TodoRepository } from "./ports.js";

class GetTodoInteractor {
  constructor(
    private readonly logger: ServiceOf<Logger>,
    private readonly todos: ServiceOf<TodoRepository>,
  ) {}

  execute(id: string): AsyncResult<Todo, TodoNotFound | RepositoryError> {
    this.logger.info(`getting todo ${id}`);
    return this.todos.findById(id);
  }
}

export class GetTodo extends Tag("GetTodo")<GetTodo, GetTodoInteractor>() {}

export const GetTodoLive = Layer.factory(
  GetTodo,
  (ctx: Context<Logger | TodoRepository>) =>
    new GetTodoInteractor(ctx.get(Logger), ctx.get(TodoRepository)),
);
