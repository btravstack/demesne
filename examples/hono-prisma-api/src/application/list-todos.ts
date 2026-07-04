// Application — the "list todos" use case. Constructor-injected ports, one public `execute`
// method, and NO demesne types inside the class. `Layer.class` does the injection from a deps
// list — no hand-written factory, no `ctx.get` — while the class stays plain TS. The deps list
// is type-checked against the constructor (wrong order / type / arity is a compile error).

import { Layer, type ServiceOf, Tag } from "demesne";
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

export const ListTodosLive = Layer.class(ListTodos, [Logger, TodoRepository], ListTodosInteractor);
