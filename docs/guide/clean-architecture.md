# Clean Architecture

demesne maps directly onto a clean / hexagonal architecture: the **domain** stays pure,
the **application** depends only on **ports**, **adapters** implement those ports, and a
single **composition root** binds them together. Here is one small use case — fetch an
order — organised by layer.

::: tip This is a real program
The same layering — with a Hono REST API, zod config and Prisma/Postgres on top — is a full
runnable program in
[`examples/hono-prisma-api`](https://github.com/btravstack/demesne/tree/main/examples/hono-prisma-api),
compiled by `tsc` against demesne's built types and tested in CI. The snippets below (an
`Order` use case) teach the pattern; the example applies it to a `Todo` API.
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

export class Logger extends Tag("Logger")<Logger, {
  readonly log: (msg: string) => void;
}>() {}

export class OrderRepository extends Tag("OrderRepository")<OrderRepository, {
  readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
}>() {}
```

## Application

A use case, **wired by demesne**. The implementation is a class with constructor-injected
ports and a single public `execute` method — it uses no demesne types, so its signature
says only what it asks for and returns. `Layer.class` performs the constructor injection from
a **deps list** — no hand-written factory — so the use case joins the typed graph:
`Layer.build` won't compile until its ports are wired, and the rest of the app resolves it with
`ctx.get(GetOrder)`.

```ts
// application/get-order.ts
import { Layer, type ServiceOf, Tag } from "demesne";
import { type AsyncResult } from "unthrown";
import { Logger, OrderRepository } from "./ports.js";

// The use case logic — constructor DI, one public method, framework-agnostic (no demesne).
class GetOrderInteractor {
  constructor(
    private readonly logger: ServiceOf<Logger>,
    private readonly orders: ServiceOf<OrderRepository>,
  ) {}

  execute(id: string): AsyncResult<Order, OrderNotFound> {
    this.logger.log(`looking up order ${id}`);
    return this.orders.findById(id);
  }
}

// The use case as a port other code resolves from the context.
export class GetOrder extends Tag("GetOrder")<GetOrder, GetOrderInteractor>() {}

// The application layer: demesne constructs `new GetOrderInteractor(logger, orders)` for you;
// the tag list is checked against the constructor, its identities become the layer's Needs.
export const GetOrderLive = Layer.class(GetOrder, [Logger, OrderRepository], GetOrderInteractor);
```

::: tip Constructor injection, not a `Context` argument
Taking `ctx: Context<…>` as a first argument of `execute` would mix the use case's
_input_ with its _dependencies_ and couple the application logic to demesne. Keeping the
ports in the **constructor** leaves `execute(input)` clean and the interactor
framework-agnostic — `new GetOrderInteractor(fakeLogger, fakeOrders)` is all you need to
test it. `Layer.class` is the only seam that knows the tags — and if you'd rather fuse the
tag, injection and layer into one declaration (accepting a demesne base class), `Service`
does that: `class GetOrder extends Service<GetOrder>()("GetOrder", { logger: Logger, orders:
OrderRepository }) { … }`, with `GetOrder.layer` as the layer.
:::

## Adapters

Concrete `Layer`s implementing the ports — the only layer that touches infrastructure.
Its own plumbing tags (`AppConfig`, `Database`) and infrastructure errors live here.

```ts
// adapters/*.ts
import { type Context, Layer, type ServiceOf, Tag } from "demesne";
import { Err, fromPromise, Ok, TaggedError } from "unthrown";
import { type Order, OrderNotFound } from "../domain/order.js";
import { Logger, OrderRepository } from "../application/ports.js";

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

const connectDb = (url: string): Promise<ServiceOf<Database>> =>
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

Compose the graph **by hand** with `provideTo` and `merge` — single-pass and fully
type-checked. Thread each adapter into the port that needs it, then `merge` the branches
into one app layer. `Layer.build` runs the whole graph once at the edge (handling every
**wiring** failure as a static union); you then resolve a use case from the built context
and call `execute`.

```ts
// main.ts
import { Layer } from "demesne";

// Thread the dependency chain — Config → Database → OrderRepository → GetOrder.
const DatabaseWired = Layer.provideTo(DatabaseLive, ConfigLive);
const RepoWired = Layer.provideTo(OrderRepoLive, DatabaseWired);
const GetOrderWired = Layer.provideTo(GetOrderLive, Layer.merge(LoggerLive, RepoWired));

// Merge the branches into the app layer — a port left unthreaded is a compile error here.
const AppLayer = Layer.merge(GetOrderWired, LoggerLive, RepoWired, DatabaseWired);
//    ^? Layer<GetOrder | Logger | OrderRepository | Database, ConnectionError | ConfigError, never>

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
  const e = wiring.unwrapErr();
  console.error(e._tag === "ConfigError" ? `config failed: ${e.reason}` : `db failed: ${e.url}`);
}
```

The application talks only to ports; adapters meet ports only at the composition root.
That's the whole shape demesne is built to express.
