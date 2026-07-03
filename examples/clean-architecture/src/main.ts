// Composition root — hand every layer to `Layer.wire` and it resolves the order
// automatically (GetOrder needs the repo + logger, the repo needs the DB, the DB needs
// config…). `Layer.build` runs the whole graph once at the edge; you resolve a use case
// from the built context and call `execute`. No manual `provideTo` / `merge` threading.

import { Layer } from "demesne";

import { ConfigLive } from "./adapters/config.js";
import { DatabaseLive } from "./adapters/database.js";
import { LoggerLive } from "./adapters/logger.js";
import { OrderRepoLive } from "./adapters/order-repository.js";
import { GetOrder, GetOrderLive } from "./application/get-order.js";

// Listed in any order — wire figures out the dependency graph and reports (at compile
// time) any layer whose requirement no other layer provides.
const AppLayer = Layer.wire(GetOrderLive, LoggerLive, OrderRepoLive, DatabaseLive, ConfigLive);
//    ^? Layer<GetOrder | Logger | OrderRepository | Database | AppConfig, ConnectionError | ConfigError, never>

const wiring = await Layer.build(AppLayer);
//    ^? Result<Context<GetOrder | …>, ConnectionError | ConfigError>

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
