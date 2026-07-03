// Entry point — run the assembled graph with `Layer.scoped`: build it (connecting Prisma),
// serve the Hono app for the lifetime of `use`, and close the scope on shutdown (which
// disconnects Prisma, LIFO). The server lifetime IS the scope: `use` resolves when a
// SIGINT/SIGTERM arrives, after which teardown runs and the process exits.

import { serve } from "@hono/node-server";
import { Layer } from "demesne";
import { fromSafePromise, Ok, type Result } from "unthrown";

import { AppStarted } from "./app.js";
import { AppConfig } from "./config/env.js";
import { buildRoutes } from "./http/routes.js";

const outcome = await Layer.scoped(AppStarted, (ctx) => {
  const port = ctx.get(AppConfig).PORT;
  const app = buildRoutes(ctx);

  return fromSafePromise(
    new Promise<Result<void, never>>((resolve) => {
      const server = serve({ fetch: app.fetch, port }, (info) => {
        console.log(`todos api listening on http://localhost:${info.port}`);
      });
      const shutdown = (): void => {
        console.log("shutting down…");
        server.close(() => resolve(Ok(undefined)));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    }),
  );
});

// The scope has closed here — Prisma is disconnected — whether startup failed or the
// server was stopped. Every startup failure is a static union handled once.
outcome.match({
  ok: () => console.log("bye"),
  err: (error) =>
    console.error(
      error._tag === "ConfigError"
        ? `config invalid: ${error.issues}`
        : error._tag === "MigrationError"
          ? `startup check failed: ${String(error.cause)}`
          : `database unreachable: ${String(error.cause)}`,
    ),
  defect: (cause) => console.error(`panic: ${String(cause)}`),
});
