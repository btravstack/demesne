// HTTP edge — an oRPC router served by a Hono app that is ITSELF a demesne service.
// `Layer.inject` builds it from the use cases + audit sinks + logger (the record is its
// declared dependency list), and the injected `ctx` is the forkScope parent for the
// per-request scope: the catch-all handler forks `RequestScopeLive` around every request —
// fresh RequestId, request-tagged logger, x-request-id response header — and the fork
// closes when the request ends. The forked context travels to the procedures as the oRPC
// context. Each procedure is a `handlerResult` (`@unthrown/orpc`): the handler speaks
// `Result`, `Ok` becomes the output, an `Err` mapped to a declared `errors.CODE()` is
// typed END-TO-END (the client sees the exact code union), and a defect stays a defect
// (oRPC collapses it to INTERNAL_SERVER_ERROR). zod validates inputs at the procedure
// boundary. The domain → transport triage lives in one `mapErr` per procedure:
// `TodoNotFound` → NOT_FOUND, `RepositoryError` → STORAGE_FAILED.

import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { handlerResult } from "@unthrown/orpc/server";
import { type Context as DemesneContext, Layer, type ServiceOf, Tag } from "demesne";
import { Hono } from "hono";
import { fromPromise, TaggedError } from "unthrown";
import { z } from "zod";

import { CreateTodo } from "../application/create-todo.js";
import { GetTodo } from "../application/get-todo.js";
import { ListTodos } from "../application/list-todos.js";
import { AuditSinks } from "../application/plugins.js";
import { Logger } from "../application/ports.js";
import { RequestId, RequestLogger, RequestScopeLive } from "./request.js";

// What the scope middleware hands the procedures: the forked per-request context.
type RequestScope = DemesneContext<Logger | RequestId | RequestLogger>;

const base = os.$context<{ readonly scope: RequestScope }>();

type RouterDeps = {
  readonly list: ServiceOf<ListTodos>;
  readonly get: GetTodo;
  readonly create: ServiceOf<CreateTodo>;
  readonly audit: ServiceOf<AuditSinks>;
};

// Module-scope so the router TYPE is exported for the client side (`RouterClient<TodoRouter>`
// in the tests) — the value is built per app, closing over the injected use cases.
const makeRouter = ({ list, get, create, audit }: RouterDeps) => ({
  todos: {
    list: base.errors({ STORAGE_FAILED: {} }).handler(
      handlerResult(({ context, errors }) => {
        context.scope.get(RequestLogger).info("todos.list");
        return list().mapErr(() => errors.STORAGE_FAILED());
      }),
    ),
    get: base
      .input(z.object({ id: z.string() }))
      .errors({ NOT_FOUND: { message: "todo not found" }, STORAGE_FAILED: {} })
      .handler(
        handlerResult(({ context, input, errors }) => {
          context.scope.get(RequestLogger).info(`todos.get ${input.id}`);
          return get
            .execute(input.id)
            .mapErr((error) =>
              error._tag === "@app/TodoNotFound" ? errors.NOT_FOUND() : errors.STORAGE_FAILED(),
            );
        }),
      ),
    create: base
      .input(z.object({ title: z.string().min(1).max(200) }))
      .errors({ STORAGE_FAILED: {} })
      .handler(
        handlerResult(({ context, input, errors }) => {
          context.scope.get(RequestLogger).info(`todos.create "${input.title}"`);
          return create(input)
            .map((todo) => {
              // fan the event out to every audit sink (the multi-binding collection)
              for (const sink of audit) sink.record({ action: "create", detail: todo.id });
              return todo;
            })
            .mapErr(() => errors.STORAGE_FAILED());
        }),
      ),
  },
});

export type TodoRouter = ReturnType<typeof makeRouter>;

// A handler rejection crossing the fork boundary, qualified into the fork's error union.
class RequestFailed extends TaggedError("@app/RequestFailed", { name: "RequestFailed" })<{
  cause: unknown;
}> {}

export class HttpApp extends Tag("HttpApp")<HttpApp, Hono>() {}

// `logger` sits in the record both as the FORK PARENT's dependency — RequestScopeLive needs
// Logger, and the fork's parent is this layer's own ctx, so Logger must be in the declared
// record for the fork to type-check — and to log the failure cause when a request fails.
export const HttpAppLive = Layer.inject(
  HttpApp,
  { list: ListTodos, get: GetTodo, create: CreateTodo, audit: AuditSinks, logger: Logger },
  ({ list, get, create, audit, logger }, ctx) => {
    const rpc = new RPCHandler(makeRouter({ list, get, create, audit }));
    const app = new Hono();

    // Per-request scope: fork off the app context, dispatch to the oRPC handler with the
    // forked context, stamp the response with the request id, close the fork afterwards.
    app.all("*", async (c) => {
      const out = await Layer.forkScope(ctx, RequestScopeLive, (reqCtx) =>
        fromPromise(
          rpc.handle(c.req.raw, { prefix: "/rpc", context: { scope: reqCtx } }),
          (cause) => new RequestFailed({ cause }),
        ).map(({ response }): Response => {
          const res = response ?? c.json({ error: "no such procedure" }, 404);
          res.headers.set("x-request-id", reqCtx.get(RequestId).id);
          return res;
        }),
      );
      return out.match<Response>({
        ok: (response) => response,
        err: (error) => {
          logger.info(`request failed: ${String(error.cause)}`);
          return c.json({ error: "internal error" }, 500);
        },
        defect: () => c.json({ error: "internal error" }, 500),
      });
    });

    return app;
  },
);
