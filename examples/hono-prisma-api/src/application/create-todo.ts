// Application — the "create todo" use case, FUNCTION-shaped: the tag's service IS the
// function type, and `Layer.inject` builds it from a deps record — no interactor class, no
// hand-written factory, no `ctx.get`. The record declares the boundary (requirements are
// declared, never inferred), and call sites invoke it directly: `ctx.get(CreateTodo)(input)`.

import { Layer, Tag } from "demesne";
import type { AsyncResult } from "unthrown";

import type { NewTodo, RepositoryError, Todo } from "../domain/todo.js";
import { Logger, TodoRepository } from "./ports.js";

export class CreateTodo extends Tag("CreateTodo")<
  CreateTodo,
  (input: NewTodo) => AsyncResult<Todo, RepositoryError>
>() {}

export const CreateTodoLive = Layer.inject(
  CreateTodo,
  { logger: Logger, todos: TodoRepository },
  ({ logger, todos }) =>
    (input) => {
      logger.info(`creating todo "${input.title}"`);
      return todos.create(input);
    },
);
