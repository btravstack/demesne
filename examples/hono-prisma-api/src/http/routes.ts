// HTTP edge — a Hono app whose handlers resolve use cases from the demesne `Context` and
// map the unthrown `Result` to a response with `.match`. This is the integration seam:
//   demesne provides the wired use cases, unthrown models success/failure, Hono speaks HTTP.
// `ok` → 200/201, a domain `TodoNotFound` → 404, any other modeled error → 500, and a
// `defect` (an unmodeled throw that slipped through) → 500. zod validates the request body.

import type { Context as DemesneContext } from "demesne";
import { Hono } from "hono";
import { z } from "zod";

import { CreateTodo } from "../application/create-todo.js";
import { GetTodo } from "../application/get-todo.js";
import { ListTodos } from "../application/list-todos.js";
import { AuditSinks } from "../application/plugins.js";

const CreateTodoBody = z.object({ title: z.string().min(1).max(200) });

export const buildRoutes = (
  ctx: DemesneContext<ListTodos | GetTodo | CreateTodo | AuditSinks>,
): Hono => {
  const app = new Hono();

  app.get("/todos", async (c) =>
    (await ctx.get(ListTodos).execute()).match<Response>({
      ok: (todos) => c.json(todos),
      err: (error) => c.json({ error: error._tag }, 500),
      defect: () => c.json({ error: "internal error" }, 500),
    }),
  );

  app.get("/todos/:id", async (c) =>
    (await ctx.get(GetTodo).execute(c.req.param("id"))).match<Response>({
      ok: (todo) => c.json(todo),
      err: (error) =>
        error._tag === "TodoNotFound"
          ? c.json({ error: "todo not found" }, 404)
          : c.json({ error: error._tag }, 500),
      defect: () => c.json({ error: "internal error" }, 500),
    }),
  );

  app.post("/todos", async (c) => {
    const body = CreateTodoBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "invalid body", issues: body.error.issues.map((i) => i.message) },
        400,
      );
    }
    return (await ctx.get(CreateTodo).execute(body.data)).match<Response>({
      ok: (todo) => {
        // fan the event out to every audit sink (the multi-binding collection)
        for (const sink of ctx.get(AuditSinks)) sink.record({ action: "create", detail: todo.id });
        return c.json(todo, 201);
      },
      err: (error) => c.json({ error: error._tag }, 500),
      defect: () => c.json({ error: "internal error" }, 500),
    });
  });

  return app;
};
