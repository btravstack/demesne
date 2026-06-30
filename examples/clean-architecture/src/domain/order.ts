// Domain — entities and domain errors. Pure TypeScript: no demesne, no I/O.

import { TaggedError } from "unthrown";

export type Order = { readonly id: string; readonly total: number };

// The order doesn't exist — a domain-level failure, modeled as a value.
export class OrderNotFound extends TaggedError("OrderNotFound")<{ id: string }> {}
