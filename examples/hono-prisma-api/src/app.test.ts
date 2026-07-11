// End-to-end tests with NO database. They go through the SAME `bootstrap` as the server
// (src/app.ts) — the identical wiring, use cases, plugins and router — swapping only the
// repository for an in-memory fake. Because the application depends on the `TodoRepository`
// *port*, the fake drops in without Prisma or Postgres. The first block drives the real app
// through a TYPED oRPC client (`@unthrown/orpc`'s `createResultClient` over an `RPCLink`
// whose fetch loops straight back into the Hono app — a genuine request/response cycle,
// JSON serialization and error inference included, without opening a socket); the second
// exercises the combinators (collect / forkScope / onStop) on that same app.

import { describe, expect, it } from "vitest";

// Registers the Result/AsyncResult matchers — the org-wide assertion DNA.
import "@unthrown/vitest";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createResultClient } from "@unthrown/orpc/client";
import { type Context, Layer, type ServiceOf } from "demesne";
import { Err, Ok, type Result } from "unthrown";

import { AuditSinks } from "./application/plugins.js";
import { Logger, TodoRepository } from "./application/ports.js";
import { bootstrap } from "./bootstrap.js";
import { AppConfig } from "./config/env.js";
import { type Todo, TodoNotFound } from "./domain/todo.js";
import { HttpApp, type TodoRouter } from "./http/routes.js";
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
const buildTestApp = async () => (await Layer.build(fakeApp())).get().get(HttpApp);

// Every procedure returns an `AsyncResult`: the errors a procedure declares land TYPED in
// the error channel (an `ORPCError` union discriminated by `code`); anything undeclared —
// including an input-validation rejection — is a Defect.
const clientFor = (app: ServiceOf<HttpApp>) =>
  createResultClient(
    createORPCClient<RouterClient<TodoRouter>>(
      new RPCLink({
        url: "/rpc",
        fetch: async (url, init) => app.request(new Request(new URL(url, "http://app.test"), init)),
      }),
    ),
  );

describe("todos api (typed oRPC client over the app)", () => {
  it("todos.list returns the collection", async () => {
    const rc = clientFor(await buildTestApp());

    await expect(rc.todos.list()).toBeOkWith([expect.objectContaining({ title: "buy milk" })]);
  });

  it("todos.get returns the todo", async () => {
    const rc = clientFor(await buildTestApp());

    await expect(rc.todos.get({ id: "seed-1" })).toBeOkWith(
      expect.objectContaining({ title: "buy milk" }),
    );
  });

  it("todos.get surfaces a missing id as a TYPED NOT_FOUND Err", async () => {
    const rc = clientFor(await buildTestApp());

    await expect(rc.todos.get({ id: "nope" })).toBeErrWith(
      expect.objectContaining({ code: "NOT_FOUND", message: "todo not found", inferable: true }),
    );
  });

  it("todos.create creates a todo (and fans the event out to the audit sinks)", async () => {
    const rc = clientFor(await buildTestApp());

    await expect(rc.todos.create({ title: "walk the dog" })).toBeOkWith(
      expect.objectContaining({ title: "walk the dog", completed: false }),
    );
  });

  it("todos.create then todos.list includes the new todo", async () => {
    const rc = clientFor(await buildTestApp());
    await rc.todos.create({ title: "walk the dog" });

    await expect(rc.todos.list()).toBeOkWith(
      expect.arrayContaining([expect.objectContaining({ title: "walk the dog" })]),
    );
  });

  it("an invalid input is a DEFECT — BAD_REQUEST is not part of the typed contract", async () => {
    const rc = clientFor(await buildTestApp());

    const result = await rc.todos.create({ title: "" });

    expect(result.isDefect() ? result.cause : result).toEqual(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
  });

  it("every response carries a fresh x-request-id (per-request forkScope)", async () => {
    const app = await buildTestApp();

    const first = await app.request("/rpc/todos/list", { method: "POST" });
    const second = await app.request("/rpc/todos/list", { method: "POST" });

    expect(first.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
    expect(first.headers.get("x-request-id")).not.toBe(second.headers.get("x-request-id"));
  });
});

describe("combinators on the same app", () => {
  it("collects both audit sinks (member + collect)", async () => {
    const ctx = (await Layer.build(fakeApp())).get();

    expect(ctx.get(AuditSinks).map((sink) => sink.name)).toEqual(["console", "in-memory"]);
  });

  it("request scope: fresh RequestId per fork, request-tagged logger", async () => {
    const lines: string[] = [];
    const parent = (
      await Layer.build(Layer.value(Logger, { info: (msg) => lines.push(msg) }))
    ).get();

    const idOf = async (): Promise<string> =>
      (
        await Layer.forkScope(parent, RequestScopeLive, (ctx): Result<string, never> => {
          ctx.get(RequestLogger).info("hello");
          return Ok(ctx.get(RequestId).id);
        })
      ).get();

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

    expect(out).toBeOkWith(2);
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
      // over a REAL socket this time: the RPCLink uses the global fetch
      const rc = createResultClient(
        createORPCClient<RouterClient<TodoRouter>>(new RPCLink({ url: "/rpc", origin: url })),
      );
      return rc.todos.list().map((todos) => todos.length);
    });

    expect(out).toBeOkWith(1);
    // the scope has closed → the listener is released and the port refuses connections
    await expect(fetch(`${url}/rpc/todos/list`, { method: "POST" })).rejects.toThrow();
  });
});
