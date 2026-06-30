// Composition root — the one place adapters are bound to ports. Wire with
// Layer.provideTo / Layer.merge, Layer.build once at the edge (handling every wiring
// failure as a static union), then run the use case against the built Context.

import { Layer } from "demesne";

import { getOrder } from "./application/get-order.js";
import { ConfigLive } from "./adapters/config.js";
import { DatabaseLive } from "./adapters/database.js";
import { LoggerLive } from "./adapters/logger.js";
import { OrderRepoLive } from "./adapters/order-repository.js";

const DatabaseWired = Layer.provideTo(DatabaseLive, ConfigLive);
const OrderRepoWired = Layer.provideTo(OrderRepoLive, DatabaseWired);
const AppLayer = Layer.merge(LoggerLive, OrderRepoWired);
//    ^? Layer<Logger | OrderRepository, ConnectionError | ConfigError, never>

const wiring = await Layer.build(AppLayer);
//    ^? Result<Context<Logger | OrderRepository>, ConnectionError | ConfigError>

if (wiring.isOk()) {
  // the built Context provides exactly the ports the use case asks for — and a
  // richer one would still satisfy it, since Context is contravariant in R.
  const order = await getOrder(wiring.unwrap(), "order-1");
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
