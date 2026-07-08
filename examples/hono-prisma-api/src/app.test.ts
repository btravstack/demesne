// End-to-end tests with NO database. They go through the SAME `bootstrap` as the server
// (src/app.ts) — the identical wiring, use cases, plugins and routes — swapping only the
// repository for an in-memory fake. Because the application depends on the `TodoRepository`
// *port*, the fake drops in without Prisma or Postgres. The first block drives the real Hono
// app over HTTP; the second exercises the combinators (collect / forkScope / onStop) on that
// same app.

import { describe, expect, it } from "vitest";

import { type Context, Layer, type ServiceOf } from "demesne";
import { Err, fromSafePromise, Ok, type Result } from "unthrown";

import { AuditSinks } from "./application/plugins.js";
import { Logger, TodoRepository } from "./application/ports.js";
import { bootstrap } from "./bootstrap.js";
import { AppConfig } from "./config/env.js";
import { type Todo, TodoNotFound } from "./domain/todo.js";
import { HttpApp } from "./http/routes.js";
import { RequestId, RequestLogger, RequestScopeLive } from "./http/request.js";
import { HttpServer, HttpServerLive } from "./http/server.js";

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

// The app is a SERVICE now: bootstrap wires HttpAppLive, so tests read it from the context.
const buildTestApp = async () => (await Layer.build(fakeApp())).unwrap().get(HttpApp);

// Reduce a response to the single entity we assert on: its status and parsed body.
const call = async (
  app: Awaited<ReturnType<typeof buildTestApp>>,
  path: string,
  init?: RequestInit,
) => {
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

  it("every response carries a fresh x-request-id (per-request forkScope)", async () => {
    const app = await buildTestApp();

    const first = await app.request("/todos");
    const second = await app.request("/todos");

    expect(first.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
    expect(first.headers.get("x-request-id")).not.toBe(second.headers.get("x-request-id"));
  });
});

describe("combinators on the same app", () => {
  it("collects both audit sinks (member + collect)", async () => {
    const ctx = (await Layer.build(fakeApp())).unwrap();

    expect(ctx.get(AuditSinks).map((sink) => sink.name)).toEqual(["console", "in-memory"]);
  });

  it("request scope: fresh RequestId per fork, request-tagged logger", async () => {
    const lines: string[] = [];
    const parent = (
      await Layer.build(Layer.value(Logger, { info: (msg) => lines.push(msg) }))
    ).unwrap();

    const idOf = async (): Promise<string> =>
      (
        await Layer.forkScope(parent, RequestScopeLive, (ctx): Result<string, never> => {
          ctx.get(RequestLogger).info("hello");
          return Ok(ctx.get(RequestId).id);
        })
      ).unwrap();

    const first = await idOf();
    const second = await idOf();

    expect(first).not.toBe(second); // fresh instances per fork
    expect(lines).toEqual([`[${first}] hello`, `[${second}] hello`]);
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

  it("the HTTP listener is a resource: serves inside the scope, closed after", async () => {
    // PORT 0 → the OS assigns a free port; the acquired service reports the real one.
    const TestConfig = Layer.value(AppConfig, {
      DATABASE_URL: "postgres://unused",
      PORT: 0,
      LOG_LEVEL: "info",
    });
    const boot = fakeApp();
    const withServer = Layer.merge(
      boot,
      Layer.provideTo(HttpServerLive, Layer.merge(boot, TestConfig)),
    );

    let url = "";
    const out = await Layer.scoped(withServer, (ctx) => {
      url = `http://127.0.0.1:${ctx.get(HttpServer).port}`;
      return fromSafePromise(fetch(`${url}/todos`).then((res) => res.status));
    });

    expect(out.unwrap()).toBe(200);
    // the scope has closed → the listener is released and the port refuses connections
    await expect(fetch(`${url}/todos`)).rejects.toThrow();
  });
});
