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

A use case. Dependencies are injected through the **constructor**; its only public
method is **`execute`**. The signature says exactly what the use case asks for and
returns — the DI container never leaks in. The use case imports no `Context`, no
`Layer`, no demesne at all; it depends only on the port _shapes_ (recovered with
`ServiceOf`).

```ts
// application/get-order.ts
import { type AsyncResult } from "unthrown";
import { Logger, OrderRepository, type ServiceOf } from "./ports.js";

export class GetOrder {
  constructor(
    private readonly logger: ServiceOf<typeof Logger>,
    private readonly orders: ServiceOf<typeof OrderRepository>,
  ) {}

  execute(id: string): AsyncResult<Order, OrderNotFound> {
    this.logger.log(`looking up order ${id}`);
    return this.orders.findById(id);
  }
}
```

::: tip Why not pass the `Context`?
Taking `ctx: Context<…>` as a first argument mixes the use case's _input_ with its
_dependencies_ and couples the application layer to demesne. Constructor injection keeps
`execute(input)` clean and the use case framework-agnostic — `new GetOrder(fakeLogger,
fakeOrders)` is all you need to test it.
:::

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

The one place adapters are bound to ports **and the only place the `Context` appears**.
Wire, `Layer.build` once at the edge (handling every **wiring** failure as a static
union), then resolve the ports from the built `Context` and hand them to the use case's
constructor.

```ts
// main.ts
import { Layer } from "demesne";

const DatabaseWired = Layer.provideTo(DatabaseLive, ConfigLive);
const OrderRepoWired = Layer.provideTo(OrderRepoLive, DatabaseWired);
const AppLayer = Layer.merge(LoggerLive, OrderRepoWired);
//    ^? Layer<Logger | OrderRepository, ConnectionError | ConfigError, never>

const wiring = await Layer.build(AppLayer);

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
  const e = wiring.unwrapErr();
  console.error(e._tag === "ConfigError" ? `config failed: ${e.reason}` : `db failed: ${e.url}`);
}
```

The application talks only to ports; adapters meet ports only at the composition root.
That's the whole shape demesne is built to express.
