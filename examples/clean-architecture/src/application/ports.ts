// Ports — the boundaries the application speaks to, as tags (the class IS the tag;
// the shape is inlined). A port's own operations return unthrown results too.

import { Tag } from "demesne";
import { type AsyncResult } from "unthrown";

import type { Order, OrderNotFound } from "../domain/order.js";

export class Logger extends Tag("Logger")<
  Logger,
  {
    readonly log: (msg: string) => void;
  }
>() {}

export class OrderRepository extends Tag("OrderRepository")<
  OrderRepository,
  {
    readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
  }
>() {}
