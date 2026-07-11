// Entry point — run the assembled graph with `Layer.scoped`: building it connects Prisma,
// starts the HTTP listener (an `acquireRelease` resource), and runs the startup check.
// `use` just waits for a shutdown signal; when it resolves, the scope closes and teardown
// runs LIFO — the listener stops accepting, then Prisma disconnects. Every startup failure
// is a static union handled once, below.

import { Layer } from "demesne";
import { fromSafePromise } from "unthrown";

import { AppStarted } from "./app.js";
import { Logger } from "./application/ports.js";

const waitForShutdown = (): Promise<void> =>
  new Promise((resolve) => {
    const shutdown = (): void => {
      console.log("shutting down…");
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

const outcome = await Layer.scoped(AppStarted, (ctx) => {
  ctx.get(Logger).info("todos api ready");
  return fromSafePromise(waitForShutdown());
});

// The scope has closed here — listener closed, Prisma disconnected — whether startup
// failed or the server was stopped.
outcome.match({
  ok: () => console.log("bye"),
  err: (error) =>
    console.error(
      error._tag === "@app/ConfigError"
        ? `config invalid: ${error.issues}`
        : error._tag === "@app/MigrationError"
          ? `startup check failed: ${String(error.cause)}`
          : error._tag === "@app/ListenError"
            ? `could not listen: ${String(error.cause)}`
            : `database unreachable: ${String(error.cause)}`,
    ),
  defect: (cause) => console.error(`panic: ${String(cause)}`),
});
