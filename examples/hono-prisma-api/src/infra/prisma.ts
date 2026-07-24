// Infrastructure — the Prisma client as a demesne resource. `acquireRelease` connects on
// build and registers `$disconnect` with the scope, so the connection is a tracked resource:
// the graph carries `Scope` in its requirements and can only be run with `Layer.scoped`
// (which closes the pool on shutdown). Prisma 7 uses a driver adapter (`@prisma/adapter-pg`)
// over `pg`, and the connection URL is passed to the client here, not baked into the schema.
// The client is `$extends`ed with `@unthrown/prisma` at construction, so what the container
// holds — and every consumer sees — is the extended client with the `try*` methods: each
// query returns an `AsyncResult` whose error channel is the P-codes that operation can hit.

import { PrismaPg } from "@prisma/adapter-pg";
import { unthrownPrisma } from "@unthrown/prisma";
import { type Context, Layer, Tag } from "demesne";
import { fromPromise, TaggedError } from "unthrown";

import { AppConfig } from "../config/env.js";
import { PrismaClient } from "../generated/prisma/client.ts";

const makeClient = (connectionString: string) =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString }) }).$extends(unthrownPrisma);

export class Database extends Tag("Database")<Database, ReturnType<typeof makeClient>>() {}

export class ConnectionError extends TaggedError("@app/ConnectionError", {
  name: "ConnectionError",
})<{
  cause: unknown;
}> {}

// Needs `AppConfig` (for the URL); async + fallible (the connect may reject). `fromPromise`
// qualifies the rejection into a modeled `ConnectionError`.
export const DatabaseLive = Layer.acquireRelease(
  Database,
  (ctx: Context<AppConfig>) => {
    const client = makeClient(ctx.get(AppConfig).DATABASE_URL);
    return fromPromise(
      client.$connect().then(() => client),
      (cause) => new ConnectionError({ cause }),
    );
  },
  (client) => client.$disconnect(), // released (LIFO) when the scope closes
);
