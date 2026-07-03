// End-to-end HTTP tests with NO database. Because the application depends on the
// `TodoRepository` *port*, we wire an in-memory fake in its place — no Prisma, no Postgres —
// and drive the real Hono app with `app.request(...)`. This exercises the whole integration
// (demesne wiring → use case → unthrown Result → Hono response) and every status mapping.

import { describe, expect, it } from "vitest";

import { Layer, type ServiceOf } from "demesne";
import { Err, Ok } from "unthrown";

import { TodoRepository } from "./application/ports.js";
import { CreateTodoLive } from "./application/create-todo.js";
import { GetTodoLive } from "./application/get-todo.js";
import { ListTodosLive } from "./application/list-todos.js";
import { type Todo, TodoNotFound } from "./domain/todo.js";
import { LoggerLive } from "./infra/logger.js";
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

// Wire the app with the fake repository and a plain logger — no Config, no Database, so it
// builds without a `Scope` and needs no Postgres.
const buildTestApp = async () => {
  const TestApp = Layer.wire(
    LoggerLive,
    Layer.value(TodoRepository, makeFakeRepo()),
    ListTodosLive,
    GetTodoLive,
    CreateTodoLive,
  );
  const ctx = (await Layer.build(TestApp)).unwrap();
  return buildRoutes(ctx);
};

describe("todos api", () => {
  it("GET /todos returns the collection", async () => {
    const app = await buildTestApp();
    const res = await app.request("/todos");

    expect(res.status).toBe(200);
    const body = (await res.json()) as Todo[];
    expect(body.map((t) => t.title)).toEqual(["buy milk"]);
  });

  it("GET /todos/:id returns one, or 404 when missing", async () => {
    const app = await buildTestApp();

    const hit = await app.request("/todos/seed-1");
    expect(hit.status).toBe(200);
    expect(((await hit.json()) as Todo).title).toBe("buy milk");

    const miss = await app.request("/todos/nope");
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ error: "todo not found" });
  });

  it("POST /todos creates a todo (201) and it then shows up in the list", async () => {
    const app = await buildTestApp();

    const created = await app.request("/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "walk the dog" }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as Todo).title).toBe("walk the dog");

    const list = (await (await app.request("/todos")).json()) as Todo[];
    expect(list.map((t) => t.title)).toContain("walk the dog");
  });

  it("POST /todos rejects an invalid body with 400", async () => {
    const app = await buildTestApp();

    const res = await app.request("/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid body");
  });
});
