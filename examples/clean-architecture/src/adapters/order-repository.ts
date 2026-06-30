// Adapter — the OrderRepository port, backed by the Database. The factory is sync +
// infallible (it just assembles the repo); the repo's findById returns an AsyncResult
// carrying a modeled OrderNotFound.

import { type Context, Layer } from "demesne";
import { Err, Ok } from "unthrown";

import { type Order, OrderNotFound } from "../domain/order.js";
import { OrderRepository } from "../application/ports.js";
import { Database } from "./database.js";

export const OrderRepoLive = Layer.factory(OrderRepository, (ctx: Context<Database>) => {
  const db = ctx.get(Database);
  return {
    findById: (id) => {
      const row = db.query(`select * from orders where id = '${id}'`)[0] as Order | undefined;
      return (row ? Ok(row) : Err(new OrderNotFound({ id }))).toAsync();
    },
  };
});
