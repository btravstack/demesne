// Infrastructure — the TodoRepository port backed by Prisma. Each method wraps a Prisma
// query with `fromPromise` (so a driver rejection becomes a modeled `RepositoryError`) and
// maps rows into the domain `Todo`. `findById` turns a missing row into `TodoNotFound`.
// The factory is sync + infallible; it just assembles the repo from the connected client.

import { type Context, Layer } from "demesne";
import { Err, fromPromise, Ok } from "unthrown";

import { TodoRepository } from "../application/ports.js";
import { RepositoryError, TodoNotFound } from "../domain/todo.js";
import { Database } from "./prisma.js";

export const TodoRepoLive = Layer.factory(TodoRepository, (ctx: Context<Database>) => {
  const db = ctx.get(Database);
  const toRepositoryError = (cause: unknown): RepositoryError => new RepositoryError({ cause });

  return {
    list: () =>
      fromPromise(db.todo.findMany({ orderBy: { createdAt: "desc" } }), toRepositoryError),

    findById: (id) =>
      fromPromise(db.todo.findUnique({ where: { id } }), toRepositoryError).flatMap((row) =>
        row ? Ok(row) : Err(new TodoNotFound({ id })),
      ),

    create: (input) =>
      fromPromise(db.todo.create({ data: { title: input.title } }), toRepositoryError),
  };
});
