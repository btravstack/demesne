// Adapter — a pooled database connection. `Database` is an infrastructure-only tag;
// `ConnectionError` surfaces in the wiring error union.

import { type Context, Layer, Tag } from "demesne";
import { fromPromise, TaggedError } from "unthrown";

import type { ServiceOf } from "../application/ports.js";
import { AppConfig } from "./config.js";

export class Database extends Tag("Database")<
  Database,
  {
    readonly query: (sql: string) => readonly unknown[];
  }
>() {}

export class ConnectionError extends TaggedError("ConnectionError")<{ url: string }> {}

// A real driver call: rejects unless the url is local. `ServiceOf<typeof Database>`
// recovers the port's shape by name — the one place the helper earns its keep.
const connectDb = (url: string): Promise<ServiceOf<typeof Database>> =>
  url.includes("localhost")
    ? Promise.resolve({ query: () => [] })
    : Promise.reject(new Error("connection refused"));

// Async + fallible; needs AppConfig. `fromPromise` qualifies the rejection.
export const DatabaseLive = Layer.make(Database, (ctx: Context<AppConfig>) => {
  const { dbUrl } = ctx.get(AppConfig);
  return fromPromise(connectDb(dbUrl), () => new ConnectionError({ url: dbUrl }));
});
