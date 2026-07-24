// Type-level test suite. These assertions have no runtime; they are checked by
// `tsc` (the `test:types` script runs this file through `tsconfig.test-d.json`,
// which relaxes the unused-locals rules so throwaway assertion bindings are
// allowed). A failing assertion is a compile error.
//
// `Expect<Equal<A, B>>` is a hard error when `A` and `B` differ; `@ts-expect-error`
// guards the cases that must NOT compile. The blocks below prove the guarantees the
// core was designed for: absent reads fail, un-wired requirements block `build`, the
// error channel is the real union, `Context` is contravariant, scopes are enforced,
// and the combinators (`merge` / `collect` / lifecycle hooks) compute every channel exactly.

import { type AsyncResult, Ok, type Result, TaggedError } from "unthrown";

import {
  type Context,
  Layer,
  type LayerGraph,
  type Scope,
  Service,
  type ServiceOf,
  Tag,
} from "./index.js";

// --- assertion helpers -------------------------------------------------------

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// --- fixtures (inline tags: the class IS the tag, shape inlined) --------------

class ServiceA extends Tag("ServiceA")<ServiceA, { readonly a: string }>() {}
class ServiceB extends Tag("ServiceB")<ServiceB, { readonly b: number }>() {}
class ServiceC extends Tag("ServiceC")<ServiceC, { readonly c: boolean }>() {}

class EA extends TaggedError("EA")<{ x: number }> {}
class EB extends TaggedError("EB")<{ y: string }> {}
class EC extends TaggedError("EC")<{ z: boolean }> {}

// --- 1. Reading an absent service is a type error ----------------------------

declare const ctxA: Context<ServiceA>;

const readA = ctxA.get(ServiceA);
type _readA = Expect<Equal<typeof readA, { readonly a: string }>>;

// @ts-expect-error - ServiceB is not in this context's R, so `get` must reject it.
ctxA.get(ServiceB);

// `ServiceOf` recovers the shape — from the instance type AND from `typeof tag`.
type _serviceOfInstance = Expect<Equal<ServiceOf<ServiceA>, { readonly a: string }>>;
type _serviceOfTypeof = Expect<Equal<ServiceOf<typeof ServiceA>, { readonly a: string }>>;

// --- 2. Un-wired requirements block `build` ----------------------------------

// A fully-wired layer (Needs = never) builds, yielding the carried error union.
declare const wired: Layer<ServiceA, EA, never>;
const built = Layer.build(wired);
type _built = Expect<Equal<typeof built, AsyncResult<Context<ServiceA>, EA>>>;

// A layer that still needs ServiceA is NOT accepted by `build` (Needs must be never).
declare const unwired: Layer<ServiceB, never, ServiceA>;
// @ts-expect-error - `build` requires Needs = never; ServiceA is still unmet.
Layer.build(unwired);

// --- 2b. provideTo SUBTRACTS the provided services from Needs (Exclude) -------

declare const needsAB: Layer<ServiceC, never, ServiceA | ServiceB>;
declare const providesA: Layer<ServiceA, EA, never>;
declare const providesB: Layer<ServiceB, EB, never>;

// One provider discharges exactly its own service; the rest of Needs survives,
// and the provider's error unions into E.
const partiallyWired = Layer.provideTo(needsAB, providesA);
type _partiallyWired = Expect<Equal<typeof partiallyWired, Layer<ServiceC, EA, ServiceB>>>;

// The second provider discharges the remainder: Needs = never, E = EA | EB.
const fullyWired = Layer.provideTo(partiallyWired, providesB);
type _fullyWired = Expect<Equal<typeof fullyWired, Layer<ServiceC, EA | EB, never>>>;

// --- 3. The error channel is the real union, not `any` -----------------------

const layerA = Layer.make(ServiceA, (): Result<{ readonly a: string }, EA> => Ok({ a: "x" }));
const layerB = Layer.make(ServiceB, (): Result<{ readonly b: number }, EB> => Ok({ b: 1 }));
const graph = Layer.merge(layerA, layerB);

const graphResult = Layer.build(graph);
type _graphResult = Expect<
  Equal<typeof graphResult, AsyncResult<Context<ServiceA | ServiceB>, EA | EB>>
>;

// The union cannot be narrowed to a single arm: EA alone does not absorb EB.
// @ts-expect-error - the error channel is EA | EB, not EA alone.
const narrowed: AsyncResult<Context<ServiceA | ServiceB>, EA> = graphResult;
void narrowed;

// --- 3b. merge is variadic: every channel unions across all layers -----------

const layerC = Layer.make(ServiceC, (): Result<{ readonly c: boolean }, EC> => Ok({ c: true }));
const triple = Layer.build(Layer.merge(layerA, layerB, layerC));
type _triple = Expect<
  Equal<typeof triple, AsyncResult<Context<ServiceA | ServiceB | ServiceC>, EA | EB | EC>>
>;

// @ts-expect-error - merge requires at least one layer.
Layer.merge();

// --- 4. Context is contravariant in R ----------------------------------------

declare const rich: Context<ServiceA | ServiceB>;
const wantsA = (_: Context<ServiceA>): void => {};
// A richer context satisfies a consumer asking for fewer services.
wantsA(rich);

declare const poor: Context<ServiceA>;
const wantsAB = (_: Context<ServiceA | ServiceB>): void => {};
// @ts-expect-error - a Context<ServiceA> cannot satisfy a consumer needing ServiceA | ServiceB.
wantsAB(poor);

// --- 5. acquireRelease + scoped: type-level scope enforcement ----------------

// acquireRelease carries `Scope` in its Needs (its error/service come from acquire).
const resourceLayer = Layer.acquireRelease(
  ServiceA,
  (): Result<{ readonly a: string }, EA> => Ok({ a: "x" }),
  () => {},
);
type _resource = Expect<Equal<typeof resourceLayer, Layer<ServiceA, EA, Scope>>>;

// `build` REJECTS a scope-needing graph — it must be consumed with `scoped`.
// @ts-expect-error - build requires Needs = never; the graph still needs a Scope.
Layer.build(resourceLayer);

// `scoped` discharges the Scope, runs `use`, and unions the error channels.
const scopedResult = Layer.scoped(
  resourceLayer,
  (ctx): Result<string, EB> => Ok(ctx.get(ServiceA).a),
);
type _scoped = Expect<Equal<typeof scopedResult, AsyncResult<string, EA | EB>>>;

// `scoped` also accepts a scope-free layer (Needs = never is assignable to Scope).
declare const plain: Layer<ServiceA, EA, never>;
const scopedPlain = Layer.scoped(plain, (): Result<number, never> => Ok(1));
type _scopedPlain = Expect<Equal<typeof scopedPlain, AsyncResult<number, EA>>>;

// ...but a real unmet service is still rejected (only `never` / `Scope` are allowed).
declare const unwiredResource: Layer<ServiceA, never, ServiceB>;
// @ts-expect-error - scoped still requires real services (ServiceB) to be wired first.
Layer.scoped(unwiredResource, (): Result<number, never> => Ok(1));

// --- 6. Layer.forkScope: request / child scopes ------------------------------

declare const parentCtx: Context<ServiceA>;
const reqLayer = Layer.factory(ServiceB, (ctx: Context<ServiceA>) => ({
  b: ctx.get(ServiceA).a.length,
}));

// forkScope infers the parent, runs `use` with parent + request services, unions errors.
const forked = Layer.forkScope(
  parentCtx,
  reqLayer,
  (ctx): Result<string, EB> => Ok(`${ctx.get(ServiceA).a}:${ctx.get(ServiceB).b}`),
);
type _forked = Expect<Equal<typeof forked, AsyncResult<string, EB>>>;

// A request layer needing a service the parent doesn't provide is rejected.
const reqNeedsC = Layer.factory(ServiceB, (ctx: Context<ServiceC>) => ({
  b: ctx.get(ServiceC).c ? 1 : 0,
}));
// @ts-expect-error - ServiceC is not provided by the parent Context<ServiceA>.
Layer.forkScope(parentCtx, reqNeedsC, (): Result<number, never> => Ok(1));

// --- 7. Layer.member + Layer.collect: multi-bindings / plugin collections -----

type Plugin = { readonly name: string };
class Plugins extends Tag("Plugins")<Plugins, readonly Plugin[]>() {}

// A member provides the collection tag; its own Needs are inferred from the factory.
const memberA = Layer.member(Plugins, (ctx: Context<ServiceA>) => ({ name: ctx.get(ServiceA).a }));
type _memberA = Expect<Equal<typeof memberA, Layer<Plugins, never, ServiceA>>>;

// The collection tag's service is the array shape.
type _pluginsSvc = Expect<Equal<ServiceOf<Plugins>, readonly Plugin[]>>;

// collect unions member errors and requirements across the whole set.
const memberB: Layer<Plugins, EB, ServiceB> = Layer.make(
  Plugins,
  (ctx: Context<ServiceB>): Result<readonly Plugin[], EB> =>
    Ok([{ name: String(ctx.get(ServiceB).b) }]),
);
const collected = Layer.collect(Plugins, [memberA, memberB]);
type _collected = Expect<Equal<typeof collected, Layer<Plugins, EB, ServiceA | ServiceB>>>;

// An empty collection needs nothing and cannot fail.
const emptyCollected = Layer.collect(Plugins, []);
type _emptyCollected = Expect<Equal<typeof emptyCollected, Layer<Plugins, never, never>>>;

// Every member must contribute to the SAME collection tag — a foreign tag is rejected.
// @ts-expect-error - ServiceA is not the Plugins collection tag.
Layer.collect(Plugins, [Layer.value(ServiceA, { a: "x" })]);

// --- 8. Layer.onStart + Layer.onStop: lifecycle hooks -----------------------

// onStart unions the hook's error into E; provides and needs (contravariant!) are kept.
declare const startBase: Layer<ServiceA, EA, ServiceB>;
const started = Layer.onStart(startBase, (): Result<void, EC> => Ok(undefined));
type _started = Expect<Equal<typeof started, Layer<ServiceA, EA | EC, ServiceB>>>;

// The start hook sees exactly the layer's provided Context<P> — no more, no less.
Layer.onStart(startBase, (ctx): Result<void, never> => {
  type _ctxIsProvided = Expect<Equal<typeof ctx, Context<ServiceA>>>;
  return Ok(undefined);
});

// onStop adds Scope to Needs — the graph must be consumed with `scoped`, not `build`.
declare const stopBase: Layer<ServiceA, EA, never>;
const stopped = Layer.onStop(stopBase, () => {});
type _stopped = Expect<Equal<typeof stopped, Layer<ServiceA, EA, Scope>>>;
// @ts-expect-error - onStop adds Scope; build requires Needs = never.
Layer.build(stopped);
const stoppedScoped = Layer.scoped(stopped, (): Result<number, never> => Ok(1));
type _stoppedScoped = Expect<Equal<typeof stoppedScoped, AsyncResult<number, EA>>>;

// --- 9. Layer.class + Service: constructor-injection sugar -------------------

class Consumer {
  constructor(
    readonly a: ServiceOf<typeof ServiceA>,
    readonly b: ServiceOf<typeof ServiceB>,
  ) {}
}
class ConsumerTag extends Tag("ConsumerTag")<ConsumerTag, Consumer>() {}

// Layer.class: Provides = the tag's Self, E = never, Needs = union of the deps' identities.
const consumerLive = Layer.class(ConsumerTag, [ServiceA, ServiceB], Consumer);
type _consumerLive = Expect<
  Equal<typeof consumerLive, Layer<ConsumerTag, never, ServiceA | ServiceB>>
>;

// The deps list is type-checked against the constructor. A tag whose service doesn't match a
// constructor parameter is rejected (ServiceC's shape ≠ Consumer's second param).
// @ts-expect-error - [ServiceA, ServiceC] does not match Consumer's (a: A, b: B).
Layer.class(ConsumerTag, [ServiceA, ServiceC], Consumer);

// Too few deps for the constructor is rejected (arity — Consumer needs two args).
// @ts-expect-error - one tag is not enough for a two-parameter constructor.
Layer.class(ConsumerTag, [ServiceA], Consumer);

// Service: `Layer.fromService` has Needs = union of the record's identities, Provides = instance.
class Widget extends Service<Widget>()("WidgetSvc", { a: ServiceA, b: ServiceB }) {
  ab(): string {
    return `${this.a.a}:${this.b.b}`;
  }
}
const widgetLayer = Layer.fromService(Widget);
type _widgetLayer = Expect<Equal<typeof widgetLayer, Layer<Widget, never, ServiceA | ServiceB>>>;

// The injected fields are typed from the record, and reading the service yields the instance.
declare const widget: Widget;
type _widgetA = Expect<Equal<typeof widget.a, { readonly a: string }>>;
declare const ctxWidget: Context<Widget>;
const gotWidget = ctxWidget.get(Widget);
type _gotWidget = Expect<Equal<typeof gotWidget, Widget>>;

// --- 10. Layer.describe + Layer.toDot: graph introspection ------------------

// Introspection accepts any layer regardless of channels and returns a concrete model.
declare const anyLayer: Layer<ServiceA, EA, ServiceB>;
const describedGraph = Layer.describe(anyLayer);
type _describedGraph = Expect<Equal<typeof describedGraph, LayerGraph>>;
const describedDot = Layer.toDot(anyLayer);
type _describedDot = Expect<Equal<typeof describedDot, string>>;

// --- 11. Layer.inject: record-injection for function-shaped services ---------

type Greeter = (name: string) => string;
class GreeterTag extends Tag("GreeterTag")<GreeterTag, Greeter>() {}

// Needs = union of the record's identities; deps and ctx are typed from the record.
const greeterLive = Layer.inject(GreeterTag, { a: ServiceA, b: ServiceB }, ({ a, b }, ctx) => {
  type _depA = Expect<Equal<typeof a, { readonly a: string }>>;
  type _ctx = Expect<Equal<typeof ctx, Context<ServiceA | ServiceB>>>;
  return (name) => `${name}:${a.a}:${b.b}`;
});
type _greeterLive = Expect<
  Equal<typeof greeterLive, Layer<GreeterTag, never, ServiceA | ServiceB>>
>;

// An empty record needs nothing and cannot fail.
const constGreeter = Layer.inject(GreeterTag, {}, () => (name: string) => name);
type _constGreeter = Expect<Equal<typeof constGreeter, Layer<GreeterTag, never, never>>>;

// @ts-expect-error - f must return the tag's service shape (a Greeter, not a number).
Layer.inject(GreeterTag, { a: ServiceA }, () => 42);

// A dep's service shape governs what f can do with it — an unknown member is rejected.
Layer.inject(GreeterTag, { a: ServiceA }, ({ a }) => {
  // @ts-expect-error - notAField does not exist on ServiceA's service shape.
  void a.notAField;
  return (name: string) => name;
});
