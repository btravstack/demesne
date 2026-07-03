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

// Shared phantom `_R` no-op — the variance marker never runs; one instance so both
// context factories reference the same function.
const noopR = (): void => {};

const makeContext = (map: ReadonlyMap<string, unknown>): Context<any> => ({
  [ContextTypeId]: ContextTypeId,
  unsafeMap: map,
  _R: noopR,
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

// Thrown by the probe context `wire` builds against while it discovers a build order:
// a layer that reads a not-yet-constructed dependency signals "not ready" (so `wire`
// defers it to a later round) rather than failing. Distinct from a genuine bug.
class MissingDependency extends Error {}

const makeProbeContext = (map: ReadonlyMap<string, unknown>): Context<any> => ({
  [ContextTypeId]: ContextTypeId,
  unsafeMap: map,
  _R: noopR,
  get(tag) {
    if (!map.has(tag.key)) {
      throw new MissingDependency(tag.key);
    }
    return map.get(tag.key) as never;
  },
});

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
  // The `BuildState` (memoization + finalizers) is threaded through every build.
  readonly build: (ctx: Context<Needs>, state: BuildState) => AsyncResult<Context<Provides>, E>;
}

// ---------------------------------------------------------------------------
// Scope — a phantom requirement tracked in the `Needs` channel (à la Effect's
// `Scope` in `R`). `acquireRelease` adds it, so any graph containing a resource
// layer carries `Scope` in `Needs`, and `merge` / `provideTo` propagate it. Since
// `build` requires `Needs = never`, it REJECTS a scope-needing graph at compile
// time; only `scoped` — which closes the scope — discharges it. Never has a value.
// ---------------------------------------------------------------------------
declare const ScopeTypeId: unique symbol;
export interface Scope {
  readonly [ScopeTypeId]: typeof ScopeTypeId;
}

// ---------------------------------------------------------------------------
// BuildState — the per-build runtime state, threaded through every `build`:
//   • memoMap : each layer constructs ONCE per build. Combinators look a child
//     up by reference before building it, so a layer shared across branches is
//     constructed a single time (and the in-flight AsyncResult is shared).
//   • finalizers : release thunks registered by `acquireRelease` / `onStop`, run in
//     reverse acquisition order (LIFO) when the scope closes — see `scoped`.
//   • startHooks : post-build thunks registered by `onStart`, run in acquisition order
//     (FIFO — i.e. dependency order, since a dependent builds after its deps) once the
//     whole graph is constructed, before `use` — see `runStartHooks`.
// ---------------------------------------------------------------------------
interface BuildState {
  readonly memoMap: Map<Layer<any, any, any>, AsyncResult<Context<any>, any>>;
  readonly finalizers: (() => Promise<void>)[];
  readonly startHooks: (() => AsyncResult<void, any>)[];
}

const makeBuildState = (): BuildState => ({
  memoMap: new Map(),
  finalizers: [],
  startHooks: [],
});

// Build a layer at most once per scope, keyed by layer reference. Storing the
// in-flight AsyncResult (not the resolved Context) means concurrent branches that
// share a layer reuse the same construction instead of building it twice.
const buildMemo = <P, E, N>(
  layer: Layer<P, E, N>,
  ctx: Context<N>,
  state: BuildState,
): AsyncResult<Context<P>, E> => {
  const cached = state.memoMap.get(layer);
  if (cached !== undefined) return cached as AsyncResult<Context<P>, E>;
  const result = layer.build(ctx, state);
  state.memoMap.set(layer, result);
  // Self-heal for `wire` / `override` resolution: a `MissingDependency` Defect means the
  // layer was built in a deferral round before its deps existed. Evict the cached failure
  // so a later round rebuilds it against a fuller context — otherwise the poisoned entry
  // would make the layer defer forever and `wire` would report a false "dependency cycle".
  // (Outside wire/override no `MissingDependency` ever occurs, so this is inert there.)
  result.tapDefect((cause) => {
    if (cause instanceof MissingDependency && state.memoMap.get(layer) === result) {
      state.memoMap.delete(layer);
    }
  });
  return result;
};

// Run a scope's finalizers in reverse acquisition order (LIFO). Teardown is
// best-effort: a release that throws does not abort the rest.
const closeScope = async (state: BuildState): Promise<void> => {
  for (const finalizer of [...state.finalizers].reverse()) {
    try {
      await finalizer();
    } catch {
      // release functions are expected to be infallible; swallow to finish teardown.
    }
  }
};

// Run the graph's start hooks in registration order (FIFO = dependency order), SEQUENTIALLY
// — a migration/warmup runs only after the ones it may depend on. Unlike teardown, a start
// hook is fallible: the FIRST Err short-circuits (its error is already unioned into the
// graph's `E` by `onStart`), so a failed migration aborts startup before `use`.
const runStartHooks = (state: BuildState): AsyncResult<void, any> =>
  state.startHooks.reduce<AsyncResult<void, any>>(
    (acc, hook) => acc.flatMap(() => hook()),
    Ok<void>(undefined).toAsync(),
  );

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

// A layer that ACQUIRES a resource and registers its RELEASE with the scope. It
// carries `Scope` in its `Needs`, so `build` rejects any graph containing it — the
// graph must be consumed with `scoped`, which closes the scope (releases run in
// reverse acquisition order). `release` is expected to be infallible.
const acquireRelease = <Self, Service, E, Needs = never>(
  tag: Tag<Self, Service>,
  acquire: (ctx: Context<Needs>) => Result<Service, E> | AsyncResult<Service, E>,
  release: (service: Service) => void | Promise<void>,
): Layer<Self, E, Needs | Scope> => ({
  build: (ctx, state) =>
    Ok<void>(undefined)
      .toAsync()
      .flatMap(() => acquire(ctx as Context<Needs>))
      .map((service) => {
        state.finalizers.push(async () => {
          await release(service);
        });
        return unsafeAdd(emptyAny(), tag.key, service);
      }),
});

// Attach a START hook to a layer: a post-construction step (a migration, a warmup, a
// health gate) run AFTER the whole graph is built, before `use`, in dependency order. The
// hook sees the layer's provided `Context<P>` and returns a `Result`/`AsyncResult` — a
// fallible step, whose error unions into the layer's `E` (a failed hook aborts startup). It
// runs at the terminal (`build` / `scoped` / `forkScope`), not when the layer constructs.
const onStart = <L extends Layer<any, any, any>, E2>(
  layer: L,
  hook: (ctx: Context<ProvidesOf<L>>) => Result<void, E2> | AsyncResult<void, E2>,
): Layer<ProvidesOf<L>, ErrorOf<L> | E2, NeedsOf<L>> => ({
  build: (ctx, state) =>
    buildMemo(layer, ctx as Context<any>, state).map((provided) => {
      state.startHooks.push(() =>
        Ok<void>(undefined)
          .toAsync()
          .flatMap(() => hook(provided as Context<any>)),
      );
      return provided;
    }),
});

// Attach a STOP hook to a layer: a teardown for an already-provided service (a graceful
// shutdown, a flush) that isn't itself a resource. It registers a finalizer with the scope
// — run in reverse order (LIFO) when the scope closes — so, like `acquireRelease`, it adds
// `Scope` to `Needs`: the graph must be consumed with `scoped`. The hook is infallible,
// mirroring `release`. (`onStop` is the counterpart to `acquireRelease`'s release for a
// service the layer did not itself acquire.)
const onStop = <L extends Layer<any, any, any>>(
  layer: L,
  hook: (ctx: Context<ProvidesOf<L>>) => void | Promise<void>,
): Layer<ProvidesOf<L>, ErrorOf<L>, NeedsOf<L> | Scope> => ({
  build: (ctx, state) =>
    buildMemo(layer, ctx as Context<any>, state).map((provided) => {
      state.finalizers.push(async () => {
        await hook(provided as Context<any>);
      });
      return provided;
    }),
});

// A single contribution to a COLLECTION tag — a tag whose service is a `readonly Item[]`.
// Mirrors `factory` (built synchronously and infallibly from the context): it provides the
// collection tag with a ONE-element array, which `collect` concatenates with the other
// members. For a fallible / async contribution, use `Layer.make` returning a one-element
// array instead; the constructor family stays distinct by qualification.
const member = <Self, Item, Needs = never>(
  collectionTag: Tag<Self, readonly Item[]>,
  f: (ctx: Context<Needs>) => Item,
): Layer<Self, never, Needs> => ({
  build: (ctx) =>
    Ok(unsafeAdd(emptyAny(), collectionTag.key, [f(ctx)] as readonly Item[])).toAsync(),
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
  build: (ctx, state) =>
    allAsync(
      (layers as readonly Layer<any, any, any>[]).map((layer) =>
        buildMemo(layer, ctx as Context<any>, state),
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
  build: (ctx, state) =>
    buildMemo(dep, ctx as Context<any>, state).flatMap((depCtx) =>
      buildMemo(self, mergeContext(ctx, depCtx) as Context<N>, state),
    ),
});

// Resolve a set of layers by repeatedly building those whose dependencies are already
// available (a layer that reads a missing service is deferred), until every layer has
// built — then merge all their provisions into one context. A layer's dependencies may
// be satisfied by ANY other layer in the set, so order doesn't matter; a first Err
// short-circuits, and no forward progress means a dependency cycle.
const resolveWire = async (
  layers: readonly Layer<any, any, any>[],
  outerCtx: Context<any>,
  state: BuildState,
  // Keys whose value is fixed for this resolution: a layer that provides one of
  // them still builds, but its output for that key is discarded (the seeded value
  // wins). This is how `override` makes a patch win over a base provider deeply —
  // every consumer reads the patched value, yet the base provider's own body still
  // runs and registers its finalizers.
  protectedKeys: ReadonlySet<string> = new Set(),
): Promise<Result<Context<any>, any>> => {
  const acc = new Map(outerCtx.unsafeMap);
  const probe = makeProbeContext(acc);
  let remaining = layers;

  while (remaining.length > 0) {
    const outcomes = await Promise.all(
      remaining.map(async (layer) => {
        try {
          const result = await layer.build(probe, state);
          if (result.isOk()) return { layer, ctx: result.unwrap() };
          // The `MissingDependency` message IS the tag key the layer is waiting on.
          if (result.isDefect() && result.cause instanceof MissingDependency) {
            return { layer, waitingFor: result.cause.message };
          }
          return { fail: result };
        } catch (thrown) {
          if (thrown instanceof MissingDependency) return { layer, waitingFor: thrown.message };
          throw thrown;
        }
      }),
    );

    const pending: { layer: Layer<any, any, any>; waitingFor: string }[] = [];
    let progressed = false;
    for (const outcome of outcomes) {
      if ("fail" in outcome) return outcome.fail;
      if ("waitingFor" in outcome) {
        pending.push({ layer: outcome.layer, waitingFor: outcome.waitingFor });
      } else {
        for (const [key, service] of outcome.ctx.unsafeMap) {
          if (!protectedKeys.has(key)) acc.set(key, service);
        }
        progressed = true;
      }
    }
    if (!progressed) {
      // Every remaining layer is stuck waiting on a service that never becomes available —
      // a genuine dependency cycle (the type system can't catch cycles). Name the services
      // involved so it's diagnosable rather than a bare "cycle".
      const services = [...new Set(pending.map((p) => p.waitingFor))].sort();
      throw new Error(
        `demesne: Layer.wire could not resolve ${pending.length} layer(s) — a dependency ` +
          `cycle among the services [${services.join(", ")}] (each is waited on but never ` +
          `becomes available).`,
      );
    }
    remaining = pending.map((p) => p.layer);
  }

  return Ok(makeContext(acc));
};

// A `wire`-assembled layer, branded with the source layers it was assembled from. The
// brand is what lets `override` re-assemble the graph with patched providers deeply —
// a plain (opaque) `Layer` has already consumed its dependencies and can't be patched.
const WireSourceId = Symbol.for("demesne/wireSource");
export interface WiredLayer<Provides, E = never, Needs = never> extends Layer<Provides, E, Needs> {
  readonly [WireSourceId]: readonly Layer<any, any, any>[];
}

// Automatically assemble a set of layers: each layer's requirements may be satisfied by
// any other layer in the set, so you list them in any order instead of hand-threading
// `provideTo` / `merge`. Provides the UNION of every service; errors union; the only
// remaining `Needs` are those no layer in the set provides — so a self-contained set is
// `Needs = never` and a missing dependency stays in the type (and `build` rejects it).
const wire = <Ls extends readonly [Layer<any, any, any>, ...Layer<any, any, any>[]]>(
  ...layers: Ls
): WiredLayer<
  ProvidesOf<Ls[number]>,
  ErrorOf<Ls[number]>,
  Exclude<NeedsOf<Ls[number]>, ProvidesOf<Ls[number]>>
> => ({
  [WireSourceId]: layers as readonly Layer<any, any, any>[],
  build: (ctx, state) =>
    fromSafePromise(
      resolveWire(layers as readonly Layer<any, any, any>[], ctx as Context<any>, state),
    ).flatMap((result) => result.toAsync()),
});

// Resolve a `wire`-assembled base with a set of patch layers whose providers WIN. The
// patches build first (against the outer context), and every key they introduce or
// change is protected while the base's source layers re-assemble around them — so a
// consumer deep in the base reads the patched service, not the original. The base's own
// provider for a patched tag still runs (its finalizers register), but its value for
// that tag is discarded. Patches may only depend on services available OUTSIDE the base.
const resolveOverride = async (
  baseLayers: readonly Layer<any, any, any>[],
  patches: readonly Layer<any, any, any>[],
  outerCtx: Context<any>,
  state: BuildState,
): Promise<Result<Context<any>, any>> => {
  const patchResult = await resolveWire(patches, outerCtx, state);
  if (patchResult.isErr()) return patchResult;
  const patchCtx = patchResult.unwrap();

  const protectedKeys = new Set<string>();
  for (const [key, service] of patchCtx.unsafeMap) {
    if (!outerCtx.unsafeMap.has(key) || outerCtx.unsafeMap.get(key) !== service) {
      protectedKeys.add(key);
    }
  }

  return resolveWire(baseLayers, patchCtx, state, protectedKeys);
};

// Replace specific tags' providers deep inside an assembled (`Layer.wire`) graph while
// keeping the rest — the testing seam (swap a real adapter for a fake without hand-
// rewiring). `base` must be a `wire` result (only that carries the source layers this
// re-assembles); a plain layer is a compile error. Provides `P | Ps` (patches may add or
// replace tags), errors union, and requirements are `Exclude<N | Ns, Ps>` — a patch that
// provides a tag the base needed externally discharges it. `override` is DEEP: every
// consumer inside the base reads the patched service, not the original.
const override = <
  B extends WiredLayer<any, any, any>,
  Ps extends readonly [Layer<any, any, any>, ...Layer<any, any, any>[]],
>(
  base: B,
  patches: Ps,
): Layer<
  ProvidesOf<B> | ProvidesOf<Ps[number]>,
  ErrorOf<B> | ErrorOf<Ps[number]>,
  Exclude<NeedsOf<B> | NeedsOf<Ps[number]>, ProvidesOf<Ps[number]>>
> => ({
  build: (ctx, state) =>
    fromSafePromise(
      resolveOverride(
        base[WireSourceId],
        patches as readonly Layer<any, any, any>[],
        ctx as Context<any>,
        state,
      ),
    ).flatMap((result) => result.toAsync()),
});

// Accumulate several contributions to one COLLECTION tag into a single `readonly Item[]`
// service — the multi-binding / plugin-collection pattern, with no runtime registry. Each
// member provides the collection tag with an array (see `member`, or a `make`/`factory`
// returning one). collect builds them in PARALLEL (memoized, first `Err` short-circuits),
// concatenates their items IN LISTED ORDER, and provides the tag with the full array.
// Errors and requirements union across members; an empty member list is an empty collection.
const collect = <Self, Item, Ms extends readonly Layer<Self, any, any>[]>(
  collectionTag: Tag<Self, readonly Item[]>,
  members: Ms,
): Layer<Self, ErrorOf<Ms[number]>, NeedsOf<Ms[number]>> => ({
  build: (ctx, state) =>
    allAsync(
      (members as readonly Layer<any, any, any>[]).map((m) =>
        buildMemo(m, ctx as Context<any>, state),
      ),
    ).map((contexts) => {
      const items: Item[] = [];
      for (const c of contexts as Context<any>[]) {
        const arr = c.unsafeMap.get(collectionTag.key) as readonly Item[] | undefined;
        if (arr !== undefined) items.push(...arr);
      }
      return unsafeAdd(emptyAny(), collectionTag.key, items as readonly Item[]);
    }),
});

// Build a fully-wired layer. Callable once `Needs` is `never` — a graph that still
// needs a `Scope` (contains `acquireRelease` layers) is a COMPILE error here; use
// `scoped`. The AsyncResult still carries `E`. Shared layers construct once.
const build = <P, E>(self: Layer<P, E, never>): AsyncResult<Context<P>, E> => {
  const state = makeBuildState();
  return buildMemo(self, empty(), state).flatMap((ctx) =>
    runStartHooks(state).map(() => ctx),
  );
};

// Build a scoped layer, run `use` with the resulting Context, then CLOSE the scope
// — releasing every acquired resource in reverse order, whether `use` succeeded,
// failed, or the build failed partway. Discharges the `Scope` requirement, so this
// is how you consume `acquireRelease` graphs. Also accepts scope-free layers
// (`Needs = never`), since `never` is assignable to `Scope`.
const scoped = <P, E, A, E2>(
  self: Layer<P, E, Scope>,
  use: (ctx: Context<P>) => Result<A, E2> | AsyncResult<A, E2>,
): AsyncResult<A, E | E2> => {
  const state = makeBuildState();
  return fromSafePromise(
    (async (): Promise<Result<A, E | E2>> => {
      // `emptyAny()` (not `empty()`) because `self` needs `Context<Scope>`; the
      // phantom Scope never has a runtime value, so an empty context satisfies it.
      // Start hooks run after the whole graph builds, before `use`; a failed hook
      // skips `use` but the scope still closes (releasing whatever was acquired).
      const result = await buildMemo(self, emptyAny(), state)
        .flatMap((ctx) => runStartHooks(state).map(() => ctx))
        .flatMap((ctx) => use(ctx));
      await closeScope(state);
      return result;
    })(),
  ).flatMap((result) => result.toAsync());
};

// Fork a CHILD scope from an already-built parent context (the "request scope"):
// build `requestLayer` against the parent — its requirements must be provided by the
// parent, so `Needs` is `Parent | Scope` — run `use` with the parent's services PLUS
// the request-scoped ones, then release ONLY the request-scoped resources (LIFO). The
// parent (its long-lived singletons) is left untouched, and each fork builds fresh
// request-scoped services. Discharges the request layer's `Scope`.
const forkScope = <Parent, ReqP, E, A, E2>(
  parent: Context<Parent>,
  requestLayer: Layer<ReqP, E, Parent | Scope>,
  use: (ctx: Context<Parent | ReqP>) => Result<A, E2> | AsyncResult<A, E2>,
): AsyncResult<A, E | E2> => {
  const state = makeBuildState();
  return fromSafePromise(
    (async (): Promise<Result<A, E | E2>> => {
      // The fork runs only ITS OWN start hooks (fresh state) — the parent started when
      // it was built — then closes only the fork's scope.
      const result = await buildMemo(requestLayer, parent as Context<any>, state)
        .flatMap((reqCtx) => runStartHooks(state).map(() => reqCtx))
        .flatMap((reqCtx) =>
          use(mergeContext(parent as Context<any>, reqCtx) as Context<Parent | ReqP>),
        );
      await closeScope(state);
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

// Layer constructors (`value` / `factory` / `make` / `acquireRelease` / `member`),
// combinators (`merge` / `provideTo` / `wire` / `override` / `collect` / `onStart` /
// `onStop`), and the terminals `build` / `scoped` / `forkScope`.
export const Layer = {
  value,
  factory,
  make,
  acquireRelease,
  member,
  merge,
  provideTo,
  wire,
  override,
  collect,
  onStart,
  onStop,
  build,
  scoped,
  forkScope,
};
