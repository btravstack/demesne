// End-to-end tests with NO database. They go through the SAME `bootstrap` as the server
// (src/app.ts) — the identical wiring, use cases, plugins and routes — swapping only the
// repository for an in-memory fake. Because the application depends on the `TodoRepository`
// *port*, the fake drops in without Prisma or Postgres. The first block drives the real Hono
// app over HTTP; the second exercises the wired combinators (collect / override / forkScope /
// onStop) on that same app.

import { describe, expect, it } from "vitest";

import { type Context, Layer, type ServiceOf, Tag } from "demesne";
import type { Hono } from "hono";
import { Err, Ok, type Result } from "unthrown";

import { GetTodo } from "./application/get-todo.js";
import { AuditSinks } from "./application/plugins.js";
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

// The same app the server builds, with the fake repository — a fresh layer each call.
// The fake needs nothing, so this graph has no `Scope` and builds without a database.
const fakeApp = () => bootstrap(Layer.value(TodoRepository, makeFakeRepo()));

const buildTestApp = async () => buildRoutes((await Layer.build(fakeApp())).unwrap());

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

describe("todos api (HTTP)", () => {
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

  it("POST /todos creates a todo (and fans the event out to the audit sinks)", async () => {
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

describe("combinators on the same app", () => {
  it("collects both audit sinks (member + collect)", async () => {
    const ctx = (await Layer.build(fakeApp())).unwrap();

    expect(ctx.get(AuditSinks).map((sink) => sink.name)).toEqual(["console", "in-memory"]);
  });

  it("forkScope layers a per-request scope on the built app", async () => {
    const app = (await Layer.build(fakeApp())).unwrap();

    class RequestId extends Tag("RequestId")<RequestId, { readonly id: string }>() {}
    const RequestLayer = Layer.factory(RequestId, () => ({ id: "req-7" }));

    const out = await Layer.forkScope(
      app,
      RequestLayer,
      // the fork sees the parent's services (GetTodo) PLUS the request-scoped RequestId
      (ctx): Result<string, never> =>
        Ok(`${ctx.get(RequestId).id}:${typeof ctx.get(GetTodo).execute}`),
    );

    expect(out.unwrap()).toBe("req-7:function");
  });

  it("onStop runs a teardown when the scope closes", async () => {
    const events: string[] = [];
    const Managed = Layer.onStop(fakeApp(), () => {
      events.push("closed");
    });

    const out = await Layer.scoped(
      Managed,
      (ctx: Context<AuditSinks>): Result<number, never> => Ok(ctx.get(AuditSinks).length),
    );

    expect(out.unwrap()).toBe(2);
    expect(events).toEqual(["closed"]);
  });
});
