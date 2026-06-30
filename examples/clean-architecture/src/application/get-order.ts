// Application — a use case. Dependencies are injected through the constructor; its only
// public method is `execute`. The use case never sees the DI container — no Context, no
// Layer, no demesne import. Its signature says exactly what it asks for (an order id)
// and what it returns. The composition root resolves the ports and constructs it.

import { type AsyncResult } from "unthrown";

import type { Order, OrderNotFound } from "../domain/order.js";
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
