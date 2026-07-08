// HTTP edge — the Hono app is ITSELF a demesne service. `Layer.inject` builds it from the
// use cases + audit sinks + logger (the record is its declared dependency list — no more
// hand-maintained `Context<...>` annotation), and the injected `ctx` is the forkScope
// parent for the per-request scope: a middleware forks `RequestScopeLive` around every
// request — fresh RequestId, request-tagged logger, x-request-id response header — and the
// fork closes when the request ends. Handlers map unthrown Results to responses with
// `.match`: ok → 200/201, a domain `TodoNotFound` → 404, any other modeled error → 500,
// and a defect (an unmodeled throw) → 500. zod validates the request body.

import type { Context as DemesneContext } from "demesne";
import { Layer, Tag } from "demesne";
import { Hono } from "hono";
import { fromPromise, TaggedError } from "unthrown";
import { z } from "zod";

import { CreateTodo } from "../application/create-todo.js";
import { GetTodo } from "../application/get-todo.js";
import { ListTodos } from "../application/list-todos.js";
import { AuditSinks } from "../application/plugins.js";
import { Logger } from "../application/ports.js";
import { RequestId, RequestLogger, RequestScopeLive } from "./request.js";

const CreateTodoBody = z.object({ title: z.string().min(1).max(200) });

// What the scope middleware exposes to handlers: the forked per-request context.
type RequestEnv = {
  Variables: { scope: DemesneContext<Logger | RequestId | RequestLogger> };
};

// A handler rejection crossing the fork boundary, qualified into the fork's error union.
class RequestFailed extends TaggedError("RequestFailed")<{ cause: unknown }> {}

export class HttpApp extends Tag("HttpApp")<HttpApp, Hono<RequestEnv>>() {}

// `logger` sits in the record for the FORK PARENT, not for direct use: RequestScopeLive
// needs Logger, and the fork's parent is this layer's own ctx — so Logger must be in the
// declared record for the fork to type-check.
export const HttpAppLive = Layer.inject(
  HttpApp,
  { list: ListTodos, get: GetTodo, create: CreateTodo, audit: AuditSinks, logger: Logger },
  ({ list, get, create, audit }, ctx) => {
    const app = new Hono<RequestEnv>();

    // Per-request scope: fork off the app context, hand the forked context to handlers,
    // stamp the response with the request id, close the fork after `next`.
    app.use(async (c, next) => {
      const out = await Layer.forkScope(ctx, RequestScopeLive, (reqCtx) => {
        c.set("scope", reqCtx);
        c.header("x-request-id", reqCtx.get(RequestId).id);
        return fromPromise(next(), (cause) => new RequestFailed({ cause }));
      });
      if (!out.isOk()) return c.json({ error: "internal error" }, 500);
      return;
    });

    app.get("/todos", async (c) => {
      c.get("scope").get(RequestLogger).info("GET /todos");
      return (await list()).match<Response>({
        ok: (todos) => c.json(todos),
        err: (error) => c.json({ error: error._tag }, 500),
        defect: () => c.json({ error: "internal error" }, 500),
      });
    });

    app.get("/todos/:id", async (c) => {
      const id = c.req.param("id");
      c.get("scope").get(RequestLogger).info(`GET /todos/${id}`);
      return (await get.execute(id)).match<Response>({
        ok: (todo) => c.json(todo),
        err: (error) =>
          error._tag === "TodoNotFound"
            ? c.json({ error: "todo not found" }, 404)
            : c.json({ error: error._tag }, 500),
        defect: () => c.json({ error: "internal error" }, 500),
      });
    });

    app.post("/todos", async (c) => {
      const body = CreateTodoBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) {
        return c.json(
          { error: "invalid body", issues: body.error.issues.map((i) => i.message) },
          400,
        );
      }
      c.get("scope").get(RequestLogger).info(`POST /todos "${body.data.title}"`);
      return (await create(body.data)).match<Response>({
        ok: (todo) => {
          // fan the event out to every audit sink (the multi-binding collection)
          for (const sink of audit) sink.record({ action: "create", detail: todo.id });
          return c.json(todo, 201);
        },
        err: (error) => c.json({ error: error._tag }, 500),
        defect: () => c.json({ error: "internal error" }, 500),
      });
    });

    return app;
  },
);
