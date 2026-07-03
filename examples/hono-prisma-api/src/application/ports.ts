// Ports — the boundaries the application speaks to, as demesne tags (the class IS the
// tag; the service shape is inlined). Each port operation returns an unthrown result, so
// failure is in the type, not thrown. The ports name only DOMAIN types — never Prisma.

import { Tag } from "demesne";
import type { AsyncResult } from "unthrown";

import type { NewTodo, RepositoryError, Todo, TodoNotFound } from "../domain/todo.js";

export class Logger extends Tag("Logger")<
  Logger,
  {
    readonly info: (msg: string) => void;
  }
>() {}

export class TodoRepository extends Tag("TodoRepository")<
  TodoRepository,
  {
    readonly list: () => AsyncResult<readonly Todo[], RepositoryError>;
    readonly findById: (id: string) => AsyncResult<Todo, TodoNotFound | RepositoryError>;
    readonly create: (input: NewTodo) => AsyncResult<Todo, RepositoryError>;
  }
>() {}
