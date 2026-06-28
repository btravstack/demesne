// demesne — type-safe dependency injection.
//
// A demesne is the domain a lord holds in his own hands and provisions
// directly. So is this: a container holds your services' domain (a typed
// Context) and provides it. Requirements AND construction errors are tracked
// in the type system — you cannot build until every dependency is wired, and
// the set of possible wiring failures is a static union you handle once.
//
// No monad, no effect runtime of its own: construction builds to an `unthrown`
// AsyncResult, so failure and async are first-class while error handling stays
// delegated to unthrown. demesne only does the wiring.

import { Ok, allAsync, type Result, type AsyncResult } from "unthrown";

const TagTypeId = Symbol.for("mini-di/Tag");
const ContextTypeId = Symbol.for("mini-di/Context");

// ---------------------------------------------------------------------------
// Tag — a typed key. The class itself is the nominal identity that appears in
// the requirement union R; the second type parameter is the service shape.
//
//   class Logger extends Tag("Logger")<Logger, LoggerService>() {}
// ---------------------------------------------------------------------------
export interface Tag<Self, Service> {
  readonly [TagTypeId]: typeof TagTypeId;
  readonly key: string;
  readonly _Self: (_: never) => Self;
  readonly _Service: (_: never) => Service;
}

// Distinct instance type so `class X extends Tag(...)<X, S>() {}` is legal
// without the class referencing itself as a base type. The literal Id keeps
// instance types nominal, so two structurally identical services never merge.
export interface TagInstance<Id extends string, Service> {
  readonly [TagTypeId]: typeof TagTypeId;
  readonly _tagId: Id;
  readonly _tagService: (_: never) => Service;
}

export interface TagClass<Self, Id extends string, Service> extends Tag<Self, Service> {
  new (_: never): TagInstance<Id, Service>;
  readonly key: Id;
}

export const Tag =
  <const Id extends string>(id: Id) =>
  <Self, Service>(): TagClass<Self, Id, Service> => {
    const cls = class {
      static readonly [TagTypeId] = TagTypeId;
      static readonly key = id;
    };
    return cls as unknown as TagClass<Self, Id, Service>;
  };

// ---------------------------------------------------------------------------
// Context<R> — immutable map Tag -> Service. `get` only accepts a tag whose
// identity is in R (reading an absent service is a compile error). Contravariant
// in R: a Context<A | B> is usable wherever a Context<A> is expected.
// ---------------------------------------------------------------------------
export interface Context<in R> {
  readonly [ContextTypeId]: typeof ContextTypeId;
  readonly unsafeMap: ReadonlyMap<string, unknown>;
  readonly _R: (r: R) => void; // phantom, forces contravariance in R
  get<Self extends R, Service>(tag: Tag<Self, Service>): Service;
}

const makeContext = (map: ReadonlyMap<string, unknown>): Context<any> => ({
  [ContextTypeId]: ContextTypeId,
  unsafeMap: map,
  _R: () => {},
  get(tag) {
    if (!map.has(tag.key)) {
      throw new Error(`mini-di: service "${tag.key}" not found in context`);
    }
    return map.get(tag.key) as never;
  },
});

const emptyAny = (): Context<any> => makeContext(new Map());
export const empty = (): Context<never> => makeContext(new Map());

const unsafeAdd = (ctx: Context<any>, key: string, service: unknown): Context<any> =>
  makeContext(new Map(ctx.unsafeMap).set(key, service));

const mergeContext = (a: Context<any>, b: Context<any>): Context<any> =>
  makeContext(new Map([...a.unsafeMap, ...b.unsafeMap]));

// ---------------------------------------------------------------------------
// Layer<Provides, E, Needs> — a recipe that builds the services in `Provides`,
// possibly requiring `Needs` and possibly failing with `E`. Both channels
// accumulate as unions: `merge` widens them, `provideTo` subtracts from `Needs`
// (the Exclude<...> trick) while still unioning `E`. You can `build()` once
// `Needs` is `never`; the result is an AsyncResult carrying the union of every
// construction error the graph can produce.
// ---------------------------------------------------------------------------
export interface Layer<Provides, E = never, Needs = never> {
  // Property (not method) on purpose: method params are checked bivariantly,
  // which would let an un-wired Layer slip past. A property function type keeps
  // strict contravariance in `Needs`, so a missing dependency is a real error.
  readonly build: (ctx: Context<Needs>) => AsyncResult<Context<Provides>, E>;
}

// A layer from an already-constructed value. Needs nothing, cannot fail.
export const value = <Self, Service>(
  tag: Tag<Self, Service>,
  service: Service,
): Layer<Self, never, never> => ({
  build: () => Ok(unsafeAdd(emptyAny(), tag.key, service)).toAsync(),
});

// A layer built synchronously and infallibly from the context.
export const factory = <Self, Service, Needs = never>(
  tag: Tag<Self, Service>,
  f: (ctx: Context<Needs>) => Service,
): Layer<Self, never, Needs> => ({
  build: (ctx) => Ok(unsafeAdd(emptyAny(), tag.key, f(ctx))).toAsync(),
});

// A layer whose construction may FAIL and/or be ASYNC: the factory returns a
// Result or an AsyncResult, whose error type becomes the layer's `E`.
export const make = <Self, Service, E, Needs = never>(
  tag: Tag<Self, Service>,
  f: (ctx: Context<Needs>) => Result<Service, E> | AsyncResult<Service, E>,
): Layer<Self, E, Needs> => ({
  // `Ok(...).toAsync().flatMap(() => f(ctx))` uniformly lifts both a sync Result
  // and an AsyncResult into an AsyncResult — no runtime type sniffing.
  build: (ctx) =>
    Ok<void>(undefined)
      .toAsync()
      .flatMap(() => f(ctx))
      .map((service) => unsafeAdd(emptyAny(), tag.key, service)),
});

// Combine two independent layers. They build in PARALLEL (allAsync); the first
// Err short-circuits, a Defect dominates. Errors and requirements both union.
export const merge = <PA, EA, NA, PB, EB, NB>(
  a: Layer<PA, EA, NA>,
  b: Layer<PB, EB, NB>,
): Layer<PA | PB, EA | EB, NA | NB> => ({
  build: (ctx) =>
    allAsync([a.build(ctx as Context<any>), b.build(ctx as Context<any>)]).map(
      ([ca, cb]) => mergeContext(ca, cb),
    ),
});

// Feed `dep` into `self`, discharging the requirements `self` shares with what
// `dep` provides. `dep` builds first; on success `self` builds with the merged
// context. Errors union; remaining requirements: Exclude<N, P2> | N2.
export const provideTo = <P, E, N, P2, E2, N2>(
  self: Layer<P, E, N>,
  dep: Layer<P2, E2, N2>,
): Layer<P, E | E2, Exclude<N, P2> | N2> => ({
  build: (ctx) =>
    dep
      .build(ctx as Context<any>)
      .flatMap((depCtx) => self.build(mergeContext(ctx, depCtx) as Context<N>)),
});

// Build a fully-wired layer. Callable once Needs == never; the AsyncResult still
// carries `E`, since construction itself may fail — you handle it at the edge.
export const build = <P, E>(self: Layer<P, E, never>): AsyncResult<Context<P>, E> =>
  self.build(empty());
