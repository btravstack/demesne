// Domain — the Todo entity and its failure modes as tagged errors. Pure TypeScript:
// no demesne, no Prisma, no HTTP. The repository maps database rows into this shape, so
// nothing above the adapter layer depends on Prisma's generated types.

import { TaggedError } from "unthrown";

export type Todo = {
  readonly id: string;
  readonly title: string;
  readonly completed: boolean;
  readonly createdAt: Date;
};

export type NewTodo = { readonly title: string };

// The todo doesn't exist — a domain-level failure, modeled as a value (404 at the edge).
export class TodoNotFound extends TaggedError("@app/TodoNotFound", { name: "TodoNotFound" })<{
  id: string;
}> {}

// The repository couldn't be reached / the query failed — an infrastructure failure the
// port surfaces without leaking Prisma details (500 at the edge).
export class RepositoryError extends TaggedError("@app/RepositoryError", {
  name: "RepositoryError",
})<{
  cause: unknown;
}> {}
