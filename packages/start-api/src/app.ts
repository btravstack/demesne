// The HTTP host: serve demesne-wired contracts over a Hono app, driving each request through the
// kernel's `runHandler` (fork the request scope → validate input → dispatch to the handler) and
// translating the outcome to an HTTP response. Domain errors are mapped by the route's total
// `DispositionMap` (invariant B1 — no status code inside a handler); the kernel's `ContractError`
// becomes a fixed 400, and anything unmapped (a request-scope build error, an unexpected tag) a
// 500. This package contains only transport glue — all DI / lifecycle / validation / dispatch
// logic lives in the kernel.

import {
  type BoundHandler,
  ContractError,
  dispatch,
  type DispositionMap,
  runHandler,
} from "@btravstack/start-kernel";
import { type Context, Layer, type Scope, Tag } from "demesne";
import { type Context as HonoContext, Hono } from "hono";

import type { ApiDisposition } from "./disposition.js";

// The Hono app is itself a demesne service — the fork parent for every request's scope.
export class HttpApp extends Tag("@btravstack/start-api/HttpApp")<HttpApp, Hono>() {}

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteSpec<Parent, ReqP, In, Out, E extends { readonly _tag: string }> = {
  readonly method: ApiMethod;
  readonly path: string;
  readonly handler: BoundHandler<Parent | ReqP, In, Out, E>;
  readonly errors: DispositionMap<E, ApiDisposition>;
};

export type HttpAppBuilder<Parent, ReqP, RErr> = {
  readonly route: <In, Out, E extends { readonly _tag: string }>(
    spec: RouteSpec<Parent, ReqP, In, Out, E>,
  ) => HttpAppBuilder<Parent, ReqP, RErr>;
  readonly build: () => Layer<HttpApp, never, Parent>;
};

type Registration<Parent> = (app: Hono, ctx: Context<Parent>) => void;

const jsonResponse = (c: HonoContext, body: unknown, status: ApiDisposition["status"]): Response =>
  c.body(JSON.stringify(body), status, { "content-type": "application/json" });

// Build the contract input from the request: path params always apply (authoritative), plus the
// query string for GET/HEAD or the JSON body otherwise. zod then validates the merged object.
const readInput = async (c: HonoContext): Promise<unknown> => {
  const params = c.req.param();
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    return { ...c.req.query(), ...params };
  }
  const body: unknown = await c.req.json().catch(() => ({}));
  return body !== null && typeof body === "object" ? { ...body, ...params } : params;
};

// `createHttpApp<AppServices>()(requestLayer)` — Parent is declared explicitly (the app's provided
// services), ReqP/RErr infer from the request layer. Curried like demesne's `Service<Self>()(…)`
// because a request layer that needs nothing from the parent can't pin Parent by inference.
export const createHttpApp =
  <Parent>() =>
  <ReqP, RErr>(
    requestLayer: Layer<ReqP, RErr, Parent | Scope>,
  ): HttpAppBuilder<Parent, ReqP, RErr> => {
    const registrations: Registration<Parent>[] = [];

    const builder: HttpAppBuilder<Parent, ReqP, RErr> = {
      route: (spec) => {
        registrations.push((app, ctx) => {
          app.on(spec.method, spec.path, async (c) => {
            const raw = await readInput(c);
            const result = await runHandler(ctx, requestLayer, spec.handler, raw);
            return result.match({
              ok: (out) => jsonResponse(c, out, 200),
              err: (error) => {
                if (error instanceof ContractError) {
                  return jsonResponse(c, { error: "invalid input", issues: error.issues }, 400);
                }
                // Domain errors are mapped by the route's total map; a build error `RErr` or an
                // unmapped tag is an internal failure.
                const tagged = error as { readonly _tag: string };
                if (tagged._tag in spec.errors) {
                  // The route's `E` is not nameable inside this non-generic method; widen the map
                  // to its erased shape (membership is already checked, so dispatch won't throw).
                  const disposition = dispatch(
                    spec.errors as unknown as DispositionMap<
                      { readonly _tag: string },
                      ApiDisposition
                    >,
                    tagged,
                  );
                  return jsonResponse(c, disposition.body, disposition.status);
                }
                return jsonResponse(c, { error: "internal error" }, 500);
              },
              defect: () => jsonResponse(c, { error: "internal error" }, 500),
            });
          });
        });
        return builder;
      },
      build: () =>
        Layer.factory(HttpApp, (ctx: Context<Parent>) => {
          const app = new Hono();
          for (const register of registrations) register(app, ctx);
          return app;
        }),
    };

    return builder;
  };
