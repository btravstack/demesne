// Type-level test suite. These assertions have no runtime; they are checked by
// `tsc` (the `test:types` script runs this file through `tsconfig.test-d.json`,
// which relaxes the unused-locals rules so throwaway assertion bindings are
// allowed). A failing assertion is a compile error.
//
// `Expect<Equal<A, B>>` is a hard error when `A` and `B` differ; `@ts-expect-error`
// guards the cases that must NOT compile. The blocks below prove the guarantees the
// core was designed for: absent reads fail, un-wired requirements block `build`, the
// error channel is the real union, `Context` is contravariant, scopes are enforced,
// and the combinators (`wire` / `override` / `collect`) compute every channel exactly.

import { type Context, Layer, type Scope, type ServiceOf, Tag, type WiredLayer } from "./index.js";
import { type AsyncResult, Ok, type Result, TaggedError } from "unthrown";

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

// --- 6. Layer.wire: automatic assembly ---------------------------------------

const wireA = Layer.make(ServiceA, (): Result<{ readonly a: string }, EA> => Ok({ a: "x" }));
const wireB = Layer.make(
  ServiceB,
  (ctx: Context<ServiceA>): Result<{ readonly b: number }, EB> =>
    Ok({ b: ctx.get(ServiceA).a.length }),
);

// wire unions Provides and Error, and computes Needs = all needs minus all provides.
// Listed in any order; wireB's need (ServiceA) is provided by wireA, so Needs = never.
const wiredAB = Layer.wire(wireB, wireA);
type _wiredAB = Expect<Equal<typeof wiredAB, WiredLayer<ServiceA | ServiceB, EA | EB, never>>>;

// Self-contained → build accepts it, and every service is provided.
const wiredABResult = Layer.build(wiredAB);
type _wiredABResult = Expect<
  Equal<typeof wiredABResult, AsyncResult<Context<ServiceA | ServiceB>, EA | EB>>
>;

// A need that no layer in the set provides stays in Needs, so `build` rejects it.
const wireNeedsC = Layer.make(
  ServiceA,
  (ctx: Context<ServiceC>): Result<{ readonly a: string }, EA> =>
    Ok({ a: String(ctx.get(ServiceC).c) }),
);
const wirePartial = Layer.wire(wireNeedsC);
type _wirePartial = Expect<Equal<typeof wirePartial, WiredLayer<ServiceA, EA, ServiceC>>>;
// @ts-expect-error - ServiceC is still unmet after wire; build requires Needs = never.
Layer.build(wirePartial);

// --- 7. Layer.forkScope: request / child scopes ------------------------------

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

// --- 8. Layer.override: swap providers in an assembled (wired) graph ----------

const wiredForOverride = Layer.wire(
  Layer.factory(ServiceA, () => ({ a: "x" })),
  Layer.factory(ServiceB, (ctx: Context<ServiceA>) => ({ b: ctx.get(ServiceA).a.length })),
);

// Overriding keeps the provides, unions the patch's errors, and discharges needs.
const failingPatch: Layer<ServiceA, EA, never> = Layer.make(
  ServiceA,
  (): Result<{ readonly a: string }, EA> => Ok({ a: "fake" }),
);
const overridden = Layer.override(wiredForOverride, [failingPatch]);
type _overridden = Expect<Equal<typeof overridden, Layer<ServiceA | ServiceB, EA, never>>>;

// A patch may also add a brand-new tag — it joins the provides union.
const withNew = Layer.override(wiredForOverride, [Layer.value(ServiceC, { c: true })]);
type _withNew = Expect<Equal<typeof withNew, Layer<ServiceA | ServiceB | ServiceC, never, never>>>;

// The base MUST be an assembled (`Layer.wire`) graph — a plain layer is rejected,
// because only a wired layer carries the source needed to re-assemble deeply.
const plainBase: Layer<ServiceA, never, never> = Layer.value(ServiceA, { a: "x" });
// @ts-expect-error - override requires a wired base, not a plain layer.
Layer.override(plainBase, [Layer.value(ServiceA, { a: "y" })]);

// --- 9. Layer.member + Layer.collect: multi-bindings / plugin collections -----

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
