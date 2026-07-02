// Type-level test suite. These assertions have no runtime; they are checked by
// `tsc` (the `test:types` script runs this file through `tsconfig.test-d.json`,
// which relaxes the unused-locals rules so throwaway assertion bindings are
// allowed). A failing assertion is a compile error.
//
// `Expect<Equal<A, B>>` is a hard error when `A` and `B` differ; `@ts-expect-error`
// guards the cases that must NOT compile. These four blocks prove the guarantees
// the core was designed for: absent reads fail, un-wired requirements block
// `build`, the error channel is the real union, and `Context` is contravariant.

import { type Context, Layer, type Scope, type ServiceOf, Tag } from "./index.js";
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
