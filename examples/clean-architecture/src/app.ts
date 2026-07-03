// Composition — the database-backed application, assembled through the shared `bootstrap`,
// plus a startup migration attached with `Layer.onStart`. `main.ts` and the tests both go
// through `bootstrap`, so they exercise the exact same graph.

import { type Context, Layer } from "demesne";
import { Err, Ok, type Result, TaggedError } from "unthrown";

import { ConfigLive } from "./adapters/config.js";
import { Database, DatabaseLive } from "./adapters/database.js";
import { OrderRepoLive } from "./adapters/order-repository.js";
import { bootstrap } from "./bootstrap.js";

// A migration failure is one more way construction can fail — it joins the error union.
class MigrationError extends TaggedError("MigrationError")<{ reason: string }> {}

// The database-backed repository, self-contained: config → database → repository. This is the
// storage the app runs against; a test swaps it for a fake (see app.test.ts).
const RealRepository = Layer.wire(OrderRepoLive, DatabaseLive, ConfigLive);

// Kept as the raw `WiredLayer` so tests can re-assemble it with `Layer.override` / fork it.
export const AppLayer = bootstrap(RealRepository);
//    ^? WiredLayer<GetOrder | Logger | AuditSinks | OrderRepository | Database | AppConfig,
//                  ConnectionError | ConfigError, never>

// Attach a startup migration to the ASSEMBLED graph (not to a leaf `wire` still resolves): it
// runs AFTER the whole graph is built, before the app serves anything, and — being fallible —
// its error unions into the graph's `E`.
export const AppStarted = Layer.onStart(
  AppLayer,
  (ctx: Context<Database>): Result<void, MigrationError> => {
    const rows = ctx.get(Database).query("select version()"); // a real migration/health check
    return rows.length === 0
      ? Ok(undefined)
      : Err(new MigrationError({ reason: `unexpected ${rows.length} rows` }));
  },
);
//    ^? Layer<…same provides…, ConnectionError | ConfigError | MigrationError, never>
