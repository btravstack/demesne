import { describe, expect, it } from "vitest";

import {
  build,
  type Context,
  factory,
  type Layer,
  make,
  merge,
  provideTo,
  Tag,
  value,
} from "./index.js";
import { Err, fromPromise, fromSafePromise, Ok, type Result, TaggedError } from "unthrown";

// --- service contracts (ports), mirroring example.ts -------------------------

type LoggerService = { readonly log: (msg: string) => void };
class Logger extends Tag("Logger")<Logger, LoggerService>() {}

type Config = { readonly dbUrl: string };
class AppConfig extends Tag("AppConfig")<AppConfig, Config>() {}

type DatabaseService = { readonly query: (sql: string) => readonly unknown[] };
class Database extends Tag("Database")<Database, DatabaseService>() {}

type Order = { readonly id: string; readonly total: number };
type OrderRepository = { readonly findById: (id: string) => Order | null };
class OrderRepo extends Tag("OrderRepo")<OrderRepo, OrderRepository>() {}

type MarkerService = { readonly ok: boolean };
class Marker extends Tag("Marker")<Marker, MarkerService>() {}

// --- typed construction errors (unthrown TaggedError) ------------------------

class ConfigError extends TaggedError("ConfigError")<{ reason: string }> {}
class ConnectionError extends TaggedError("ConnectionError")<{ url: string }> {}

// A real driver call: rejects unless the url is local.
const connectDb = (url: string): Promise<DatabaseService> =>
  url.includes("localhost")
    ? Promise.resolve({ query: () => [] })
    : Promise.reject(new Error("connection refused"));

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("happy path: a value + factory + make graph builds to Ok", () => {
  it("builds the wired graph and reads services from the resulting Context", async () => {
    const logs: string[] = [];
    const LoggerLive = value(Logger, { log: (m) => logs.push(m) });

    // Sync but fallible: returns a Result whose error joins the E channel.
    const ConfigLive = make(
      AppConfig,
      (): Result<Config, ConfigError> => Ok({ dbUrl: "postgres://localhost/app" }),
    );

    // Async and fallible: needs AppConfig; the rejection is qualified.
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

    const DatabaseWired = provideTo(DatabaseLive, ConfigLive);
    const RepoWired = provideTo(OrderRepoLive, DatabaseWired);
    const AppLayer = merge(merge(LoggerLive, RepoWired), DatabaseWired);

    const result = await build(AppLayer);

    expect(result.isOk()).toBe(true);
    const ctx = result.unwrap();
    ctx.get(Logger).log("app wired");
    expect(logs).toEqual(["app wired"]);
    expect(ctx.get(OrderRepo).findById("order-1")).toBeNull();
    // Note: `ctx.get(AppConfig)` would be a COMPILE error here — AppConfig is
    // consumed by `provideTo` and is not in AppLayer's Provides union.
  });
});

describe("error union at the edge", () => {
  it("a failing make resolves build to Err, and .match routes to the err arm", async () => {
    const ConfigLive = make(
      AppConfig,
      (): Result<Config, ConfigError> =>
        Err(new ConfigError({ reason: "DB_URL must be a postgres:// url" })),
    );
    const DatabaseLive = make(Database, (ctx: Context<AppConfig>) => {
      const { dbUrl } = ctx.get(AppConfig);
      return fromPromise(connectDb(dbUrl), () => new ConnectionError({ url: dbUrl }));
    });
    const DatabaseWired = provideTo(DatabaseLive, ConfigLive);

    const result = await build(DatabaseWired);

    expect(result.isErr()).toBe(true);

    const message = result.match({
      ok: () => "ok",
      err: (e) => (e._tag === "ConfigError" ? `config:${e.reason}` : `db:${e.url}`),
      defect: (cause) => `panic:${String(cause)}`,
    });
    expect(message).toBe("config:DB_URL must be a postgres:// url");

    // the err payload is the expected TaggedError, narrowable by `_tag`.
    const error = result.unwrapErr();
    expect(error).toBeInstanceOf(ConfigError);
    expect(error._tag).toBe("ConfigError");
  });
});

describe("parallel merge", () => {
  it("builds independent layers concurrently (interleaved by timing)", async () => {
    const order: string[] = [];

    const Slow = make(Logger, () =>
      fromSafePromise(async (): Promise<LoggerService> => {
        order.push("slow:start");
        await delay(25);
        order.push("slow:end");
        return { log: () => {} };
      }),
    );
    const Fast = make(AppConfig, () =>
      fromSafePromise(async (): Promise<Config> => {
        order.push("fast:start");
        await delay(5);
        order.push("fast:end");
        return { dbUrl: "postgres://localhost/app" };
      }),
    );

    const result = await build(merge(Slow, Fast));

    expect(result.isOk()).toBe(true);
    // The fast layer starts before the slow one ends → genuine concurrency,
    // and finishes first → interleave, not sequential execution.
    expect(order).toEqual(["slow:start", "fast:start", "fast:end", "slow:end"]);
  });

  it("the first Err short-circuits the merge", async () => {
    const Good = value(Logger, { log: () => {} });
    const Bad = make(
      AppConfig,
      (): Result<Config, ConfigError> => Err(new ConfigError({ reason: "nope" })),
    );

    const result = await build(merge(Good, Bad));

    expect(result.isErr()).toBe(true);
    expect(result.unwrapErr()).toBeInstanceOf(ConfigError);
  });

  it("a thrown value inside construction becomes a Defect", async () => {
    const Good = value(Logger, { log: () => {} });
    const Boom = make(Marker, (): Result<MarkerService, never> => {
      throw new Error("boom");
    });

    const result = await build(merge(Good, Boom));

    expect(result.isDefect()).toBe(true);
  });
});

describe("internals: defensive runtime guards", () => {
  it("get throws when a service is absent from the underlying map", async () => {
    const ctx = (await build(value(Logger, { log: () => {} }))).unwrap();
    // Reading a tag NOT in R is a COMPILE error; widen through `unknown` to
    // force the runtime guard (the type system normally makes this unreachable).
    const widened = ctx as unknown as Context<AppConfig>;
    expect(() => widened.get(AppConfig)).toThrow(/not found in context/);
  });

  it("the phantom _R variance marker is a no-op", async () => {
    const ctx = (await build(value(Logger, { log: () => {} }))).unwrap();
    const phantom = (ctx as unknown as { _R: (r: unknown) => void })._R;
    expect(phantom(undefined)).toBeUndefined();
  });
});

describe("known limitation — single construction is NOT yet guaranteed", () => {
  // A layer referenced from two branches is currently built TWICE: there is no
  // MemoMap yet, so each branch constructs `Shared` independently. This guard
  // documents the current (un-memoized) behavior. When memoization lands, flip
  // the expected count from 2 to 1 — see the Roadmap in CLAUDE.md / README.
  it("a shared layer is built once per branch (currently 2)", async () => {
    let constructions = 0;

    const Shared = make(AppConfig, (): Result<Config, never> => {
      constructions += 1;
      return Ok({ dbUrl: "postgres://localhost/app" });
    });

    type AService = { readonly a: string };
    class TagA extends Tag("TagA")<TagA, AService>() {}
    type BService = { readonly b: string };
    class TagB extends Tag("TagB")<TagB, BService>() {}

    const UsesConfigA = factory(TagA, (ctx: Context<AppConfig>) => ({
      a: ctx.get(AppConfig).dbUrl,
    }));
    const UsesConfigB = factory(TagB, (ctx: Context<AppConfig>) => ({
      b: ctx.get(AppConfig).dbUrl,
    }));

    const BranchA = provideTo(UsesConfigA, Shared);
    const BranchB = provideTo(UsesConfigB, Shared);
    const App: Layer<TagA | TagB, never, never> = merge(BranchA, BranchB);

    const result = await build(App);

    expect(result.isOk()).toBe(true);
    // GUARD: flip to `1` when shared-layer memoization is implemented.
    expect(constructions).toBe(2);
  });
});
