// Application — a use case, wired by demesne. The implementation is a class with
// constructor-injected ports and a single public `execute` method; it uses no demesne
// types. A `Layer.factory` performs the constructor injection, so the use case joins
// the typed graph: `Layer.build` won't compile until its ports are wired.

import { type Context, Layer, type ServiceOf, Tag } from "demesne";
import { type AsyncResult } from "unthrown";

import type { Order, OrderNotFound } from "../domain/order.js";
import { Logger, OrderRepository } from "./ports.js";

// The use case logic — constructor DI, one public method, framework-agnostic.
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

// The application layer: constructor injection performed inside a factory. demesne
// type-checks that Logger and OrderRepository are wired before this can build.
export const GetOrderLive = Layer.factory(
  GetOrder,
  (ctx: Context<Logger | OrderRepository>) =>
    new GetOrderInteractor(ctx.get(Logger), ctx.get(OrderRepository)),
);
