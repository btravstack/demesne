// Application — a use case. It declares the ports it needs in its Context<…>
// signature (requirements at the boundary, not inferred from usage) and orchestrates
// them. It never touches an adapter, a concrete class, or process.env.

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
