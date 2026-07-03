// Composition — the whole application assembled once with `Layer.wire`, plus a startup
// migration attached with `Layer.onStart`. Shared by the entry point (`main.ts`) and the
// tests (`app.test.ts`), so both exercise the exact same graph.

import { type Context, Layer } from "demesne";
import { Err, Ok, type Result, TaggedError } from "unthrown";

import { ConfigLive } from "./adapters/config.js";
import { Database, DatabaseLive } from "./adapters/database.js";
import { LoggerLive } from "./adapters/logger.js";
import { OrderRepoLive } from "./adapters/order-repository.js";
import { GetOrderLive } from "./application/get-order.js";
import { AuditSinksLive } from "./application/plugins.js";

// A migration failure is one more way construction can fail — it joins the error union.
class MigrationError extends TaggedError("MigrationError")<{ reason: string }> {}

// The audit-sink collection needs the Logger its console sink reads. `collect` is a
// composite (it eagerly builds its members), so — unlike a leaf layer — `wire` can't defer
// it a round while Logger is built. We satisfy that need with `provideTo` up front, handing
// `wire` a self-contained layer that provides AuditSinks and needs nothing.
const AuditSinksWired = Layer.provideTo(AuditSinksLive, LoggerLive);

// The assembled graph. Listed in any order — wire resolves the dependency graph and reports
// (at compile time) any layer whose requirement no other layer provides. Kept as the raw
// `WiredLayer` so tests can re-assemble it with `Layer.override`.
export const AppLayer = Layer.wire(
  GetOrderLive,
  LoggerLive,
  OrderRepoLive,
  DatabaseLive,
  ConfigLive,
  AuditSinksWired,
);
//    ^? WiredLayer<GetOrder | Logger | OrderRepository | Database | AppConfig | AuditSinks,
//                  ConnectionError | ConfigError, never>

// Attach a startup migration to the ASSEMBLED graph (not to a leaf `wire` still resolves):
// it runs AFTER the whole graph is built, before the app serves anything, and — being
// fallible — its error unions into the graph's `E`.
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
