# Clean Architecture

demesne maps directly onto a clean / hexagonal architecture: the **domain** stays pure,
the **application** depends only on **ports**, **adapters** implement those ports, and a
single **composition root** binds them together. Here is one small use case — fetch an
order — organised by layer.

::: tip This is a real program
The full example lives in
[`examples/clean-architecture`](https://github.com/btravstack/demesne/tree/main/examples/clean-architecture),
one file per layer, compiled by `tsc` against demesne's built types in CI. The snippets
below can't drift from working code.
:::

## Domain

Entities and domain errors. Pure TypeScript — no demesne, no I/O.

```ts
// domain/order.ts
import { TaggedError } from "unthrown";

export type Order = { readonly id: string; readonly total: number };

export class OrderNotFound extends TaggedError("OrderNotFound")<{ id: string }> {}
```

## Ports

The boundaries the application speaks to, as tags. A port's own operations return
unthrown results too, so `findById` is an `AsyncResult`.

```ts
// application/ports.ts
import { Tag } from "demesne";
import { type AsyncResult } from "unthrown";
import type { Order, OrderNotFound } from "../domain/order.js";

export type ServiceOf<T> = T extends Tag<unknown, infer S> ? S : never;

export class Logger extends Tag("Logger")<Logger, {
  readonly log: (msg: string) => void;
}>() {}

export class OrderRepository extends Tag("OrderRepository")<OrderRepository, {
  readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
}>() {}
```

## Application

A use case **declares the ports it needs** in its `Context<…>` signature (requirements
at the boundary, not inferred from usage) and orchestrates them. It never touches an
adapter, a concrete class, or `process.env`.

```ts
// application/get-order.ts
import { type Context } from "demesne";
import { type AsyncResult } from "unthrown";
import type { Order, OrderNotFound } from "../domain/order.js";
import { Logger, OrderRepository } from "./ports.js";

export const getOrder = (
  ctx: Context<Logger | OrderRepository>,
  id: string,
): AsyncResult<Order, OrderNotFound> => {
  ctx.get(Logger).log(`looking up order ${id}`);
  return ctx.get(OrderRepository).findById(id);
};
```

## Adapters

Concrete `Layer`s implementing the ports — the only layer that touches infrastructure.
Its own plumbing tags (`AppConfig`, `Database`) and infrastructure errors live here.

```ts
// adapters/*.ts
import { type Context, Layer, Tag } from "demesne";
import { Err, fromPromise, Ok, TaggedError } from "unthrown";
import { type Order, OrderNotFound } from "../domain/order.js";
import { Logger, OrderRepository, type ServiceOf } from "../application/ports.js";

class AppConfig extends Tag("AppConfig")<AppConfig, { readonly dbUrl: string }>() {}
class Database extends Tag("Database")<Database, {
  readonly query: (sql: string) => readonly unknown[];
}>() {}

class ConfigError extends TaggedError("ConfigError")<{ reason: string }> {}
class ConnectionError extends TaggedError("ConnectionError")<{ url: string }> {}

const LoggerLive = Layer.value(Logger, { log: (m) => console.log(`[log] ${m}`) });

const ConfigLive = Layer.make(AppConfig, () => {
  const url = "postgres://localhost/app"; // from env in real code
  return url.startsWith("postgres://")
    ? Ok({ dbUrl: url })
    : Err(new ConfigError({ reason: "DATABASE_URL must be a postgres:// url" }));
});

const connectDb = (url: string): Promise<ServiceOf<typeof Database>> =>
  url.includes("localhost")
    ? Promise.resolve({ query: () => [] })
    : Promise.reject(new Error("connection refused"));

const DatabaseLive = Layer.make(Database, (ctx: Context<AppConfig>) => {
  const { dbUrl } = ctx.get(AppConfig);
  return fromPromise(connectDb(dbUrl), () => new ConnectionError({ url: dbUrl }));
});

const OrderRepoLive = Layer.factory(OrderRepository, (ctx: Context<Database>) => {
  const db = ctx.get(Database);
  return {
    findById: (id) => {
      const row = db.query(`select * from orders where id = '${id}'`)[0] as Order | undefined;
      return (row ? Ok(row) : Err(new OrderNotFound({ id }))).toAsync();
    },
  };
});
```

## Composition root

The one place adapters are bound to ports. Wire, `Layer.build` once at the edge
(handling every **wiring** failure as a static union), then run the use case against the
built `Context`.

```ts
// main.ts
import { Layer } from "demesne";

const DatabaseWired = Layer.provideTo(DatabaseLive, ConfigLive);
const OrderRepoWired = Layer.provideTo(OrderRepoLive, DatabaseWired);
const AppLayer = Layer.merge(LoggerLive, OrderRepoWired);
//    ^? Layer<Logger | OrderRepository, ConnectionError | ConfigError, never>

const wiring = await Layer.build(AppLayer);

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
  const e = wiring.unwrapErr();
  console.error(e._tag === "ConfigError" ? `config failed: ${e.reason}` : `db failed: ${e.url}`);
}
```

The application talks only to ports; adapters meet ports only at the composition root.
That's the whole shape demesne is built to express.
