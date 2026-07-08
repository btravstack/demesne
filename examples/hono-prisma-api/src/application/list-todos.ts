// Application — the "list todos" use case, function-shaped like create-todo.ts. Contrast
// with get-todo.ts (`Service`): reach for a class when the service has state or several
// methods; a one-method use case is just a function built from its ports.

import { Layer, Tag } from "demesne";
import type { AsyncResult } from "unthrown";

import type { RepositoryError, Todo } from "../domain/todo.js";
import { Logger, TodoRepository } from "./ports.js";

export class ListTodos extends Tag("ListTodos")<
  ListTodos,
  () => AsyncResult<readonly Todo[], RepositoryError>
>() {}

export const ListTodosLive = Layer.inject(
  ListTodos,
  { logger: Logger, todos: TodoRepository },
  ({ logger, todos }) =>
    () => {
      logger.info("listing todos");
      return todos.list();
    },
);
