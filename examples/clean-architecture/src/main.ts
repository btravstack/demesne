// Composition root — bind adapters to ports, then wire the application layer on top.
// `Layer.build` runs the whole graph once at the edge; you resolve a use case from the
// built context and call `execute`. No manual construction.

import { Layer } from "demesne";

import { ConfigLive } from "./adapters/config.js";
import { DatabaseLive } from "./adapters/database.js";
import { LoggerLive } from "./adapters/logger.js";
import { OrderRepoLive } from "./adapters/order-repository.js";
import { GetOrder, GetOrderLive } from "./application/get-order.js";

// Infrastructure — adapters wired to their ports.
const DatabaseWired = Layer.provideTo(DatabaseLive, ConfigLive);
const OrderRepoWired = Layer.provideTo(OrderRepoLive, DatabaseWired);
const ServicesLayer = Layer.merge(LoggerLive, OrderRepoWired);
//    ^? Layer<Logger | OrderRepository, ConnectionError | ConfigError, never>

// Application — use cases, each constructor-injected from the services. The built
// context exposes only the use cases; the infrastructure ports stay hidden.
const AppLayer = Layer.provideTo(GetOrderLive, ServicesLayer);
//    ^? Layer<GetOrder, ConnectionError | ConfigError, never>

const wiring = await Layer.build(AppLayer);
//    ^? Result<Context<GetOrder>, ConnectionError | ConfigError>

if (wiring.isOk()) {
  // Resolve the wired use case and run it — demesne already injected its ports.
  const order = await wiring.unwrap().get(GetOrder).execute("order-1");
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
