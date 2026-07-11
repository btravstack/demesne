// HTTP listener as a RESOURCE: acquire starts the Node server and resolves once it is
// actually listening (reporting the real port — PORT 0 works in tests); release closes
// it. Because it is an `acquireRelease`, the graph carries `Scope`: the listener can
// never leak past `Layer.scoped` — shutdown closes it in LIFO order with the database.

import { serve, type ServerType } from "@hono/node-server";
import { type Context, Layer, Tag } from "demesne";
import { fromPromise, TaggedError } from "unthrown";

import { Logger } from "../application/ports.js";
import { AppConfig } from "../config/env.js";
import { HttpApp } from "./routes.js";

export class HttpServer extends Tag("HttpServer")<
  HttpServer,
  { readonly port: number; readonly server: ServerType }
>() {}

export class ListenError extends TaggedError("@app/ListenError", { name: "ListenError" })<{
  cause: unknown;
}> {}

export const HttpServerLive = Layer.acquireRelease(
  HttpServer,
  (ctx: Context<HttpApp | AppConfig | Logger>) =>
    fromPromise(
      new Promise<{ readonly port: number; readonly server: ServerType }>((resolve, reject) => {
        const server = serve(
          { fetch: ctx.get(HttpApp).fetch, port: ctx.get(AppConfig).PORT },
          (info) => {
            ctx.get(Logger).info(`listening on http://localhost:${info.port}`);
            resolve({ port: info.port, server });
          },
        );
        server.once("error", reject); // e.g. EADDRINUSE → modeled ListenError
      }),
      (cause) => new ListenError({ cause }),
    ),
  ({ server }) =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Sever keep-alive sockets to avoid delay until keepAliveTimeout
      if ("closeAllConnections" in server) server.closeAllConnections();
    }),
);
