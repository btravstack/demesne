// Composition root — the one place adapters are bound to ports AND the only place the
// Context appears. Wire with Layer.provideTo / Layer.merge, Layer.build once at the edge
// (handling every wiring failure as a static union), then resolve the ports from the
// built Context and hand them to the use case's constructor.

import { Layer } from "demesne";

import { ConfigLive } from "./adapters/config.js";
import { DatabaseLive } from "./adapters/database.js";
import { LoggerLive } from "./adapters/logger.js";
import { OrderRepoLive } from "./adapters/order-repository.js";
import { GetOrder } from "./application/get-order.js";
import { Logger, OrderRepository } from "./application/ports.js";

const DatabaseWired = Layer.provideTo(DatabaseLive, ConfigLive);
const OrderRepoWired = Layer.provideTo(OrderRepoLive, DatabaseWired);
const AppLayer = Layer.merge(LoggerLive, OrderRepoWired);
//    ^? Layer<Logger | OrderRepository, ConnectionError | ConfigError, never>

const wiring = await Layer.build(AppLayer);
//    ^? Result<Context<Logger | OrderRepository>, ConnectionError | ConfigError>

if (wiring.isOk()) {
  const ctx = wiring.unwrap();
  // Constructor injection: resolve the ports the use case needs and `new` it up.
  // `ctx.get` is type-checked — a port the graph didn't provide is a compile error.
  const getOrder = new GetOrder(ctx.get(Logger), ctx.get(OrderRepository));

  const order = await getOrder.execute("order-1");
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
  console.error(e._tag === "ConfigError" ? `config failed: ${e.reason}` : `db failed: ${e.url}`);
}
