// Bootstrap — the single place the application is assembled. Both `main.ts` and the tests
// build the app through `bootstrap(...)`, differing ONLY in how orders are stored: main hands
// it the database-backed repository, a test hands it an in-memory fake. The use case, the
// logger and the audit-sink plugins are identical, so a test exercises the very same app
// instead of a hand-rewired copy.

import { Layer } from "demesne";

import { LoggerLive } from "./adapters/logger.js";
import { GetOrderLive } from "./application/get-order.js";
import { AuditSinksLive } from "./application/plugins.js";
import { OrderRepository } from "./application/ports.js";

// The audit-sink collection needs the Logger its console sink reads. `collect` is a composite
// (it eagerly builds its members), so — unlike a leaf layer — `wire` can't defer it a round
// while Logger is built. Satisfy that need with `provideTo` up front.
const AuditSinksWired = Layer.provideTo(AuditSinksLive, LoggerLive);

// Assemble the app around an OrderRepository provider. Generic over the whole repository layer
// so its provisions/errors/requirements flow through (the real repo additionally provides
// Config/Database; a fake provides only the port and needs nothing).
export const bootstrap = <R extends Layer<OrderRepository, unknown, unknown>>(repository: R) =>
  Layer.wire(GetOrderLive, LoggerLive, AuditSinksWired, repository);
