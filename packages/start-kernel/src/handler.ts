// The handler binding (design/btravstack-start-handler-binding.md). A bound handler is the
// transport edge, shaped like a demesne `factory`: it takes the validated contract input and the
// FORK context, dispatches to services the graph already built (the use case + any request-scoped
// logger/audit), and returns the use case's DOMAIN error union — untranslated. All three demesne
// use-case call conventions work because the author writes the call.
//
// Invariant B1 — no transport code in a handler; the mount's disposition map owns translation.
// Invariant B2 — a handler's requirements `R` are bounded by `App | request-scope provisions`,
//   enforced by `runHandler` typing `bound` as `BoundHandler<Parent | ReqP, …>` (a handler that
//   reads a service neither the parent nor the request layer provides is a compile error).

import { type Context, Layer, type Scope, type Tag } from "demesne";
import type { AsyncResult, Result } from "unthrown";

import { type Contract, type ContractError, parseInput } from "./contract.js";

export type BoundHandler<R, In, Out, E> = {
  readonly contract: Contract<In, Out>;
  readonly handle: (input: In, ctx: Context<R>) => Result<Out, E> | AsyncResult<Out, E>;
};

// The primitive: bind a contract to an edge that reads whatever it needs off the fork context.
const bind = <In, Out, E, R>(
  contract: Contract<In, Out>,
  handle: (input: In, ctx: Context<R>) => Result<Out, E> | AsyncResult<Out, E>,
): BoundHandler<R, In, Out, E> => ({ contract, handle });

// Sugar for the single-service edge — `bind` with `ctx.get(tag)` pre-applied. `R` becomes the
// tag's identity. Reach for the primitive `handler(...)` when the edge reads more than one service
// (e.g. also a request logger or an audit collection); this cannot express that, by design.
const bindUse = <In, Out, E, Self, Service>(
  contract: Contract<In, Out>,
  tag: Tag<Self, Service>,
  invoke: (service: Service, input: In) => Result<Out, E> | AsyncResult<Out, E>,
): BoundHandler<Self, In, Out, E> => bind(contract, (input, ctx) => invoke(ctx.get(tag), input));

export const handler = Object.assign(bind, { use: bindUse });

// --- disposition: the mount's total map from domain error → host-specific disposition ---------

// The literal tag(s) of a (union of) TaggedError(s); distributes over the union.
type TagOf<E> = E extends { readonly _tag: infer T extends string } ? T : never;

// A TOTAL map from every domain error tag to a host disposition `D` (an HTTP status, an ack
// decision, a Temporal retryability). Missing an arm is a compile error — the type-level analog of
// demesne's "build only when Needs is never": a host cannot be mounted with an undecided failure.
export type DispositionMap<E, D> = {
  readonly [K in TagOf<E>]: (error: Extract<E, { readonly _tag: K }>) => D;
};

// Runtime dispatch by `_tag`. The map is total by its type, so a miss is a programming error
// (a handler produced a tag outside its declared `E`) — surface it as a throw → Defect.
export const dispatch = <E extends { readonly _tag: string }, D>(
  map: DispositionMap<E, D>,
  error: E,
): D => {
  const fn = (map as unknown as Record<string, ((e: E) => D) | undefined>)[error._tag];
  if (fn === undefined) {
    throw new Error(
      `demesne/start: no disposition mapped for error tag ${JSON.stringify(error._tag)}`,
    );
  }
  return fn(error);
};

// --- runHandler: the reusable heart of every host's per-invocation `invoke` --------------------

// Open a fresh request scope off the already-built parent (fork = per request/message/activity —
// factor VI), validate the raw input against the contract, run the handler, then close ONLY the
// fork's scope (LIFO). Errors union: build error `RErr`, input `ContractError`, domain `E`. The
// host maps each to its transport disposition and settles the invocation.
export const runHandler = <Parent, ReqP, RErr, In, Out, E>(
  parent: Context<Parent>,
  requestLayer: Layer<ReqP, RErr, Parent | Scope>,
  bound: BoundHandler<Parent | ReqP, In, Out, E>,
  rawInput: unknown,
): AsyncResult<Out, RErr | ContractError | E> =>
  Layer.forkScope(parent, requestLayer, (forkCtx) =>
    parseInput(bound.contract, rawInput)
      .toAsync()
      .flatMap((input) => bound.handle(input, forkCtx)),
  );
