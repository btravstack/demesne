// End-to-end HTTP tests with NO database. They go through the SAME `bootstrap` as the server
// (src/app.ts) — the identical wiring, use cases and routes — swapping only the repository
// for an in-memory fake. Because the application depends on the `TodoRepository` *port*, the
// fake drops in without Prisma or Postgres, and `app.request(...)` drives the real Hono app.

import { describe, expect, it } from "vitest";

import { Layer, type ServiceOf } from "demesne";
import type { Hono } from "hono";
import { Err, Ok } from "unthrown";

import { TodoRepository } from "./application/ports.js";
import { bootstrap } from "./bootstrap.js";
import { type Todo, TodoNotFound } from "./domain/todo.js";
import { buildRoutes } from "./http/routes.js";

// An in-memory stand-in for the Prisma-backed repository — same port, no I/O.
const makeFakeRepo = (): ServiceOf<TodoRepository> => {
  const store: Todo[] = [
    {
      id: "seed-1",
      title: "buy milk",
      completed: false,
      createdAt: new Date("2020-01-01T00:00:00Z"),
    },
  ];
  return {
    list: () => Ok(store.slice() as readonly Todo[]).toAsync(),
    findById: (id) => {
      const found = store.find((todo) => todo.id === id);
      return (found ? Ok(found) : Err(new TodoNotFound({ id }))).toAsync();
    },
    create: (input) => {
      const created: Todo = {
        id: `id-${store.length + 1}`,
        title: input.title,
        completed: false,
        createdAt: new Date("2020-06-01T00:00:00Z"),
      };
      store.push(created);
      return Ok(created).toAsync();
    },
  };
};

// Build the SAME app the server builds, but with the fake repository in place of Prisma.
// The fake needs nothing, so this graph has no `Scope` and builds without a database.
const buildTestApp = async () => {
  const ctx = (await Layer.build(bootstrap(Layer.value(TodoRepository, makeFakeRepo())))).unwrap();
  return buildRoutes(ctx);
};

// Reduce a response to the single entity we assert on: its status and parsed body.
const call = async (app: Hono, path: string, init?: RequestInit) => {
  const res = await app.request(path, init);
  return { status: res.status, body: (await res.json()) as unknown };
};

const postJson = (title: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title }),
});

describe("todos api", () => {
  it("GET /todos returns the collection", async () => {
    const app = await buildTestApp();

    expect(await call(app, "/todos")).toEqual(
      expect.objectContaining({
        status: 200,
        body: [expect.objectContaining({ title: "buy milk" })],
      }),
    );
  });

  it("GET /todos/:id returns the todo", async () => {
    const app = await buildTestApp();

    expect(await call(app, "/todos/seed-1")).toEqual(
      expect.objectContaining({
        status: 200,
        body: expect.objectContaining({ title: "buy milk" }),
      }),
    );
  });

  it("GET /todos/:id returns 404 when missing", async () => {
    const app = await buildTestApp();

    expect(await call(app, "/todos/nope")).toEqual(
      expect.objectContaining({ status: 404, body: { error: "todo not found" } }),
    );
  });

  it("POST /todos creates a todo", async () => {
    const app = await buildTestApp();

    expect(await call(app, "/todos", postJson("walk the dog"))).toEqual(
      expect.objectContaining({
        status: 201,
        body: expect.objectContaining({ title: "walk the dog" }),
      }),
    );
  });

  it("POST /todos then GET /todos includes the new todo", async () => {
    const app = await buildTestApp();
    await call(app, "/todos", postJson("walk the dog"));

    expect(await call(app, "/todos")).toEqual(
      expect.objectContaining({
        status: 200,
        body: expect.arrayContaining([expect.objectContaining({ title: "walk the dog" })]),
      }),
    );
  });

  it("POST /todos rejects an invalid body with 400", async () => {
    const app = await buildTestApp();

    expect(await call(app, "/todos", postJson(""))).toEqual(
      expect.objectContaining({
        status: 400,
        body: expect.objectContaining({ error: "invalid body" }),
      }),
    );
  });
});
