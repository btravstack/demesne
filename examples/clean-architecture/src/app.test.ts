// End-to-end tests for the assembled example. Repository doubles go in two ways — through
// the shared `bootstrap` with a fake, and by `Layer.override` on the assembled graph — and
// the app is also exercised via `forkScope` (a per-request scope) and `onStop` (teardown).

import { describe, expect, it } from "vitest";

import { type Context, Layer, Tag } from "demesne";
import { Ok, type Result } from "unthrown";

import { AppLayer, AppStarted } from "./app.js";
import { GetOrder } from "./application/get-order.js";
import { OrderRepository } from "./application/ports.js";
import { AuditSinks } from "./application/plugins.js";
import { bootstrap } from "./bootstrap.js";
import { type Order, OrderNotFound } from "./domain/order.js";

// A fake repository — same port, returns a fixed order, no database.
const fakeOrder = { id: "order-1", total: 999 } satisfies Order;
const FakeRepository = Layer.value(OrderRepository, { findById: () => Ok(fakeOrder).toAsync() });

describe("clean-architecture example", () => {
  it("collects every plugin from the built graph", async () => {
    const ctx = (await Layer.build(AppStarted)).unwrap();

    // the multi-binding collection accumulated both sinks, in listed order
    expect(ctx.get(AuditSinks).map((s) => s.name)).toEqual(["console", "in-memory"]);
  });

  it("runs the use case, surfacing the modeled domain error for a missing order", async () => {
    const ctx = (await Layer.build(AppStarted)).unwrap();

    // the stub database returns no rows, so the use case surfaces OrderNotFound
    expect((await ctx.get(GetOrder).execute("order-1")).unwrapErr()).toBeInstanceOf(OrderNotFound);
  });

  it("bootstraps the same app with a fake repository (no database)", async () => {
    // Go through the SAME bootstrap as main.ts, swapping only the repository.
    const ctx = (await Layer.build(bootstrap(FakeRepository))).unwrap();

    expect((await ctx.get(GetOrder).execute("order-1")).unwrap()).toEqual(fakeOrder);
  });

  it("override swaps the repository in the assembled app — deep, through the use case", async () => {
    // The alternative to re-bootstrapping: patch the already-assembled AppLayer. Deep — the
    // GetOrder interactor captured OrderRepository in its constructor, yet sees the fake.
    const ctx = (await Layer.build(Layer.override(AppLayer, [FakeRepository]))).unwrap();

    expect((await ctx.get(GetOrder).execute("order-1")).unwrap()).toEqual(fakeOrder);
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
