// Application — the "create todo" use case. It takes a validated input (the HTTP edge does
// the zod body validation) and returns the created todo or a RepositoryError.

import { type Context, Layer, type ServiceOf, Tag } from "demesne";
import type { AsyncResult } from "unthrown";

import type { NewTodo, RepositoryError, Todo } from "../domain/todo.js";
import { Logger, TodoRepository } from "./ports.js";

class CreateTodoInteractor {
  constructor(
    private readonly logger: ServiceOf<Logger>,
    private readonly todos: ServiceOf<TodoRepository>,
  ) {}

  execute(input: NewTodo): AsyncResult<Todo, RepositoryError> {
    this.logger.info(`creating todo "${input.title}"`);
    return this.todos.create(input);
  }
}

export class CreateTodo extends Tag("CreateTodo")<CreateTodo, CreateTodoInteractor>() {}

export const CreateTodoLive = Layer.factory(
  CreateTodo,
  (ctx: Context<Logger | TodoRepository>) =>
    new CreateTodoInteractor(ctx.get(Logger), ctx.get(TodoRepository)),
);
