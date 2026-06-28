// Type-level test suite. These assertions have no runtime; they are checked by
// `tsc` (the `test:types` script runs this file through `tsconfig.test-d.json`,
// which relaxes the unused-locals rules so throwaway assertion bindings are
// allowed). A failing assertion is a compile error.
//
// `Expect<Equal<A, B>>` is a hard error when `A` and `B` differ; `@ts-expect-error`
// guards the cases that must NOT compile. These four blocks prove the guarantees
// the core was designed for: absent reads fail, un-wired requirements block
// `build`, the error channel is the real union, and `Context` is contravariant.

import { build, type Context, type Layer, make, merge, Tag } from "./index.js";
import { type AsyncResult, Ok, type Result, TaggedError } from "unthrown";

// --- assertion helpers -------------------------------------------------------

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// --- fixtures ----------------------------------------------------------------

type AService = { readonly a: string };
class TagA extends Tag("TagA")<TagA, AService>() {}
type BService = { readonly b: number };
class TagB extends Tag("TagB")<TagB, BService>() {}

class EA extends TaggedError("EA")<{ x: number }> {}
class EB extends TaggedError("EB")<{ y: string }> {}

// --- 1. Reading an absent service is a type error ----------------------------

declare const ctxA: Context<TagA>;

const readA = ctxA.get(TagA);
type _readA = Expect<Equal<typeof readA, AService>>;

// @ts-expect-error - TagB is not in this context's R, so `get` must reject it.
ctxA.get(TagB);

// --- 2. Un-wired requirements block `build` ----------------------------------

// A fully-wired layer (Needs = never) builds, yielding the carried error union.
declare const wired: Layer<TagA, EA, never>;
const built = build(wired);
type _built = Expect<Equal<typeof built, AsyncResult<Context<TagA>, EA>>>;

// A layer that still needs TagA is NOT accepted by `build` (Needs must be never).
declare const unwired: Layer<TagB, never, TagA>;
// @ts-expect-error - `build` requires Needs = never; TagA is still unmet.
build(unwired);

// --- 3. The error channel is the real union, not `any` -----------------------

const layerA = make(TagA, (): Result<AService, EA> => Ok({ a: "x" }));
const layerB = make(TagB, (): Result<BService, EB> => Ok({ b: 1 }));
const graph = merge(layerA, layerB);

const graphResult = build(graph);
type _graphResult = Expect<Equal<typeof graphResult, AsyncResult<Context<TagA | TagB>, EA | EB>>>;

// The union cannot be narrowed to a single arm: EA alone does not absorb EB.
// @ts-expect-error - the error channel is EA | EB, not EA alone.
const narrowed: AsyncResult<Context<TagA | TagB>, EA> = graphResult;
void narrowed;

// --- 4. Context is contravariant in R ----------------------------------------

declare const rich: Context<TagA | TagB>;
const wantsA = (_: Context<TagA>): void => {};
// A richer context satisfies a consumer asking for fewer services.
wantsA(rich);

declare const poor: Context<TagA>;
const wantsAB = (_: Context<TagA | TagB>): void => {};
// @ts-expect-error - a Context<TagA> cannot satisfy a consumer needing TagA | TagB.
wantsAB(poor);
