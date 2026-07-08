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

const TagTypeId = Symbol.for("demesne/Tag");
const ContextTypeId = Symbol.for("demesne/Context");
// Where a `Service` subclass records its deps record, for `Layer.fromService` to read.
const ServiceDepsId = Symbol.for("demesne/ServiceDeps");

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

// Guard against the one runtime-unsound corner of the nominal-tag scheme: two DISTINCT tag
// classes that share an `Id` are distinct *types* but the same runtime map key (`tag.key`),
// so in a Context one silently reads the other's service. Ids must be globally unique.
//
// The guard is **development-only** — it is a best-effort dev aid, not part of the runtime
// contract. The `process.env.NODE_ENV` check sits INSIDE the call, with dot access, so
// bundler define-replacement (`process.env.NODE_ENV` → `"production"`) folds the whole body
// away in a production build; environments without a `process` global (a browser with no
// shim) are silent; and the registry is allocated lazily, so importing the module has no
// side effects. It warns (never throws — a latent duplicate shouldn't crash) exactly once
// per repeated id.
declare const process: undefined | { readonly env: { readonly NODE_ENV?: string } };

// id → whether the duplicate warning for it already fired (dev-only, allocated on first Tag).
let seenTagIds: Map<string, boolean> | undefined;

// Warn (once per id, dev-only) when an id repeats — shared by `Tag` and `Service`, both of
// which mint a nominal identity keyed by the id.
const warnDuplicateId = (id: string): void => {
  if (typeof process === "undefined" || process.env.NODE_ENV === "production") return;
  seenTagIds ??= new Map();
  const warned = seenTagIds.get(id);
  if (warned === undefined) {
    seenTagIds.set(id, false);
  } else if (!warned) {
    seenTagIds.set(id, true);
    console.warn(
      `demesne: duplicate Tag id ${JSON.stringify(id)} — tag ids must be unique, or two ` +
        `tags collide in the Context and one reads the other's service.`,
    );
  }
};

export const Tag =
  <const Id extends string>(id: Id) =>
  <Self, Service>(): TagClass<Self, Id, Service> => {
    warnDuplicateId(id);
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
      throw new Error(`demesne: service "${tag.key}" not found in context`);
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
  // The `BuildState` (memoization + finalizers) is threaded through every build.
  readonly build: (ctx: Context<Needs>, state: BuildState) => AsyncResult<Context<Provides>, E>;
  // Optional structural metadata for graph introspection (`Layer.describe` / `Layer.toDot`).
  // Optional so a hand-built `{ build }` layer still satisfies `Layer` (it shows as opaque).
  // Never read during a build — a pure debugging aid.
  readonly meta?: LayerMeta;
}

// The shape each combinator records for `Layer.describe` / `Layer.toDot`. `needs` is the set of
// service keys a node reads WHEN KNOWN AT RUNTIME — `value` (none), `class` / `service` (the
// dep list). It is `undefined` for `factory` / `make` / `acquireRelease` / `member`, whose
// per-service requirements live only in the erased `Needs` type; their edges are INFERRED from
// the `provideTo` composition instead (what they were fed), which is exact about the wiring
// though it may over-approximate actual usage.
export type LayerMeta =
  | {
      readonly kind: "value" | "factory" | "make" | "acquireRelease" | "member";
      readonly key: string;
      readonly needs?: readonly string[];
    }
  | { readonly kind: "class" | "service"; readonly key: string; readonly needs: readonly string[] }
  | { readonly kind: "collect"; readonly key: string; readonly members: readonly Layer<any, any, any>[] }
  | { readonly kind: "merge"; readonly children: readonly Layer<any, any, any>[] }
  | { readonly kind: "provideTo"; readonly self: Layer<any, any, any>; readonly dep: Layer<any, any, any> }
  | { readonly kind: "onStart" | "onStop"; readonly child: Layer<any, any, any> };

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
//
// Exported as a type-only name because it appears in `Layer`'s public `build`
// signature — a hand-written `{ build }` layer needs to be able to name it.
// ---------------------------------------------------------------------------
export interface BuildState {
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
  meta: { kind: "value", key: tag.key, needs: [] },
});

// A layer built synchronously and infallibly from the context. `f` runs inside `.map`, so a
// throw in its body becomes a `Defect` (handled at the edge) rather than escaping the
// AsyncResult — the same discipline as `make`. Infallible means `E = never`; a `Defect` is
// orthogonal (the unmodeled-throw escape hatch), so the type is unchanged.
const factory = <Self, Service, Needs = never>(
  tag: Tag<Self, Service>,
  f: (ctx: Context<Needs>) => Service,
): Layer<Self, never, Needs> => ({
  build: (ctx) => Ok<void>(undefined).toAsync().map(() => unsafeAdd(emptyAny(), tag.key, f(ctx))),
  meta: { kind: "factory", key: tag.key },
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
  meta: { kind: "make", key: tag.key },
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
  meta: { kind: "acquireRelease", key: tag.key },
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
  meta: { kind: "onStart", child: layer },
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
  meta: { kind: "onStop", child: layer },
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
  // `f` runs inside `.map` so a throw becomes a `Defect`, not an escaped exception (like `factory`).
  build: (ctx) =>
    Ok<void>(undefined)
      .toAsync()
      .map(() => unsafeAdd(emptyAny(), collectionTag.key, [f(ctx)] as readonly Item[])),
  meta: { kind: "member", key: collectionTag.key },
});

// The constructor-argument tuple a dependency-tag list induces (each tag → its service),
// and the `Needs` it induces (the union of the tags' nominal identities).
type DepServices<D extends readonly Tag<any, any>[]> = { [K in keyof D]: ServiceOf<D[K]> };
type DepNeeds<D extends readonly Tag<any, any>[]> = {
  [K in keyof D]: D[K] extends Tag<infer Self, any> ? Self : never;
}[number];

// Construct a class from a list of dependency tags — constructor injection with no
// hand-written factory. demesne resolves each tag from the context and passes the services,
// IN ORDER, to `new Ctor(...)`. The tuple is type-checked against the constructor's parameters
// (wrong order / type / arity is a compile error) and the tags' identities become the layer's
// `Needs`. `new Ctor` runs inside `.map`, so a throw in the constructor becomes a `Defect`
// (like `factory`). The class stays plain — it never imports demesne, it just declares
// `ServiceOf<...>` constructor parameters.
const classLayer = <Self, Instance, const D extends readonly Tag<any, any>[]>(
  tag: Tag<Self, Instance>,
  deps: D,
  ctor: new (...args: DepServices<D>) => Instance,
): Layer<Self, never, DepNeeds<D>> => ({
  build: (ctx) =>
    Ok<void>(undefined)
      .toAsync()
      .map(() => {
        const args = (deps as readonly Tag<any, any>[]).map((d) => (ctx as Context<any>).get(d));
        return unsafeAdd(emptyAny(), tag.key, new ctor(...(args as DepServices<D>)));
      }),
  meta: {
    kind: "class",
    key: tag.key,
    needs: (deps as readonly Tag<any, any>[]).map((d) => d.key),
  },
});

// The injected instance shape a deps RECORD induces (each field → its tag's service), and the
// `Needs` it induces (the union of the record's tags' identities).
type InjectedOf<R extends Record<string, Tag<any, any>>> = {
  readonly [K in keyof R]: ServiceOf<R[K]>;
};
type NeedsOfRecord<R extends Record<string, Tag<any, any>>> = {
  [K in keyof R]: R[K] extends Tag<infer Self, any> ? Self : never;
}[keyof R];

// The type of a `Service(...)` base: a Tag whose service is the instance itself, plus an
// injecting constructor (instances carry the resolved deps). `Layer.fromService(Cls)` turns it
// into a Layer. The recorded deps live on a runtime-only static (read by `fromService`), kept
// off this public type so a `Service` subclass stays a clean `Tag`.
export interface ServiceClass<Self, Id extends string, R extends Record<string, Tag<any, any>>>
  extends Tag<Self, Self> {
  new (injected: InjectedOf<R>): InjectedOf<R>;
  readonly key: Id;
}

// A Service base fuses tag + constructor-injection into ONE class declaration (the
// `Effect.Service` analog). `class Foo extends Service<Foo>()("Foo", { dep: DepTag }) {}` makes
// `Foo` a Tag whose service is the instance and injects each entry as `this.dep` (typed from
// the record); `Layer.fromService(Foo)` is its Layer. The trade vs `Layer.class`: the class
// extends a demesne base (coupling) for the fewest artifacts.
export const Service =
  <Self>() =>
  <const Id extends string, R extends Record<string, Tag<any, any>>>(
    id: Id,
    deps: R,
  ): ServiceClass<Self, Id, R> => {
    warnDuplicateId(id);
    const base = class {
      static readonly [TagTypeId] = TagTypeId;
      static readonly key = id;
      static readonly [ServiceDepsId] = deps;
      constructor(injected: InjectedOf<R>) {
        Object.assign(this, injected);
      }
    };
    return base as unknown as ServiceClass<Self, Id, R>;
  };

// Build the Layer for a `Service` subclass: resolve its recorded deps from the context and
// construct `new Cls(injected)`. Like every constructor it returns a FRESH layer — bind it to a
// `const` and reuse that so a shared service builds once (memoized by reference, as everywhere).
// `new Cls` runs inside `.map`, so a throwing constructor / field initializer becomes a `Defect`
// (like `factory` / `class`). Infallible: `E = never`.
const fromService = <Self, Id extends string, R extends Record<string, Tag<any, any>>>(
  cls: ServiceClass<Self, Id, R>,
): Layer<Self, never, NeedsOfRecord<R>> => {
  const deps = (cls as unknown as { [ServiceDepsId]: R })[ServiceDepsId];
  const Ctor = cls as unknown as new (injected: InjectedOf<R>) => Self;
  return {
    build: (ctx) =>
      Ok<void>(undefined)
        .toAsync()
        .map(() => {
          const injected: Record<string, unknown> = {};
          for (const key of Object.keys(deps)) {
            injected[key] = (ctx as Context<any>).get(deps[key] as Tag<any, any>);
          }
          return unsafeAdd(emptyAny(), cls.key, new Ctor(injected as InjectedOf<R>));
        }),
    meta: {
      kind: "service",
      key: cls.key,
      needs: Object.values(deps).map((t) => (t as Tag<any, any>).key),
    },
  };
};

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
  meta: { kind: "merge", children: layers as readonly Layer<any, any, any>[] },
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
  meta: { kind: "provideTo", self, dep },
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
  meta: {
    kind: "collect",
    key: collectionTag.key,
    members: members as readonly Layer<any, any, any>[],
  },
});

// ---------------------------------------------------------------------------
// Graph introspection — a read-only debugging aid. `describe` walks the recorded
// structural `meta` (see `LayerMeta`) into a normalized node/edge model; `toDot`
// renders it as Graphviz DOT. NO factories run — this reflects the composed STRUCTURE,
// not a live build. Edges are EXACT for value / class / Service (needs known at runtime)
// and INFERRED from the `provideTo` composition for factory / make / acquireRelease /
// member (whose per-service needs are erased) — the inferred edges show the wiring, and may
// over-approximate usage. A hand-built `{ build }` layer (no meta) contributes nothing.
// ---------------------------------------------------------------------------
export interface GraphNode {
  readonly key: string;
  readonly kind: LayerMeta["kind"];
}
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly inferred: boolean; // true = from provideTo composition (usage over-approximated)
}
export interface LayerGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

// The service keys a layer EXPOSES at its root (provideTo consumes its `dep`, so only `self`).
const providedKeys = (layer: Layer<any, any, any>): string[] => {
  const m = layer.meta;
  if (m === undefined) return [];
  switch (m.kind) {
    case "merge":
      return m.children.flatMap(providedKeys);
    case "provideTo":
      return providedKeys(m.self);
    case "onStart":
    case "onStop":
      return providedKeys(m.child);
    default:
      return [m.key];
  }
};

const describe = (root: Layer<any, any, any>): LayerGraph => {
  // 1. Collect every provider node (key → { kind, needs }) and every provideTo relation.
  const providers = new Map<
    string,
    { kind: LayerMeta["kind"]; needs: readonly string[] | undefined }
  >();
  const relations: { selfKeys: string[]; depKeys: string[] }[] = [];
  const walk = (layer: Layer<any, any, any>): void => {
    const m = layer.meta;
    if (m === undefined) return;
    switch (m.kind) {
      case "merge":
        m.children.forEach(walk);
        break;
      case "provideTo":
        relations.push({ selfKeys: providedKeys(m.self), depKeys: providedKeys(m.dep) });
        walk(m.self);
        walk(m.dep);
        break;
      case "collect":
        if (!providers.has(m.key)) providers.set(m.key, { kind: "collect", needs: undefined });
        m.members.forEach(walk);
        break;
      case "onStart":
      case "onStop":
        walk(m.child);
        break;
      default:
        // a single-provider leaf; a repeated key (e.g. a collection member) keeps the first.
        if (!providers.has(m.key)) providers.set(m.key, { kind: m.kind, needs: m.needs });
        break;
    }
  };
  walk(root);

  // 2. Edges: EXACT from known needs; INFERRED from provideTo for unknown-needs providers.
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  const add = (from: string, to: string, inferred: boolean): void => {
    const id = `${from} ${to}`;
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ from, to, inferred });
  };
  for (const [key, info] of providers) {
    if (info.needs !== undefined) for (const n of info.needs) add(key, n, false);
  }
  for (const { selfKeys, depKeys } of relations) {
    for (const sk of selfKeys) {
      const info = providers.get(sk);
      if (info !== undefined && info.needs === undefined) {
        for (const dk of depKeys) add(sk, dk, true);
      }
    }
  }

  // 3. Deterministic ordering for stable output.
  const nodes: GraphNode[] = [...providers.entries()]
    .map(([key, info]) => ({ key, kind: info.kind }))
    .sort((a, b) => a.key.localeCompare(b.key));
  edges.sort((a, b) => `${a.from} ${a.to}`.localeCompare(`${b.from} ${b.to}`));
  return { nodes, edges };
};

// Render the graph as Graphviz DOT. Resource nodes (acquireRelease) are dashed boxes,
// collections are boxes, and inferred edges (usage over-approximated) are dashed.
const toDot = (root: Layer<any, any, any>, name = "demesne"): string => {
  const { nodes, edges } = describe(root);
  const quote = (s: string): string => JSON.stringify(s);
  const style = (kind: LayerMeta["kind"]): string =>
    kind === "acquireRelease" ? " [shape=box, style=dashed]" : kind === "collect" ? " [shape=box]" : "";
  const lines = [`digraph ${quote(name)} {`];
  for (const n of nodes) lines.push(`  ${quote(n.key)}${style(n.kind)};`);
  for (const e of edges) {
    lines.push(`  ${quote(e.from)} -> ${quote(e.to)}${e.inferred ? " [style=dashed]" : ""};`);
  }
  lines.push("}");
  return lines.join("\n");
};

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

// Layer constructors (`value` / `factory` / `make` / `acquireRelease` / `member` / `class`),
// combinators (`merge` / `provideTo` / `collect` / `onStart` / `onStop`), the introspection
// aids (`describe` / `toDot`), and the terminals `build` / `scoped` / `forkScope`. `class` is
// constructor-injection sugar over `factory`; `fromService` builds the Layer for a `Service`
// subclass (which is exported top-level, alongside `Tag`). Assembly is
// single-pass and fully type-checked: you compose a graph by hand with `provideTo` / `merge`
// (there is no runtime auto-wiring).
export const Layer = {
  value,
  factory,
  make,
  acquireRelease,
  member,
  class: classLayer,
  fromService,
  merge,
  provideTo,
  collect,
  onStart,
  onStop,
  describe,
  toDot,
  build,
  scoped,
  forkScope,
};
