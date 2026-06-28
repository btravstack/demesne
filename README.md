# demesne

> **Type-safe dependency injection — the wiring sibling of [`unthrown`](https://github.com/btravstack/unthrown).**
> A container holds your services' domain (a typed `Context`) and provides it.
> Requirements **and** construction errors are tracked in the type system: you cannot
> `build` until every dependency is wired, and the set of wiring failures is a static
> union you handle once at the edge.

```sh
pnpm add demesne unthrown
```

`unthrown` is a peer dependency — demesne builds to an `unthrown` `AsyncResult`, so
async and failure are first-class while error handling stays delegated to `unthrown`.

## The problem

Decorator / `reflect-metadata` DI containers bind a **token** to an implementation at
runtime. The token and the type it is supposed to carry can drift apart — a provider
returns the wrong shape, a dependency is never registered — and you find out as a
**runtime** failure, often far from the wiring. The graph's failure modes are
invisible to the compiler.

demesne moves both of those into types. A dependency you forgot to wire is a
**compile error**. Every way construction can fail is a **static union** in the
result type, so you handle it once, exhaustively, at the edge.

## The model

Three concepts:

- **`Tag<Self, Service>`** — a typed key. Its nominal identity (the class + a literal
  `Id`) is what appears in the requirement union `R`; the second parameter is the
  service shape. Two structurally identical services never collide.
- **`Context<R>`** — an immutable map from tag to service. `get` only accepts a tag
  whose identity is in `R` (reading an absent service is a compile error). It is
  **contravariant** in `R`: a `Context<A | B>` works wherever a `Context<A>` is asked.
- **`Layer<Provides, E, Needs>`** — a recipe that builds the services in `Provides`,
  possibly requiring `Needs` and possibly failing with `E`. Both `Needs` and `E`
  accumulate as **unions**: `merge` widens them, `provideTo` subtracts from `Needs`.
  You can `build` only once `Needs` is `never`.

Constructors, by how construction is qualified:

| constructor           | sync/async        | can fail | needs context |
| --------------------- | ----------------- | -------- | ------------- |
| `value(tag, service)` | ready value       | no       | no            |
| `factory(tag, f)`     | sync              | no       | yes           |
| `make(tag, f)`        | sync **or** async | yes      | yes           |

## Example

```ts
import { build, type Context, factory, make, merge, provideTo, Tag, value } from "demesne";
import { Err, fromPromise, Ok, type Result, TaggedError } from "unthrown";

// --- service contracts (ports) ---
interface LoggerService {
  readonly log: (msg: string) => void;
}
class Logger extends Tag("Logger")<Logger, LoggerService>() {}

interface Config {
  readonly dbUrl: string;
}
class AppConfig extends Tag("AppConfig")<AppConfig, Config>() {}

interface DatabaseService {
  readonly query: (sql: string) => readonly unknown[];
}
class Database extends Tag("Database")<Database, DatabaseService>() {}

interface Order {
  readonly id: string;
  readonly total: number;
}
interface OrderRepository {
  readonly findById: (id: string) => Order | null;
}
class OrderRepo extends Tag("OrderRepo")<OrderRepo, OrderRepository>() {}

// --- typed construction errors (unthrown TaggedError) ---
class ConfigError extends TaggedError("ConfigError")<{ reason: string }> {}
class ConnectionError extends TaggedError("ConnectionError")<{ url: string }> {}

// --- layers ---
const LoggerLive = value(Logger, { log: (m) => console.log(`[log] ${m}`) });

// Sync but FALLIBLE: returns a Result. Its error joins the graph's E channel.
const ConfigLive = make(AppConfig, (): Result<Config, ConfigError> => {
  const url = "postgres://localhost/app";
  return url.startsWith("postgres://")
    ? Ok({ dbUrl: url })
    : Err(new ConfigError({ reason: "DB_URL must be a postgres:// url" }));
});

const connectDb = (url: string): Promise<DatabaseService> =>
  url.includes("localhost")
    ? Promise.resolve({ query: () => [] })
    : Promise.reject(new Error("connection refused"));

// ASYNC and fallible: needs AppConfig. `fromPromise` qualifies the rejection
// into a modeled ConnectionError.
const DatabaseLive = make(Database, (ctx: Context<AppConfig>) => {
  const { dbUrl } = ctx.get(AppConfig);
  return fromPromise(connectDb(dbUrl), () => new ConnectionError({ url: dbUrl }));
});

// Sync, infallible, but needs Database.
const OrderRepoLive = factory(OrderRepo, (ctx: Context<Database>) => {
  const db = ctx.get(Database);
  return {
    findById: (id) => (db.query(`select * from orders where id = '${id}'`)[0] as Order) ?? null,
  };
});

// --- wire the graph ---
const DatabaseWired = provideTo(DatabaseLive, ConfigLive);
//    ^? Layer<Database, ConnectionError | ConfigError, never>
const RepoWired = provideTo(OrderRepoLive, DatabaseWired);
const AppLayer = merge(merge(LoggerLive, RepoWired), DatabaseWired);
//    ^? Layer<Logger | OrderRepo | Database, ConnectionError | ConfigError, never>

// --- build at the edge: the error channel is the STATIC UNION of every
//     construction failure the graph can produce. Handle it once. ---
const result = await build(AppLayer);
//    ^? Result<Context<Logger | OrderRepo | Database>, ConnectionError | ConfigError>

const message = result.match({
  ok: (ctx) => {
    ctx.get(Logger).log("app wired");
    const order = ctx.get(OrderRepo).findById("order-1");
    return `ok: ${order === null ? "no order" : order.id}`;
  },
  err: (e) => (e._tag === "ConfigError" ? `config failed: ${e.reason}` : `db failed: ${e.url}`),
  defect: (cause) => `panic: ${String(cause)}`,
});
```

Forget to wire `ConfigLive`, and `build(AppLayer)` is a **compile error** — `Needs`
is not `never`. Add a new fallible `make`, and its error type appears in the union
that `match` must handle.

## Design notes

- **Requirements are declared at boundaries.** A consumer states the ports it needs
  in its `Context<R>` signature, rather than having them inferred from usage. This is
  the deliberate trade versus Effect's inferred `R` channel — for hexagonal / DDD
  code, an explicit port list is a feature.
- **No monad.** demesne does the wiring and nothing else. Async and failure are
  first-class only because construction builds to an `unthrown` `AsyncResult`.
- **`build` is a property, not a method.** Method parameters are checked bivariantly
  in TypeScript, which would let an un-wired layer slip past. A property function
  type keeps strict contravariance in `Needs`, so a missing dependency is a real
  compile error.
- **Qualify at the boundary.** Async / fallible work enters only through `make`; a
  raw `Promise` must never enter a combinator. Re-enter the typed world with
  `fromPromise` / `fromSafePromise`, exactly as in `unthrown`.

## Roadmap

demesne ships the wiring core today. Two capabilities are deliberately **not yet**
implemented (see [`CLAUDE.md`](./CLAUDE.md) for the invariants):

1. **Memoization** — a shared `MemoMap` so each layer constructs **once** across a
   `build`. Today a layer referenced from two branches is built once _per branch_.
2. **Scopes / `acquireRelease`** — ordered resource teardown. Today layers acquire
   but never release.

## License

[MIT](./LICENSE) © Benoit TRAVERS
