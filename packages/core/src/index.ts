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

import { Ok, allAsync, fromSafePromise, type Result, type AsyncResult } from "unthrown";

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

// Recover a tag's service shape. The tag type is the nominal identity that appears
// in `R` — deliberately NOT the service — so a signature that needs the shape by
// name (a constructor parameter, a port type) recovers it here. Accepts either the
// tag instance type (`ServiceOf<Logger>`) or the tag value's type
// (`ServiceOf<typeof Logger>`).
export type ServiceOf<T> = T extends Tag<unknown, infer S>
  ? S
  : T extends TagInstance<string, infer S>
    ? S
    : never;

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
const empty = (): Context<never> => makeContext(new Map());

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
  // The `Scope` (memoization + finalizers) is threaded through every build.
  readonly build: (ctx: Context<Needs>, scope: Scope) => AsyncResult<Context<Provides>, E>;
}

// ---------------------------------------------------------------------------
// Scope — the per-build runtime state, threaded through every `build`:
//   • memoMap : each layer constructs ONCE per build. Combinators look a child
//     up by reference before building it, so a layer shared across branches is
//     constructed a single time (and the in-flight AsyncResult is shared).
//   • finalizers : release thunks registered by `acquireRelease`, run in reverse
//     acquisition order (LIFO) when the scope closes — see `scoped`.
// ---------------------------------------------------------------------------
interface Scope {
  readonly memoMap: Map<Layer<any, any, any>, AsyncResult<Context<any>, any>>;
  readonly finalizers: (() => Promise<void>)[];
}

const makeScope = (): Scope => ({ memoMap: new Map(), finalizers: [] });

// Build a layer at most once per scope, keyed by layer reference. Storing the
// in-flight AsyncResult (not the resolved Context) means concurrent branches that
// share a layer reuse the same construction instead of building it twice.
const buildMemo = <P, E, N>(
  layer: Layer<P, E, N>,
  ctx: Context<N>,
  scope: Scope,
): AsyncResult<Context<P>, E> => {
  const cached = scope.memoMap.get(layer);
  if (cached !== undefined) return cached as AsyncResult<Context<P>, E>;
  const result = layer.build(ctx, scope);
  scope.memoMap.set(layer, result);
  return result;
};

// Run a scope's finalizers in reverse acquisition order (LIFO). Teardown is
// best-effort: a release that throws does not abort the rest.
const closeScope = async (scope: Scope): Promise<void> => {
  for (const finalizer of [...scope.finalizers].reverse()) {
    try {
      await finalizer();
    } catch {
      // release functions are expected to be infallible; swallow to finish teardown.
    }
  }
};

// A layer from an already-constructed value. Needs nothing, cannot fail.
const value = <Self, Service>(
  tag: Tag<Self, Service>,
  service: Service,
): Layer<Self, never, never> => ({
  build: () => Ok(unsafeAdd(emptyAny(), tag.key, service)).toAsync(),
});

// A layer built synchronously and infallibly from the context.
const factory = <Self, Service, Needs = never>(
  tag: Tag<Self, Service>,
  f: (ctx: Context<Needs>) => Service,
): Layer<Self, never, Needs> => ({
  build: (ctx) => Ok(unsafeAdd(emptyAny(), tag.key, f(ctx))).toAsync(),
});

// A layer whose construction may FAIL and/or be ASYNC: the factory returns a
// Result or an AsyncResult, whose error type becomes the layer's `E`.
const make = <Self, Service, E, Needs = never>(
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

// A layer that ACQUIRES a resource and registers its RELEASE with the scope.
// Releases run in reverse acquisition order when the scope closes. `release` is
// expected to be infallible. Consume acquireRelease layers with `Layer.scoped`,
// which closes the scope — `Layer.build` never does, so its finalizers never run.
const acquireRelease = <Self, Service, E, Needs = never>(
  tag: Tag<Self, Service>,
  acquire: (ctx: Context<Needs>) => Result<Service, E> | AsyncResult<Service, E>,
  release: (service: Service) => void | Promise<void>,
): Layer<Self, E, Needs> => ({
  build: (ctx, scope) =>
    Ok<void>(undefined)
      .toAsync()
      .flatMap(() => acquire(ctx))
      .map((service) => {
        scope.finalizers.push(async () => {
          await release(service);
        });
        return unsafeAdd(emptyAny(), tag.key, service);
      }),
});

// Distribute over a union of layers to collect each channel as a union. Naked
// type parameters, so applying them to `Ls[number]` distributes over the tuple.
type ProvidesOf<L> = L extends Layer<infer P, any, any> ? P : never;
type ErrorOf<L> = L extends Layer<any, infer E, any> ? E : never;
type NeedsOf<L> = L extends Layer<any, any, infer N> ? N : never;

// Combine any number of independent layers (at least one). They build in PARALLEL
// (allAsync); the first Err short-circuits, a Defect dominates. Provides, errors,
// and requirements all union across every layer. Shared layers build once (memoized).
const merge = <Ls extends readonly [Layer<any, any, any>, ...Layer<any, any, any>[]]>(
  ...layers: Ls
): Layer<ProvidesOf<Ls[number]>, ErrorOf<Ls[number]>, NeedsOf<Ls[number]>> => ({
  build: (ctx, scope) =>
    allAsync(
      (layers as readonly Layer<any, any, any>[]).map((layer) =>
        buildMemo(layer, ctx as Context<any>, scope),
      ),
    ).map((contexts) =>
      (contexts as Context<any>[]).reduce((merged, c) => mergeContext(merged, c), emptyAny()),
    ),
});

// Feed `dep` into `self`, discharging the requirements `self` shares with what
// `dep` provides. `dep` builds first; on success `self` builds with the merged
// context. Errors union; remaining requirements: Exclude<N, P2> | N2.
const provideTo = <P, E, N, P2, E2, N2>(
  self: Layer<P, E, N>,
  dep: Layer<P2, E2, N2>,
): Layer<P, E | E2, Exclude<N, P2> | N2> => ({
  build: (ctx, scope) =>
    buildMemo(dep, ctx as Context<any>, scope).flatMap((depCtx) =>
      buildMemo(self, mergeContext(ctx, depCtx) as Context<N>, scope),
    ),
});

// Build a fully-wired layer. Callable once Needs == never; the AsyncResult still
// carries `E`, since construction itself may fail — you handle it at the edge.
// Shared layers construct once. NOTE: `build` does not close the scope, so any
// `acquireRelease` finalizers never run — use `scoped` for resource layers.
const build = <P, E>(self: Layer<P, E, never>): AsyncResult<Context<P>, E> =>
  buildMemo(self, empty(), makeScope());

// Build a fully-wired layer, run `use` with the resulting Context, then CLOSE the
// scope — releasing every acquired resource in reverse order, whether `use`
// succeeded, failed, or the build itself failed partway. The bracket that makes
// `acquireRelease` safe.
const scoped = <P, E, A, E2>(
  self: Layer<P, E, never>,
  use: (ctx: Context<P>) => Result<A, E2> | AsyncResult<A, E2>,
): AsyncResult<A, E | E2> => {
  const scope = makeScope();
  return fromSafePromise(
    (async (): Promise<Result<A, E | E2>> => {
      const result = await buildMemo(self, empty(), scope).flatMap((ctx) => use(ctx));
      await closeScope(scope);
      return result;
    })(),
  ).flatMap((result) => result.toAsync());
};

// ---------------------------------------------------------------------------
// Public surface, grouped so a reader can tell a Context operation from a Layer
// one at a glance. `Tag` stays top-level — it names a service, building neither.
// `Context` and `Layer` are each BOTH a type (above) and a value namespace here
// (the companion-object pattern): `Context<R>` / `Context.empty()`,
// `Layer<P, E, N>` / `Layer.make(...)`.
// ---------------------------------------------------------------------------

// Context constructors. (Reading a service is the instance method `ctx.get(tag)`.)
export const Context = { empty };

// Layer constructors (`value` / `factory` / `make` / `acquireRelease`), combinators
// (`merge` / `provideTo`), and the terminals `build` / `scoped`.
export const Layer = { value, factory, make, acquireRelease, merge, provideTo, build, scoped };
