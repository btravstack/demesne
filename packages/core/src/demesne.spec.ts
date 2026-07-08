import { describe, expect, it, vi } from "vitest";

import { Context, Layer, Service, Tag } from "./index.js";
import {
  type AsyncResult,
  Err,
  fromPromise,
  fromSafePromise,
  Ok,
  type Result,
  TaggedError,
} from "unthrown";

// Recover a service's shape from its tag when a signature wants it by name.
type ServiceOf<T> = T extends Tag<unknown, infer S> ? S : never;

// --- service tags (the class IS the tag; the service shape is inlined) -------

class LoggerService extends Tag("LoggerService")<
  LoggerService,
  {
    readonly log: (msg: string) => void;
  }
>() {}

class AppConfig extends Tag("AppConfig")<AppConfig, { readonly dbUrl: string }>() {}

class DatabaseService extends Tag("DatabaseService")<
  DatabaseService,
  {
    readonly query: (sql: string) => readonly unknown[];
  }
>() {}

// Order is a domain entity, not a service — it stays a named type.
type Order = { readonly id: string; readonly total: number };

// A service's own operations are unthrown results too: findById returns an
// AsyncResult, not a bare `Order | null`.
class OrderRepository extends Tag("OrderRepository")<
  OrderRepository,
  {
    readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
  }
>() {}

class Marker extends Tag("Marker")<Marker, { readonly ok: boolean }>() {}

// --- typed errors (unthrown TaggedError) -------------------------------------

class ConfigError extends TaggedError("ConfigError")<{ reason: string }> {}
class ConnectionError extends TaggedError("ConnectionError")<{ url: string }> {}
class OrderNotFound extends TaggedError("OrderNotFound")<{ id: string }> {}

// A real driver call: rejects unless the url is local.
const connectDb = (url: string): Promise<ServiceOf<typeof DatabaseService>> =>
  url.includes("localhost")
    ? Promise.resolve({ query: () => [] })
    : Promise.reject(new Error("connection refused"));

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("happy path: a value + factory + make graph builds to Ok", () => {
  it("builds the wired graph and reads services from the resulting Context", async () => {
    const logs: string[] = [];
    const LoggerLive = Layer.value(LoggerService, { log: (m) => logs.push(m) });

    // Sync but fallible: returns a Result whose error joins the E channel.
    const ConfigLive = Layer.make(
      AppConfig,
      (): Result<ServiceOf<typeof AppConfig>, ConfigError> =>
        Ok({ dbUrl: "postgres://localhost/app" }),
    );

    // Async and fallible: needs AppConfig; the rejection is qualified.
    const DatabaseLive = Layer.make(DatabaseService, (ctx: Context<AppConfig>) => {
      const { dbUrl } = ctx.get(AppConfig);
      return fromPromise(connectDb(dbUrl), () => new ConnectionError({ url: dbUrl }));
    });

    // The factory is sync + infallible; the repo's findById returns an
    // AsyncResult carrying a modeled OrderNotFound.
    const OrderRepoLive = Layer.factory(OrderRepository, (ctx: Context<DatabaseService>) => {
      const db = ctx.get(DatabaseService);
      return {
        findById: (id) => {
          const row = db.query(`select * from orders where id = '${id}'`)[0] as Order | undefined;
          return (row ? Ok(row) : Err(new OrderNotFound({ id }))).toAsync();
        },
      };
    });

    const DatabaseWired = Layer.provideTo(DatabaseLive, ConfigLive);
    const RepoWired = Layer.provideTo(OrderRepoLive, DatabaseWired);
    // merge is variadic — combine the three independent layers in one call.
    const AppLayer = Layer.merge(LoggerLive, RepoWired, DatabaseWired);

    const result = await Layer.build(AppLayer);

    expect(result.isOk()).toBe(true);
    const ctx = result.unwrap();
    ctx.get(LoggerService).log("app wired");
    expect(logs).toEqual(["app wired"]);
    // A service operation is itself an unthrown AsyncResult — await and inspect it.
    const found = await ctx.get(OrderRepository).findById("order-1");
    expect(found.unwrapErr()).toBeInstanceOf(OrderNotFound);
    // Note: `ctx.get(AppConfig)` would be a COMPILE error here — AppConfig is
    // consumed by `provideTo` and is not in AppLayer's Provides union.
  });
});

describe("Layer.class: constructor injection without a hand-written factory", () => {
  it("resolves the deps list and constructs the class, injecting services in order", async () => {
    const logs: string[] = [];
    const order: Order = { id: "o-1", total: 42 };

    // Plain application class — no demesne import, just `ServiceOf<...>` constructor params.
    class GetOrderInteractor {
      constructor(
        private readonly logger: ServiceOf<typeof LoggerService>,
        private readonly orders: ServiceOf<typeof OrderRepository>,
      ) {}
      run(id: string): AsyncResult<Order, OrderNotFound> {
        this.logger.log(`get ${id}`);
        return this.orders.findById(id);
      }
    }
    class GetOrder extends Tag("ClassGetOrder")<GetOrder, GetOrderInteractor>() {}

    const LoggerLive = Layer.value(LoggerService, { log: (m) => logs.push(m) });
    const RepoLive = Layer.value(OrderRepository, {
      findById: (id) => (id === "o-1" ? Ok(order) : Err(new OrderNotFound({ id }))).toAsync(),
    });
    // The deps list drives `new GetOrderInteractor(logger, orders)` — no factory, no `ctx.get`.
    const GetOrderLive = Layer.class(
      GetOrder,
      [LoggerService, OrderRepository],
      GetOrderInteractor,
    );

    const ctx = (
      await Layer.build(Layer.provideTo(GetOrderLive, Layer.merge(LoggerLive, RepoLive)))
    ).unwrap();
    const found = await ctx.get(GetOrder).run("o-1");

    expect(found.unwrap()).toEqual(order);
    expect(logs).toEqual(["get o-1"]);
  });

  it("a throw in the constructed class becomes a Defect", async () => {
    class Boom {
      constructor(_logger: ServiceOf<typeof LoggerService>) {
        throw new Error("ctor boom");
      }
    }
    class BoomTag extends Tag("ClassBoom")<BoomTag, Boom>() {}
    const LoggerLive = Layer.value(LoggerService, { log: () => {} });
    const BoomLive = Layer.class(BoomTag, [LoggerService], Boom);

    const result = await Layer.build(Layer.provideTo(BoomLive, LoggerLive));

    expect(result.isDefect()).toBe(true);
  });
});

describe("Service: tag + injection + layer in one declaration", () => {
  it("injects each dep as a typed field and builds via Layer.fromService", async () => {
    const logs: string[] = [];
    const order: Order = { id: "s-1", total: 7 };

    // One declaration: a Tag with injected `this.logger` / `this.orders`; its layer is
    // `Layer.fromService(GetOrderSvc)`.
    class GetOrderSvc extends Service<GetOrderSvc>()("SvcGetOrder", {
      logger: LoggerService,
      orders: OrderRepository,
    }) {
      run(id: string): AsyncResult<Order, OrderNotFound> {
        this.logger.log(`svc ${id}`);
        return this.orders.findById(id);
      }
    }

    const LoggerLive = Layer.value(LoggerService, { log: (m) => logs.push(m) });
    const RepoLive = Layer.value(OrderRepository, {
      findById: (id) => (id === "s-1" ? Ok(order) : Err(new OrderNotFound({ id }))).toAsync(),
    });

    const GetOrderSvcLive = Layer.fromService(GetOrderSvc);
    const ctx = (
      await Layer.build(Layer.provideTo(GetOrderSvcLive, Layer.merge(LoggerLive, RepoLive)))
    ).unwrap();
    const found = await ctx.get(GetOrderSvc).run("s-1");

    expect(found.unwrap()).toEqual(order);
    expect(logs).toEqual(["svc s-1"]);
  });

  it("a Service instance constructs directly from a deps object (framework-free test)", () => {
    const logs: string[] = [];
    class Widget extends Service<Widget>()("SvcWidget", { logger: LoggerService }) {
      greet(): string {
        this.logger.log("hi");
        return "ok";
      }
    }

    // No container needed to unit-test the logic: hand it a fake deps object.
    const widget = new Widget({ logger: { log: (m) => logs.push(m) } });

    expect(widget.greet()).toBe("ok");
  });
});

describe("Layer.describe + Layer.toDot: graph introspection", () => {
  it("models the graph — exact edges for class/value, inferred from provideTo for factory/make", () => {
    class GraphInteractor {
      constructor(
        readonly logger: ServiceOf<typeof LoggerService>,
        readonly orders: ServiceOf<typeof OrderRepository>,
      ) {}
    }
    class GraphGetOrder extends Tag("GraphGetOrder")<GraphGetOrder, GraphInteractor>() {}

    const LoggerLive = Layer.value(LoggerService, { log: () => {} });
    const ConfigLive = Layer.make(
      AppConfig,
      (): Result<ServiceOf<typeof AppConfig>, never> => Ok({ dbUrl: "x" }),
    );
    const DatabaseLive = Layer.make(
      DatabaseService,
      (ctx: Context<AppConfig>): Result<ServiceOf<typeof DatabaseService>, never> => {
        void ctx;
        return Ok({ query: () => [] });
      },
    );
    const OrderRepoLive = Layer.factory(OrderRepository, (ctx: Context<DatabaseService>) => {
      void ctx.get(DatabaseService);
      return { findById: (id: string) => Err(new OrderNotFound({ id })).toAsync() };
    });
    const GetOrderLive = Layer.class(
      GraphGetOrder,
      [LoggerService, OrderRepository],
      GraphInteractor,
    );

    const DatabaseWired = Layer.provideTo(DatabaseLive, ConfigLive);
    const RepoWired = Layer.provideTo(OrderRepoLive, DatabaseWired);
    const root = Layer.provideTo(GetOrderLive, Layer.merge(LoggerLive, RepoWired));

    // one entity: the whole normalized graph. class/value needs are exact; the factory's and
    // make's needs are erased, so their edges are inferred from the provideTo composition.
    expect(Layer.describe(root)).toEqual({
      nodes: [
        { key: "AppConfig", kind: "make" },
        { key: "DatabaseService", kind: "make" },
        { key: "GraphGetOrder", kind: "class" },
        { key: "LoggerService", kind: "value" },
        { key: "OrderRepository", kind: "factory" },
      ],
      edges: [
        { from: "DatabaseService", to: "AppConfig", inferred: true },
        { from: "GraphGetOrder", to: "LoggerService", inferred: false },
        { from: "GraphGetOrder", to: "OrderRepository", inferred: false },
        { from: "OrderRepository", to: "DatabaseService", inferred: true },
      ],
    });

    // the DOT of the same graph: plain nodes, exact edges solid, inferred edges dashed.
    expect(Layer.toDot(root)).toBe(
      [
        `digraph "demesne" {`,
        `  "AppConfig";`,
        `  "DatabaseService";`,
        `  "GraphGetOrder";`,
        `  "LoggerService";`,
        `  "OrderRepository";`,
        `  "DatabaseService" -> "AppConfig" [style=dashed];`,
        `  "GraphGetOrder" -> "LoggerService";`,
        `  "GraphGetOrder" -> "OrderRepository";`,
        `  "OrderRepository" -> "DatabaseService" [style=dashed];`,
        `}`,
      ].join("\n"),
    );
  });

  it("sees through onStart / onStop wrappers", () => {
    class GraphWrapped extends Tag("GraphWrapped")<GraphWrapped, { readonly v: number }>() {}
    const Base = Layer.value(LoggerService, { log: () => {} });
    const Inner = Layer.factory(GraphWrapped, (ctx: Context<LoggerService>) => {
      void ctx.get(LoggerService);
      return { v: 1 };
    });
    const Stopped = Layer.onStop(
      Layer.onStart(Inner, (): Result<void, never> => Ok(undefined)),
      () => {},
    );
    // provideTo so both `walk` and `providedKeys` traverse the onStart/onStop wrappers.
    const root = Layer.provideTo(Stopped, Base);

    expect(Layer.describe(root)).toEqual({
      nodes: [
        { key: "GraphWrapped", kind: "factory" },
        { key: "LoggerService", kind: "value" },
      ],
      edges: [{ from: "GraphWrapped", to: "LoggerService", inferred: true }],
    });
  });

  it("renders DOT — inferred edges dashed, resources/collections boxed, opaque layers skipped", () => {
    class GraphConn extends Tag("GraphConn")<GraphConn, { readonly c: number }>() {}
    class GraphPlugins extends Tag("GraphPlugins")<GraphPlugins, readonly number[]>() {}

    const ResourceLive = Layer.acquireRelease(
      GraphConn,
      (): Result<{ readonly c: number }, never> => Ok({ c: 1 }),
      () => {},
    );
    const Plugins = Layer.collect(GraphPlugins, [Layer.member(GraphPlugins, () => 1)]);
    // a hand-built layer carries no `meta`, so it contributes nothing to the graph.
    const opaque = {
      build: () => Ok(Context.empty()).toAsync(),
    } as unknown as Layer<unknown, unknown, unknown>;

    const dot = Layer.toDot(Layer.merge(ResourceLive, Plugins, opaque));

    expect(dot).toBe(
      [
        `digraph "demesne" {`,
        `  "GraphConn" [shape=box, style=dashed];`,
        `  "GraphPlugins" [shape=box];`,
        `}`,
      ].join("\n"),
    );
  });
});

describe("error union at the edge", () => {
  it("a failing make resolves build to Err, and .match routes to the err arm", async () => {
    const ConfigLive = Layer.make(
      AppConfig,
      (): Result<ServiceOf<typeof AppConfig>, ConfigError> =>
        Err(new ConfigError({ reason: "DB_URL must be a postgres:// url" })),
    );
    const DatabaseLive = Layer.make(DatabaseService, (ctx: Context<AppConfig>) => {
      const { dbUrl } = ctx.get(AppConfig);
      return fromPromise(connectDb(dbUrl), () => new ConnectionError({ url: dbUrl }));
    });
    const DatabaseWired = Layer.provideTo(DatabaseLive, ConfigLive);

    const result = await Layer.build(DatabaseWired);

    expect(result.isErr()).toBe(true);

    const message = result.match({
      ok: () => "ok",
      err: (e) => (e._tag === "ConfigError" ? `config:${e.reason}` : `db:${e.url}`),
      defect: (cause) => `panic:${String(cause)}`,
    });
    expect(message).toBe("config:DB_URL must be a postgres:// url");

    // the err payload is the expected TaggedError, asserted as one shape.
    expect(result.unwrapErr()).toEqual(
      expect.objectContaining({ _tag: "ConfigError", reason: "DB_URL must be a postgres:// url" }),
    );
  });
});

describe("parallel merge", () => {
  it("builds independent layers concurrently (interleaved by timing)", async () => {
    const order: string[] = [];

    const Slow = Layer.make(LoggerService, () =>
      fromSafePromise(async () => {
        order.push("slow:start");
        await delay(25);
        order.push("slow:end");
        return { log: () => {} };
      }),
    );
    const Fast = Layer.make(AppConfig, () =>
      fromSafePromise(async () => {
        order.push("fast:start");
        await delay(5);
        order.push("fast:end");
        return { dbUrl: "postgres://localhost/app" };
      }),
    );

    const result = await Layer.build(Layer.merge(Slow, Fast));

    expect(result.isOk()).toBe(true);
    // The fast layer starts before the slow one ends → genuine concurrency,
    // and finishes first → interleave, not sequential execution.
    expect(order).toEqual(["slow:start", "fast:start", "fast:end", "slow:end"]);
  });

  it("merges more than two layers in one call, unioning every channel", async () => {
    const built: string[] = [];
    const A = Layer.make(LoggerService, (): Result<ServiceOf<typeof LoggerService>, never> => {
      built.push("A");
      return Ok({ log: () => {} });
    });
    const B = Layer.make(AppConfig, (): Result<ServiceOf<typeof AppConfig>, never> => {
      built.push("B");
      return Ok({ dbUrl: "postgres://localhost/app" });
    });
    const C = Layer.make(Marker, (): Result<ServiceOf<typeof Marker>, never> => {
      built.push("C");
      return Ok({ ok: true });
    });

    const result = await Layer.build(Layer.merge(A, B, C));

    expect(result.isOk()).toBe(true);
    const ctx = result.unwrap();
    // Every layer's service is present in the merged Context.
    ctx.get(LoggerService).log("hi");
    expect(ctx.get(AppConfig).dbUrl).toBe("postgres://localhost/app");
    expect(ctx.get(Marker).ok).toBe(true);
    expect([...built].sort()).toEqual(["A", "B", "C"]);
  });

  it("the first Err short-circuits the merge", async () => {
    const Good = Layer.value(LoggerService, { log: () => {} });
    const Bad = Layer.make(
      AppConfig,
      (): Result<ServiceOf<typeof AppConfig>, ConfigError> =>
        Err(new ConfigError({ reason: "nope" })),
    );

    const result = await Layer.build(Layer.merge(Good, Bad));

    expect(result.unwrapErr()).toBeInstanceOf(ConfigError);
  });

  it("with two failing layers, the FIRST LISTED error wins (fold order, not timing)", async () => {
    class OtherError extends TaggedError("OtherError")<{ n: number }> {}
    // Listed first, but resolves LAST — must still be the reported error.
    const SlowFirst = Layer.make(LoggerService, () =>
      fromSafePromise(delay(20)).flatMap(
        (): Result<ServiceOf<typeof LoggerService>, ConfigError> =>
          Err(new ConfigError({ reason: "first" })),
      ),
    );
    const FastSecond = Layer.make(
      AppConfig,
      (): Result<ServiceOf<typeof AppConfig>, OtherError> => Err(new OtherError({ n: 2 })),
    );

    const result = await Layer.build(Layer.merge(SlowFirst, FastSecond));

    const err = result.unwrapErr();
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).reason).toBe("first");
  });

  it("a Defect dominates a sibling Err in a merge", async () => {
    // The Err is listed first AND resolves first; the late throw still wins.
    const Bad = Layer.make(
      AppConfig,
      (): Result<ServiceOf<typeof AppConfig>, ConfigError> =>
        Err(new ConfigError({ reason: "modeled" })),
    );
    const Boom = Layer.make(Marker, () =>
      fromSafePromise(delay(10)).map((): ServiceOf<typeof Marker> => {
        throw new Error("late boom");
      }),
    );

    const result = await Layer.build(Layer.merge(Bad, Boom));

    expect(result.isDefect()).toBe(true);
  });

  it("a thrown value inside construction becomes a Defect", async () => {
    const Good = Layer.value(LoggerService, { log: () => {} });
    const Boom = Layer.make(Marker, (): Result<ServiceOf<typeof Marker>, never> => {
      throw new Error("boom");
    });

    const result = await Layer.build(Layer.merge(Good, Boom));

    expect(result.isDefect()).toBe(true);
  });

  it("a throw in a `factory` body becomes a Defect (not an escaped exception)", async () => {
    const Boom = Layer.factory(Marker, (): ServiceOf<typeof Marker> => {
      throw new Error("factory boom");
    });

    // Must RESOLVE to a Defect — `Layer.build` must not reject/throw.
    const result = await Layer.build(Boom);

    expect(result.isDefect()).toBe(true);
  });

  it("a throw in a `member` body becomes a Defect", async () => {
    class Plugins extends Tag("DefectPlugins")<Plugins, readonly { readonly n: number }[]>() {}
    const Boom = Layer.member(Plugins, (): { readonly n: number } => {
      throw new Error("member boom");
    });

    const result = await Layer.build(Layer.collect(Plugins, [Boom]));

    expect(result.isDefect()).toBe(true);
  });
});

describe("internals: defensive runtime guards", () => {
  it("get throws when a service is absent from the underlying map", async () => {
    const ctx = (await Layer.build(Layer.value(LoggerService, { log: () => {} }))).unwrap();
    // Reading a tag NOT in R is a COMPILE error; widen through `unknown` to
    // force the runtime guard (the type system normally makes this unreachable).
    const widened = ctx as unknown as Context<AppConfig>;
    expect(() => widened.get(AppConfig)).toThrow(/not found in context/);
  });

  it("the phantom _R variance marker is a no-op", async () => {
    const ctx = (await Layer.build(Layer.value(LoggerService, { log: () => {} }))).unwrap();
    const phantom = (ctx as unknown as { _R: (r: unknown) => void })._R;
    expect(phantom(undefined)).toBeUndefined();
  });

  it("warns when two distinct tags share an id (they would collide in the context)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      class DupA extends Tag("DuplicateIdGuard")<DupA, { readonly a: string }>() {}
      class DupB extends Tag("DuplicateIdGuard")<DupB, { readonly b: number }>() {}
      void DupA;
      void DupB;
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('duplicate Tag id "DuplicateIdGuard"'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("warns only ONCE per id, no matter how many times the id repeats", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      class DupA extends Tag("DuplicateIdOnce")<DupA, { readonly a: string }>() {}
      class DupB extends Tag("DuplicateIdOnce")<DupB, { readonly b: number }>() {}
      class DupC extends Tag("DuplicateIdOnce")<DupC, { readonly c: boolean }>() {}
      void DupA;
      void DupB;
      void DupC;
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("is silent when NODE_ENV=production (the guard is development-only)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    try {
      class DupA extends Tag("DuplicateIdProd")<DupA, { readonly a: string }>() {}
      class DupB extends Tag("DuplicateIdProd")<DupB, { readonly b: number }>() {}
      void DupA;
      void DupB;
      expect(warn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      warn.mockRestore();
    }
  });
});

describe("memoization: a shared layer constructs once per build", () => {
  // A layer referenced from two branches is built exactly ONCE: the build's memo
  // map keys layers by reference, so `Shared` is constructed a single time and the
  // resulting service is reused across branches.
  it("constructs a layer shared across two branches only once", async () => {
    let constructions = 0;

    const Shared = Layer.make(AppConfig, (): Result<ServiceOf<typeof AppConfig>, never> => {
      constructions += 1;
      return Ok({ dbUrl: "postgres://localhost/app" });
    });

    class ServiceA extends Tag("ServiceA")<ServiceA, { readonly a: string }>() {}
    class ServiceB extends Tag("ServiceB")<ServiceB, { readonly b: string }>() {}

    const UsesConfigA = Layer.factory(ServiceA, (ctx: Context<AppConfig>) => ({
      a: ctx.get(AppConfig).dbUrl,
    }));
    const UsesConfigB = Layer.factory(ServiceB, (ctx: Context<AppConfig>) => ({
      b: ctx.get(AppConfig).dbUrl,
    }));

    const BranchA = Layer.provideTo(UsesConfigA, Shared);
    const BranchB = Layer.provideTo(UsesConfigB, Shared);
    const App: Layer<ServiceA | ServiceB, never, never> = Layer.merge(BranchA, BranchB);

    const result = await Layer.build(App);

    expect(result.isOk()).toBe(true);
    expect(constructions).toBe(1);
  });

  it("rebuilds across separate Layer.build calls (memo is per build)", async () => {
    let constructions = 0;
    const Shared = Layer.make(AppConfig, (): Result<ServiceOf<typeof AppConfig>, never> => {
      constructions += 1;
      return Ok({ dbUrl: "postgres://localhost/app" });
    });

    await Layer.build(Shared);
    await Layer.build(Shared);

    expect(constructions).toBe(2);
  });
});

describe("scopes: acquireRelease + scoped", () => {
  type Pool = { readonly id: number };
  class PoolA extends Tag("PoolA")<PoolA, Pool>() {}
  class PoolB extends Tag("PoolB")<PoolB, Pool>() {}

  it("releases acquired resources in reverse order after `use`", async () => {
    const events: string[] = [];

    const A = Layer.acquireRelease(
      PoolA,
      (): Result<Pool, never> => {
        events.push("acquire:A");
        return Ok({ id: 1 });
      },
      (p) => {
        events.push(`release:A(${p.id})`);
      },
    );
    // B needs A, so A is acquired before B — and must be released AFTER B (LIFO).
    const B = Layer.acquireRelease(
      PoolB,
      (ctx: Context<PoolA>): Result<Pool, never> => {
        events.push(`acquire:B(sees ${ctx.get(PoolA).id})`);
        return Ok({ id: 2 });
      },
      (p) => {
        events.push(`release:B(${p.id})`);
      },
    );

    const app = Layer.provideTo(B, A);
    const out = await Layer.scoped(app, (ctx): Result<number, never> => {
      events.push("use");
      return Ok(ctx.get(PoolB).id);
    });

    expect(out.unwrap()).toBe(2);
    expect(events).toEqual([
      "acquire:A",
      "acquire:B(sees 1)",
      "use",
      "release:B(2)",
      "release:A(1)",
    ]);
  });

  it("releases resources even when `use` fails", async () => {
    const released: string[] = [];
    class Boom extends TaggedError("Boom")<{ why: string }> {}

    const A = Layer.acquireRelease(
      PoolA,
      (): Result<Pool, never> => Ok({ id: 1 }),
      () => {
        released.push("A");
      },
    );

    const out = await Layer.scoped(A, (): Result<number, Boom> => Err(new Boom({ why: "nope" })));

    expect(out.unwrapErr()).toBeInstanceOf(Boom);
    expect(released).toEqual(["A"]); // released despite the failure
  });

  it("releases resources acquired before a sibling BUILD failure (partial build)", async () => {
    const events: string[] = [];
    class BuildBoom extends TaggedError("BuildBoom")<{ why: string }> {}

    const A = Layer.acquireRelease(
      PoolA,
      (): Result<Pool, never> => {
        events.push("acquire:A");
        return Ok({ id: 1 });
      },
      () => {
        events.push("release:A");
      },
    );
    // Fails AFTER A's acquire has completed — the build errs partway through.
    const Failing = Layer.make(PoolB, () =>
      fromSafePromise(delay(10)).flatMap(
        (): Result<Pool, BuildBoom> => Err(new BuildBoom({ why: "db down" })),
      ),
    );

    const out = await Layer.scoped(
      Layer.merge(A, Failing),
      (): Result<string, never> => Ok("unreachable"),
    );

    expect(out.unwrapErr()).toBeInstanceOf(BuildBoom);
    // `use` never ran, yet the resource acquired before the failure was released.
    expect(events).toEqual(["acquire:A", "release:A"]);
  });

  it("`scoped` returns the `use` result and supports async use", async () => {
    const A = Layer.value(PoolA, { id: 7 });
    const out = await Layer.scoped(A, (ctx) =>
      fromSafePromise(Promise.resolve(`pool ${ctx.get(PoolA).id}`)),
    );
    expect(out.unwrap()).toBe("pool 7");
  });

  it("teardown is best-effort: a throwing release does not abort the rest", async () => {
    const released: string[] = [];
    const A = Layer.acquireRelease(
      PoolA,
      (): Result<Pool, never> => Ok({ id: 1 }),
      () => {
        released.push("A");
      },
    );
    const B = Layer.acquireRelease(
      PoolB,
      (_ctx: Context<PoolA>): Result<Pool, never> => Ok({ id: 2 }),
      () => {
        throw new Error("release B failed");
      },
    );
    // A is acquired first, so it is released LAST — after B's release throws.
    const out = await Layer.scoped(Layer.provideTo(B, A), (): Result<string, never> => Ok("done"));

    expect(out.unwrap()).toBe("done"); // the throwing release is swallowed
    expect(released).toEqual(["A"]); // A still released after B's release threw
  });
});

describe("Layer.forkScope: request / child scopes", () => {
  it("shares parent services and adds request-scoped ones", async () => {
    const appCtx = (await Layer.build(Layer.value(AppConfig, { dbUrl: "u" }))).unwrap();

    class ReqId extends Tag("ReqId")<ReqId, { readonly id: string }>() {}
    const RequestLayer = Layer.factory(ReqId, (ctx: Context<AppConfig>) => ({
      id: `req-${ctx.get(AppConfig).dbUrl}`,
    }));

    const out = await Layer.forkScope(
      appCtx,
      RequestLayer,
      (ctx): Result<string, never> => Ok(`${ctx.get(AppConfig).dbUrl}/${ctx.get(ReqId).id}`),
    );

    expect(out.unwrap()).toBe("u/req-u");
  });

  it("releases request-scoped resources after use, leaving the parent alive", async () => {
    const events: string[] = [];
    const appCtx = (await Layer.build(Layer.value(AppConfig, { dbUrl: "u" }))).unwrap();

    class Txn extends Tag("Txn")<Txn, { readonly n: number }>() {}
    const TxnLayer = Layer.acquireRelease(
      Txn,
      (ctx: Context<AppConfig>): Result<{ readonly n: number }, never> => {
        events.push(`open(${ctx.get(AppConfig).dbUrl})`);
        return Ok({ n: 1 });
      },
      () => {
        events.push("close");
      },
    );

    const out = await Layer.forkScope(appCtx, TxnLayer, (ctx): Result<number, never> => {
      events.push("use");
      return Ok(ctx.get(Txn).n);
    });

    expect(out.unwrap()).toBe(1);
    expect(events).toEqual(["open(u)", "use", "close"]);
    // the parent (its singletons) is untouched — still usable after the fork closed
    expect(appCtx.get(AppConfig).dbUrl).toBe("u");
  });

  it("builds fresh request-scoped services on each fork", async () => {
    let count = 0;
    const appCtx = (await Layer.build(Layer.value(AppConfig, { dbUrl: "u" }))).unwrap();

    class Seq extends Tag("Seq")<Seq, { readonly n: number }>() {}
    const RequestLayer = Layer.make(Seq, (): Result<{ readonly n: number }, never> => {
      count += 1;
      return Ok({ n: count });
    });

    const a = await Layer.forkScope(
      appCtx,
      RequestLayer,
      (ctx): Result<number, never> => Ok(ctx.get(Seq).n),
    );
    const b = await Layer.forkScope(
      appCtx,
      RequestLayer,
      (ctx): Result<number, never> => Ok(ctx.get(Seq).n),
    );

    expect(a.unwrap()).toBe(1);
    expect(b.unwrap()).toBe(2);
    expect(count).toBe(2);
  });

  it("releases multiple request resources in LIFO order", async () => {
    const events: string[] = [];
    const appCtx = (await Layer.build(Layer.value(AppConfig, { dbUrl: "u" }))).unwrap();

    class ReqA extends Tag("ForkReqA")<ReqA, { readonly n: number }>() {}
    class ReqB extends Tag("ForkReqB")<ReqB, { readonly n: number }>() {}
    const First = Layer.acquireRelease(
      ReqA,
      (): Result<{ readonly n: number }, never> => {
        events.push("acquire:A");
        return Ok({ n: 1 });
      },
      () => {
        events.push("release:A");
      },
    );
    // B needs A, so A is acquired first — and must be released AFTER B (LIFO).
    const Second = Layer.acquireRelease(
      ReqB,
      (ctx: Context<ReqA>): Result<{ readonly n: number }, never> => {
        events.push("acquire:B");
        return Ok({ n: ctx.get(ReqA).n + 1 });
      },
      () => {
        events.push("release:B");
      },
    );

    const out = await Layer.forkScope(
      appCtx,
      Layer.provideTo(Second, First),
      (ctx): Result<number, never> => {
        events.push("use");
        return Ok(ctx.get(ReqB).n);
      },
    );

    expect(out.unwrap()).toBe(2);
    expect(events).toEqual(["acquire:A", "acquire:B", "use", "release:B", "release:A"]);
  });

  it("releases request resources even when use fails", async () => {
    const released: string[] = [];
    const appCtx = (await Layer.build(Layer.value(AppConfig, { dbUrl: "u" }))).unwrap();

    class Txn extends Tag("Txn2")<Txn, { readonly n: number }>() {}
    class ForkBoom extends TaggedError("ForkBoom")<{ why: string }> {}
    const TxnLayer = Layer.acquireRelease(
      Txn,
      (): Result<{ readonly n: number }, never> => Ok({ n: 1 }),
      () => {
        released.push("txn");
      },
    );

    const out = await Layer.forkScope(
      appCtx,
      TxnLayer,
      (): Result<number, ForkBoom> => Err(new ForkBoom({ why: "nope" })),
    );

    expect(out.unwrapErr()).toBeInstanceOf(ForkBoom);
    expect(released).toEqual(["txn"]);
  });
});

describe("Layer.fromService: a fresh layer per call, singleton via a shared const", () => {
  it("each call mints a distinct layer; the shared reference is the singleton seam", async () => {
    let stamps = 0;
    class Stamp extends Service<Stamp>()("StampSvc", {}) {
      readonly n = (stamps += 1);
    }

    const l1 = Layer.fromService(Stamp);
    const l2 = Layer.fromService(Stamp);
    expect(l1).not.toBe(l2);

    // Two distinct references construct twice (the memo is keyed by reference)...
    const twice = await Layer.build(Layer.merge(l1, l2));
    expect(twice.isOk()).toBe(true);
    expect(stamps).toBe(2);

    // ...while one reference reused across branches constructs once.
    stamps = 0;
    const once = await Layer.build(Layer.merge(l1, l1));
    expect(once.isOk()).toBe(true);
    expect(stamps).toBe(1);
  });
});

describe("Layer.member + Layer.collect: multi-bindings / plugin collections", () => {
  type Plugin = { readonly name: string; readonly weight: number };
  class Plugins extends Tag("Plugins")<Plugins, readonly Plugin[]>() {}

  it("collects members into one array, in listed order", async () => {
    const A = Layer.member(Plugins, () => ({ name: "a", weight: 1 }));
    const B = Layer.member(Plugins, () => ({ name: "b", weight: 2 }));
    const C = Layer.member(Plugins, () => ({ name: "c", weight: 3 }));

    const ctx = (await Layer.build(Layer.collect(Plugins, [A, B, C]))).unwrap();
    const plugins = ctx.get(Plugins);

    expect(plugins).toEqual([
      { name: "a", weight: 1 },
      { name: "b", weight: 2 },
      { name: "c", weight: 3 },
    ]);
  });

  it("threads each member's own requirements, discharged with provideTo", async () => {
    class Config extends Tag("MbConfig")<Config, { readonly env: string }>() {}
    const Auth = Layer.member(Plugins, (c: Context<Config>) => ({
      name: `auth-${c.get(Config).env}`,
      weight: 1,
    }));
    const Metrics = Layer.member(Plugins, () => ({ name: "metrics", weight: 2 }));

    // the collection needs Config (its Auth member reads it) — feed it in with provideTo
    const App = Layer.provideTo(
      Layer.collect(Plugins, [Auth, Metrics]),
      Layer.value(Config, { env: "prod" }),
    );
    const ctx = (await Layer.build(App)).unwrap();

    expect(ctx.get(Plugins).map((p) => p.name)).toEqual(["auth-prod", "metrics"]);
  });

  it("mixes member with a make-based (fallible/async) contribution, flattening arrays", async () => {
    const A = Layer.member(Plugins, () => ({ name: "a", weight: 1 }));
    // a make contribution may add MORE than one item — collect flattens it
    const Pair = Layer.make(
      Plugins,
      (): Result<readonly Plugin[], never> =>
        Ok([
          { name: "b", weight: 2 },
          { name: "c", weight: 3 },
        ]),
    );

    const ctx = (await Layer.build(Layer.collect(Plugins, [A, Pair]))).unwrap();
    expect(ctx.get(Plugins).map((p) => p.name)).toEqual(["a", "b", "c"]);
  });

  it("yields an empty collection for no members", async () => {
    const ctx = (await Layer.build(Layer.collect(Plugins, []))).unwrap();
    expect(ctx.get(Plugins)).toEqual([]);
  });

  it("skips a member whose context lacks the collection key (defensive)", async () => {
    class Other extends Tag("MbOther")<Other, { readonly x: number }>() {}
    // a layer that provides a DIFFERENT tag, widened to satisfy collect's member type —
    // its output contributes nothing, exercising the defensive `arr === undefined` skip.
    const notAMember = Layer.value(Other, { x: 1 }) as unknown as Layer<Plugins, never, never>;

    const ctx = (await Layer.build(Layer.collect(Plugins, [notAMember]))).unwrap();
    expect(ctx.get(Plugins)).toEqual([]);
  });

  it("short-circuits on the first failing member", async () => {
    class MbBoom extends TaggedError("MbBoom")<{ why: string }> {}
    const A = Layer.member(Plugins, () => ({ name: "a", weight: 1 }));
    const Bad = Layer.make(
      Plugins,
      (): Result<readonly Plugin[], MbBoom> => Err(new MbBoom({ why: "nope" })),
    );

    const out = await Layer.build(Layer.collect(Plugins, [A, Bad]));
    expect(out.unwrapErr()).toBeInstanceOf(MbBoom);
  });
});

describe("Layer.onStart + Layer.onStop: lifecycle hooks", () => {
  class Config extends Tag("LcConfig")<Config, { readonly url: string }>() {}
  class Db extends Tag("LcDb")<Db, { readonly url: string }>() {}

  it("runs start hooks after construction, in dependency order, before use", async () => {
    const log: string[] = [];
    const ConfigLive = Layer.onStart(
      Layer.factory(Config, () => ({ url: "cfg" })),
      (): Result<void, never> => {
        log.push("start:config");
        return Ok(undefined);
      },
    );
    // Db depends on Config; its migrate hook must run AFTER config's start hook.
    const DbLive = Layer.onStart(
      Layer.factory(Db, (c: Context<Config>) => ({ url: `db(${c.get(Config).url})` })),
      (c: Context<Db>): Result<void, never> => {
        log.push(`start:migrate ${c.get(Db).url}`);
        return Ok(undefined);
      },
    );

    const out = await Layer.scoped(
      Layer.provideTo(DbLive, ConfigLive),
      (ctx): Result<string, never> => {
        log.push("use");
        return Ok(ctx.get(Db).url);
      },
    );

    expect(out.unwrap()).toBe("db(cfg)");
    expect(log).toEqual(["start:config", "start:migrate db(cfg)", "use"]);
  });

  it("runs start hooks under plain build too (scope-free graph)", async () => {
    const log: string[] = [];
    const ConfigLive = Layer.onStart(
      Layer.factory(Config, () => ({ url: "cfg" })),
      (): Result<void, never> => {
        log.push("warmup");
        return Ok(undefined);
      },
    );

    const ctx = (await Layer.build(ConfigLive)).unwrap();
    expect(ctx.get(Config).url).toBe("cfg");
    expect(log).toEqual(["warmup"]);
  });

  it("aborts startup on a failing hook before use, and unions its error into E", async () => {
    class MigrationError extends TaggedError("MigrationError")<{ why: string }> {}
    const DbLive = Layer.onStart(
      Layer.factory(Db, () => ({ url: "db" })),
      (): Result<void, MigrationError> => Err(new MigrationError({ why: "schema drift" })),
    );

    const out = await Layer.build(DbLive);
    // a failed start hook surfaces as the graph's Err (build has no `use` to reach).
    expect(out.unwrapErr()).toBeInstanceOf(MigrationError);
  });

  it("closes the scope even when a start hook fails (teardown still runs)", async () => {
    const log: string[] = [];
    class Boom extends TaggedError("LcBoom")<{ why: string }> {}
    const DbLive = Layer.onStop(
      Layer.onStart(
        Layer.factory(Db, () => ({ url: "db" })),
        (): Result<void, Boom> => {
          log.push("start:fail");
          return Err(new Boom({ why: "no" }));
        },
      ),
      () => {
        log.push("stop:db");
      },
    );

    const out = await Layer.scoped(DbLive, (): Result<string, never> => {
      log.push("use");
      return Ok("x");
    });

    expect(out.isErr()).toBe(true);
    expect(log).toEqual(["start:fail", "stop:db"]); // use skipped, teardown ran
  });

  it("onStop registers a teardown run in reverse order (LIFO) on scope close", async () => {
    const log: string[] = [];
    const A = Layer.onStop(Layer.value(Config, { url: "a" }), () => {
      log.push("stop:config");
    });
    const B = Layer.onStop(
      Layer.factory(Db, (c: Context<Config>) => ({ url: c.get(Config).url })),
      () => {
        log.push("stop:db");
      },
    );

    const out = await Layer.scoped(Layer.provideTo(B, A), (ctx): Result<string, never> => {
      log.push("use");
      return Ok(ctx.get(Db).url);
    });

    expect(out.unwrap()).toBe("a");
    // Config acquired before Db → teardown is LIFO: db first, then config.
    expect(log).toEqual(["use", "stop:db", "stop:config"]);
  });
});
