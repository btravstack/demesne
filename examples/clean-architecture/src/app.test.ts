// End-to-end tests for the assembled example: they build the real graph and exercise the
// combinators the app relies on — the multi-binding collection, a deep test `override`, a
// per-request `forkScope`, and an `onStop` teardown under `scoped`.

import { describe, expect, it } from "vitest";

import { type Context, Layer, Tag } from "demesne";
import { Ok, type Result } from "unthrown";

import { AppLayer, AppStarted } from "./app.js";
import { GetOrder } from "./application/get-order.js";
import { OrderRepository } from "./application/ports.js";
import { AuditSinks } from "./application/plugins.js";
import type { Order } from "./domain/order.js";

describe("clean-architecture example", () => {
  it("builds the whole graph, runs the migration, and collects every plugin", async () => {
    const built = await Layer.build(AppStarted);

    expect(built.isOk()).toBe(true);
    const ctx = built.unwrap();

    // the multi-binding collection accumulated both sinks, in listed order
    expect(ctx.get(AuditSinks).map((s) => s.name)).toEqual(["console", "in-memory"]);

    // the stub database returns no rows, so the use case surfaces the modeled domain error
    const res = await ctx.get(GetOrder).execute("order-1");
    expect(res.isErr()).toBe(true);
  });

  it("override swaps the repository with a fake — deep, through the use case", async () => {
    const fake = { id: "order-1", total: 999 } satisfies Order;
    const FakeRepo = Layer.value(OrderRepository, { findById: () => Ok(fake).toAsync() });

    // AppLayer is a `Layer.wire` result, so it can be re-assembled with the patch.
    const TestApp = Layer.override(AppLayer, [FakeRepo]);
    const ctx = (await Layer.build(TestApp)).unwrap();

    // GetOrderInteractor captured OrderRepository in its constructor — the override is deep,
    // so it captured the FAKE, not the real repo.
    const res = await ctx.get(GetOrder).execute("order-1");
    expect(res.unwrap()).toEqual(fake);
  });

  it("forkScope layers a per-request scope on the built app", async () => {
    const app = (await Layer.build(AppLayer)).unwrap();

    class RequestId extends Tag("RequestId")<RequestId, { readonly id: string }>() {}
    const RequestLayer = Layer.factory(RequestId, () => ({ id: "req-42" }));

    const out = await Layer.forkScope(
      app,
      RequestLayer,
      (ctx): Result<string, never> =>
        // the fork sees the parent's services (GetOrder) PLUS the request-scoped RequestId
        Ok(`${ctx.get(RequestId).id}:${typeof ctx.get(GetOrder).execute}`),
    );

    expect(out.unwrap()).toBe("req-42:function");
  });

  it("onStop runs a teardown when the scope closes", async () => {
    const events: string[] = [];
    const Managed = Layer.onStop(AppLayer, () => {
      events.push("closed");
    });

    const out = await Layer.scoped(
      Managed,
      (ctx: Context<AuditSinks>): Result<number, never> => Ok(ctx.get(AuditSinks).length),
    );

    expect(out.unwrap()).toBe(2);
    expect(events).toEqual(["closed"]);
  });
});
