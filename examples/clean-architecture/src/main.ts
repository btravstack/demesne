// Composition root — build the assembled graph once at the edge, resolve a use case from
// the built context and call `execute`, then fan an audit event out to every plugin. The
// migration hook (see `app.ts`) has already run by the time `build` resolves Ok.

import { Layer } from "demesne";

import { AppStarted } from "./app.js";
import { GetOrder } from "./application/get-order.js";
import { AuditSinks } from "./application/plugins.js";

const wiring = await Layer.build(AppStarted);
//    ^? Result<Context<GetOrder | …>, ConnectionError | ConfigError | MigrationError>

if (wiring.isOk()) {
  const ctx = wiring.unwrap();

  // Resolve the wired use case and run it — demesne already injected its ports.
  const order = await ctx.get(GetOrder).execute("order-1");

  // Fan out to every audit sink (the multi-binding collection).
  for (const sink of ctx.get(AuditSinks)) {
    sink.record({ action: "get-order", detail: "order-1" });
  }

  console.log(
    order.match({
      ok: (o) => `order ${o.id}: ${o.total}`,
      err: (notFound) => `no such order: ${notFound.id}`,
      defect: (cause) => `query panicked: ${String(cause)}`,
    }),
  );
} else {
  // every WIRING failure, handled once as a static union
  const e = wiring.unwrapErr();
  console.error(
    e._tag === "ConfigError"
      ? `config failed: ${e.reason}`
      : e._tag === "MigrationError"
        ? `migration failed: ${e.reason}`
        : `db failed: ${e.url}`,
  );
}
