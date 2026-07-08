# `Layer.inject` + full-DI example — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Layer.inject` (record-based injection for function-shaped services) to demesne core, then rebuild the hono-prisma example so the whole app — use cases, routes, HTTP listener, per-request scope — flows through the DI.

**Architecture:** `inject` is the third injection sugar over `factory` (beside `Layer.class` and `Service`): it resolves a deps _record_ and passes it, plus the typed context, to a plain function. The record is runtime-known, so `inject` gets exact introspection edges. In the example, one-method use cases become function-shaped tags built with `inject`; the Hono app becomes an injected `HttpApp` service whose `ctx` is the `forkScope` parent for a per-request scope; the listener becomes an `acquireRelease` resource.

**Tech Stack:** TypeScript (strict, NodeNext), vitest (`*.spec.ts`), tsc type-tests (`*.test-d.ts`), unthrown v3 (peer), Hono + @hono/node-server, zod.

**Design spec:** `docs/superpowers/specs/2026-07-09-layer-inject-and-full-di-example-design.md`

## Global Constraints

- Work on branch `feat/layer-inject-and-full-di-example` (already created; the spec is committed on it).
- All commands run from the repo root `/Users/frx29150/Projects/demesne` unless stated.
- TDD: write the failing test, watch it fail, implement, watch it pass. Never weaken an invariant to make a test pass — `CLAUDE.md` is the authoritative spec.
- `packages/core/src/index.ts` is exempt from `no-explicit-any` (internal casts are expected there); everywhere else lint rules are strict.
- Conventional commits; end every commit message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Lefthook runs oxlint/oxfmt/commitlint on commit — a failed hook means fix and re-commit.
- Core tests: `pnpm --filter demesne test` (vitest) and `pnpm --filter demesne typecheck` (tsc + test-d).
- Example checks: `pnpm turbo run typecheck test --filter=@demesne-examples/hono-prisma-api`.
- Node ≥ 22.19 (global `crypto.randomUUID` and `fetch` are available).

---

### Task 1: `Layer.inject` in core

**Files:**

- Modify: `packages/core/src/index.ts` (LayerMeta ~line 157; new `inject` after `fromService` ~line 471; `Layer` namespace ~line 740; introspection header comment ~line 544)
- Test: `packages/core/src/demesne.spec.ts` (append a new describe block at end of file)
- Test: `packages/core/src/demesne.test-d.ts` (append section 11 at end of file)

**Interfaces:**

- Produces: `Layer.inject<Self, Service, const R extends Record<string, Tag<any, any>>>(tag: Tag<Self, Service>, deps: R, f: (deps: InjectedOf<R>, ctx: Context<NeedsOfRecord<R>>) => Service): Layer<Self, never, NeedsOfRecord<R>>` — used by Tasks 4–7. `LayerMeta` gains kind `"inject"` in the exact-needs branch.

- [ ] **Step 1: Write the failing runtime tests**

Append to `packages/core/src/demesne.spec.ts` (end of file):

```ts
describe("Layer.inject: record-injection for function-shaped services", () => {
  class Greet extends Tag("Greet")<Greet, (name: string) => string>() {}

  it("resolves the deps record and builds the service from it", async () => {
    const logs: string[] = [];
    const GreetLive = Layer.inject(
      Greet,
      { logger: LoggerService, config: AppConfig },
      ({ logger, config }) =>
        (name) => {
          logger.log(`greeting ${name}`);
          return `${name}@${config.dbUrl}`;
        },
    );
    const wired = Layer.provideTo(
      GreetLive,
      Layer.merge(
        Layer.value(LoggerService, { log: (m) => logs.push(m) }),
        Layer.value(AppConfig, { dbUrl: "postgres://localhost/app" }),
      ),
    );

    const ctx = (await Layer.build(wired)).unwrap();

    expect(ctx.get(Greet)("ada")).toBe("ada@postgres://localhost/app");
    expect(logs).toEqual(["greeting ada"]);
  });

  it("an empty record needs nothing", async () => {
    const ConstGreet = Layer.inject(Greet, {}, () => (name) => `hi ${name}`);

    const ctx = (await Layer.build(ConstGreet)).unwrap();

    expect(ctx.get(Greet)("bob")).toBe("hi bob");
  });

  it("a throw in the factory becomes a Defect (build resolves, never rejects)", async () => {
    const Boom = Layer.inject(Greet, {}, (): ((name: string) => string) => {
      throw new Error("inject boom");
    });

    const result = await Layer.build(Boom);

    expect(result.isDefect()).toBe(true);
  });

  it("the ctx argument is a legal forkScope parent", async () => {
    class Seq extends Tag("InjectSeq")<Seq, { readonly n: number }>() {}
    let count = 0;
    const SeqLive = Layer.make(Seq, (): Result<{ readonly n: number }, never> => {
      count += 1;
      return Ok({ n: count });
    });

    class Forker extends Tag("Forker")<Forker, () => AsyncResult<number, never>>() {}
    const ForkerLive = Layer.inject(
      Forker,
      { logger: LoggerService },
      (_deps, ctx) => () =>
        Layer.forkScope(ctx, SeqLive, (req): Result<number, never> => Ok(req.get(Seq).n)),
    );

    const wired = Layer.provideTo(ForkerLive, Layer.value(LoggerService, { log: () => {} }));
    const forker = (await Layer.build(wired)).unwrap().get(Forker);

    expect((await forker()).unwrap()).toBe(1);
    expect((await forker()).unwrap()).toBe(2); // fresh instance per fork
  });

  it("records exact needs for introspection (kind inject, solid edges)", () => {
    const GreetLive = Layer.inject(Greet, { logger: LoggerService }, ({ logger }) => (name) => {
      logger.log(name);
      return name;
    });
    const wired = Layer.provideTo(GreetLive, Layer.value(LoggerService, { log: () => {} }));

    const graph = Layer.describe(wired);

    expect(graph.nodes.find((n) => n.key === "Greet")?.kind).toBe("inject");
    expect(graph.edges).toContainEqual({ from: "Greet", to: "LoggerService", inferred: false });
    // exact edge → NOT dashed in DOT
    expect(Layer.toDot(wired)).toContain('"Greet" -> "LoggerService";');
  });
});
```

- [ ] **Step 2: Run the runtime tests to verify they fail**

Run: `pnpm --filter demesne exec vitest run -t "Layer.inject"`
Expected: FAIL — `Layer.inject is not a function` (TypeError) in every test of the block.

- [ ] **Step 3: Write the failing type-level tests**

Append to `packages/core/src/demesne.test-d.ts` (end of file):

```ts
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
```

- [ ] **Step 4: Run the type tests to verify they fail**

Run: `pnpm --filter demesne exec tsc --noEmit -p tsconfig.test-d.json`
Expected: FAIL — `Property 'inject' does not exist on type ...` (several occurrences).

- [ ] **Step 5: Implement `inject`**

In `packages/core/src/index.ts`:

(a) Extend `LayerMeta`'s exact-needs branch — change:

```ts
  | { readonly kind: "class" | "service"; readonly key: string; readonly needs: readonly string[] }
```

to:

```ts
  | {
      readonly kind: "class" | "service" | "inject";
      readonly key: string;
      readonly needs: readonly string[];
    }
```

(b) Add the constructor directly AFTER the `fromService` implementation (after its closing `};`):

```ts
// Build a service by injecting a RECORD of dependencies into a plain function — the
// FUNCTION-shaped injection sugar beside `Layer.class` (tag list → constructor) and
// `Service` (fused class). The record IS the boundary declaration: `Needs` is the union of
// its tags' identities (nothing is inferred from usage), and — being runtime-known — it
// gives `inject` EXACT introspection edges, like `class` / `Service` and unlike `factory`.
// `f` also receives the typed context; it exists to serve as a `forkScope` parent (an
// injected service, e.g. an HTTP app, opens request scopes from it) and is typed by the
// same record-derived `Needs`, so it adds no undeclared capability. Sync and infallible
// like `factory`: `f` runs inside `.map`, so a throw becomes a `Defect`; `E = never`.
const inject = <Self, Service, const R extends Record<string, Tag<any, any>>>(
  tag: Tag<Self, Service>,
  deps: R,
  f: (deps: InjectedOf<R>, ctx: Context<NeedsOfRecord<R>>) => Service,
): Layer<Self, never, NeedsOfRecord<R>> => ({
  build: (ctx) =>
    Ok<void>(undefined)
      .toAsync()
      .map(() => {
        const injected: Record<string, unknown> = {};
        for (const key of Object.keys(deps)) {
          injected[key] = (ctx as Context<any>).get(deps[key] as Tag<any, any>);
        }
        return unsafeAdd(
          emptyAny(),
          tag.key,
          f(injected as InjectedOf<R>, ctx as Context<NeedsOfRecord<R>>),
        );
      }),
  meta: {
    kind: "inject",
    key: tag.key,
    needs: Object.values(deps).map((t) => (t as Tag<any, any>).key),
  },
});
```

(c) Add `inject,` to the `Layer` namespace object, after `fromService,`:

```ts
  fromService,
  inject,
  merge,
```

(d) Update the two stale comments: in the introspection header block (~line 544) change `Edges are EXACT for value / class / Service` to `Edges are EXACT for value / class / Service / inject`; in the `Layer` namespace doc comment change the constructor list `(`value`/`factory`/`make`/`acquireRelease`/`member`/`class`)` to include `inject` and mention it as the record-injection sugar.

(e) Also update the `LayerMeta` doc comment (~line 151): `\`value\` (none), \`class\` / \`service\` (the dep list)`→`\`value\` (none), \`class\` / \`service\` / \`inject\` (the dep list / record)`.

- [ ] **Step 6: Run all core tests and typechecks to verify they pass**

Run: `pnpm --filter demesne test && pnpm --filter demesne typecheck`
Expected: all vitest tests PASS (51 = 46 existing + 5 new), both tsc runs clean.

- [ ] **Step 7: Lint, format, commit**

```bash
pnpm lint && pnpm format
git add packages/core/src/index.ts packages/core/src/demesne.spec.ts packages/core/src/demesne.test-d.ts
git commit -m "feat(core): add Layer.inject (record-injection for function-shaped services)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Spec (CLAUDE.md) + changeset

**Files:**

- Modify: `CLAUDE.md` (invariants #7, #9, #15; roadmap section)
- Create: `.changeset/layer-inject.md`

**Interfaces:**

- Consumes: `Layer.inject` semantics from Task 1 (already merged in the working tree).
- Produces: nothing code-level; the spec text later tasks' comments must not contradict.

- [ ] **Step 1: Update invariant #7**

In `CLAUDE.md`, change the intro line:

```
Plus two **constructor-injection sugars** over `factory` — they remove the hand-written
```

to:

```
Plus three **injection sugars** over `factory` — they remove the hand-written
```

Then add this bullet after the `Service<Self>()(id, {deps})` bullet (before the sentence `Do **not** make ...` inside that bullet ends — i.e. as a NEW list item after the Service bullet's closing `both. _(Guarded by ...)_`):

```
- **`Layer.inject(tag, {deps}, f)`** — the **function-shaped** sugar: builds ANY value
  (typically a closure — a one-method use case) by injecting a **deps record** into a plain
  function. `f` receives the resolved record AND the typed `Context` — the context parameter
  exists to serve as a `forkScope` parent (an injected HTTP app opening request scopes) and
  is typed by the record-derived `Needs`, so it adds no undeclared capability. Sync and
  infallible like `factory` (`E = never`; a throw is a `Defect`) — do **not** make it
  fallible or collapse it into a value-or-Result overload. The record IS the boundary
  declaration (invariant #2), and being runtime-known it gives `inject` **exact**
  introspection edges (invariant #15). _(Guarded by the spec: record resolution, empty
  record, throw → Defect, ctx-as-fork-parent, exact edges. And the type-level tests: `Needs`
  union from the record, ctx typing, return-shape rejection.)_
```

- [ ] **Step 2: Update invariants #9 and #15**

In invariant #9's namespace enumeration, change:

```
fromService,merge,provideTo,collect,onStart,onStop,describe,toDot,build,scoped,forkScope}` and
```

to:

```
fromService,inject,merge,provideTo,collect,onStart,onStop,describe,toDot,build,scoped,forkScope}` and
```

In invariant #15, change:

```
edges are **exact** for `value` / `class` / `Service` (their `needs` keys are known at runtime)
```

to:

```
edges are **exact** for `value` / `class` / `Service` / `inject` (their `needs` keys are known at runtime)
```

- [ ] **Step 3: Update the roadmap section**

In the `## Roadmap` paragraph listing implemented items, extend the constructor-injection entry:

```
`Layer.class` / `Service` (constructor injection, see invariant #7);
```

to:

```
`Layer.class` / `Service` / `Layer.inject` (constructor / record injection, see invariant #7);
```

- [ ] **Step 4: Create the changeset**

Create `.changeset/layer-inject.md`:

```markdown
---
"demesne": minor
---

`Layer.inject` — record-based injection for function-shaped services, and a full-DI example.

- **`Layer.inject(tag, {deps}, f)`** builds any value (typically a closure — a one-method
  use case) by injecting a deps record into a plain function: no interactor class, no
  hand-annotated `Context<...>`, no `ctx.get` lines. It is the function-shaped sugar beside
  `Layer.class` (tag list → constructor) and `Service` (fused class): sync and infallible
  like `factory` (a throw becomes a `Defect`), with `Needs` declared by the record. The
  record is runtime-known, so `inject` layers get **exact** edges in `Layer.describe` /
  `Layer.toDot`. `f` also receives the typed context, which serves as a `forkScope` parent —
  an injected service (e.g. an HTTP app) can open per-request scopes.
- **Example overhaul (`examples/hono-prisma-api`)**: one-method use cases are now
  function-shaped tags built with `inject`; the Hono app is an injected `HttpApp` service; a
  middleware opens a `forkScope` per request (fresh `RequestId` + request-tagged logger,
  `x-request-id` response header); and the HTTP listener is an `acquireRelease` resource, so
  `server.ts` is just `Layer.scoped(AppStarted, waitForShutdown)`.
```

- [ ] **Step 5: Verify nothing broke and commit**

Run: `pnpm oxfmt --check . && pnpm --filter demesne typecheck`
Expected: clean (docs-only change).

```bash
git add CLAUDE.md .changeset/layer-inject.md
git commit -m "docs: spec Layer.inject in CLAUDE.md invariants; add changeset

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Guide docs + README surface lists

**Files:**

- Modify: `docs/guide/layers-and-wiring.md` (constructor-sugar section)
- Modify: `docs/guide/core-concepts.md` ("The two namespaces" enumeration)
- Modify: `README.md` (surface enumeration paragraph)
- Modify: `packages/core/README.md` (operations bullet)

**Interfaces:**

- Consumes: `Layer.inject` signature from Task 1; spec wording from Task 2.

- [ ] **Step 1: Add the `inject` section to layers-and-wiring.md**

Read `docs/guide/layers-and-wiring.md`; find the section documenting `Layer.class` and `Service` (constructor injection). Immediately after it, add (matching the file's heading level for sibling sections):

````markdown
### `Layer.inject` — function-shaped services

Not every service wants to be a class. A one-method use case is morally a function — and
`Layer.inject` builds one from a **deps record**, with no interactor class, no
hand-annotated `Context<...>`, and no `ctx.get` lines:

```ts
class CreateTodo extends Tag("CreateTodo")<
  CreateTodo,
  (input: NewTodo) => AsyncResult<Todo, RepositoryError>
>() {}

const CreateTodoLive = Layer.inject(
  CreateTodo,
  { logger: Logger, todos: TodoRepository },
  ({ logger, todos }) =>
    (input) => {
      logger.info(`creating todo "${input.title}"`);
      return todos.create(input);
    },
);

// call it as a plain function:
const todo = await ctx.get(CreateTodo)(input);
```

The record is the declared boundary — `Needs` is the union of its tags' identities — and
because it is known at runtime, `inject` layers get **exact** edges in `Layer.describe` /
`Layer.toDot` (solid, not dashed). Like `factory`, construction is sync and infallible: a
throw becomes a `Defect`; a fallible or async construction belongs to `Layer.make`.

The factory also receives the typed context as a second argument. Its purpose is to be a
`forkScope` parent — an injected service that handles requests can open a per-request scope
from its own context (see the hono-prisma example's HTTP app). It is typed by the same
record-derived `Needs`, so it grants nothing the record didn't declare.

The three injection sugars, side by side: `Layer.class` injects a **tag list** into a
constructor you may not own; `Service` fuses tag + injected fields into **one class**
declaration; `Layer.inject` injects a **record** into a plain function. Pick by the shape
of the thing you're building.
````

- [ ] **Step 2: Update the three enumerations**

- `docs/guide/core-concepts.md` — in "The two namespaces", the constructors line: add `inject` to the constructors group (`value` / `factory` / `make` / `class` / `fromService` / `inject`), keeping the file's existing phrasing style.
- `README.md` — in the namespaces paragraph (rewritten in the audit PR to the full surface), add `inject` after `fromService` in the `Layer.{...}` enumeration.
- `packages/core/README.md` — in the operations bullet, add `inject` to the constructors group.

- [ ] **Step 3: Verify docs build and formatting, commit**

Run: `pnpm oxfmt --check . && pnpm turbo run build --filter=@demesne/docs`
Expected: format clean; vitepress build succeeds.

```bash
git add docs/guide/layers-and-wiring.md docs/guide/core-concepts.md README.md packages/core/README.md
git commit -m "docs: document Layer.inject beside the other injection sugars

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Example — function-shaped use cases

**Files:**

- Modify: `examples/hono-prisma-api/src/application/create-todo.ts` (full rewrite)
- Modify: `examples/hono-prisma-api/src/application/list-todos.ts` (full rewrite)
- Modify: `examples/hono-prisma-api/src/http/routes.ts` (3 call sites only)
- Test: existing `examples/hono-prisma-api/src/app.test.ts` (must stay green unchanged)

**Interfaces:**

- Consumes: `Layer.inject` from Task 1.
- Produces: `CreateTodo` tag whose service is `(input: NewTodo) => AsyncResult<Todo, RepositoryError>`; `ListTodos` tag whose service is `() => AsyncResult<readonly Todo[], RepositoryError>`; `CreateTodoLive` / `ListTodosLive` layers with `Needs = Logger | TodoRepository`. Tasks 6–7 call them as plain functions. `GetTodo` (Service class, `.execute(id)`) is unchanged.

- [ ] **Step 1: Rewrite create-todo.ts**

Replace the entire content of `examples/hono-prisma-api/src/application/create-todo.ts`:

```ts
// Application — the "create todo" use case, FUNCTION-shaped: the tag's service IS the
// function type, and `Layer.inject` builds it from a deps record — no interactor class, no
// hand-written factory, no `ctx.get`. The record declares the boundary (requirements are
// declared, never inferred), and call sites invoke it directly: `ctx.get(CreateTodo)(input)`.

import { Layer, Tag } from "demesne";
import type { AsyncResult } from "unthrown";

import type { NewTodo, RepositoryError, Todo } from "../domain/todo.js";
import { Logger, TodoRepository } from "./ports.js";

export class CreateTodo extends Tag("CreateTodo")<
  CreateTodo,
  (input: NewTodo) => AsyncResult<Todo, RepositoryError>
>() {}

export const CreateTodoLive = Layer.inject(
  CreateTodo,
  { logger: Logger, todos: TodoRepository },
  ({ logger, todos }) =>
    (input) => {
      logger.info(`creating todo "${input.title}"`);
      return todos.create(input);
    },
);
```

- [ ] **Step 2: Rewrite list-todos.ts**

Replace the entire content of `examples/hono-prisma-api/src/application/list-todos.ts`:

```ts
// Application — the "list todos" use case, function-shaped like create-todo.ts. Contrast
// with get-todo.ts (`Service`): reach for a class when the service has state or several
// methods; a one-method use case is just a function built from its ports.

import { Layer, Tag } from "demesne";
import type { AsyncResult } from "unthrown";

import type { RepositoryError, Todo } from "../domain/todo.js";
import { Logger, TodoRepository } from "./ports.js";

export class ListTodos extends Tag("ListTodos")<
  ListTodos,
  () => AsyncResult<readonly Todo[], RepositoryError>
>() {}

export const ListTodosLive = Layer.inject(
  ListTodos,
  { logger: Logger, todos: TodoRepository },
  ({ logger, todos }) =>
    () => {
      logger.info("listing todos");
      return todos.list();
    },
);
```

- [ ] **Step 3: Update the three call sites in routes.ts**

In `examples/hono-prisma-api/src/http/routes.ts` (routes are fully rewritten in Task 6; this keeps the build green now):

- `ctx.get(ListTodos).execute()` → `ctx.get(ListTodos)()`
- `ctx.get(GetTodo).execute(c.req.param("id"))` → unchanged (GetTodo stays a Service)
- `ctx.get(CreateTodo).execute(body.data)` → `ctx.get(CreateTodo)(body.data)`

- [ ] **Step 4: Run the example suite to verify it passes**

Run: `pnpm turbo run typecheck test --filter=@demesne-examples/hono-prisma-api`
Expected: typecheck clean, all 9 tests PASS. (No new tests here — behavior is unchanged; the shape change is proven by compilation and the existing HTTP tests.)

- [ ] **Step 5: Commit**

```bash
git add examples/hono-prisma-api/src/application/create-todo.ts examples/hono-prisma-api/src/application/list-todos.ts examples/hono-prisma-api/src/http/routes.ts
git commit -m "refactor(example): function-shaped use cases via Layer.inject

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Example — request scope module

**Files:**

- Create: `examples/hono-prisma-api/src/http/request.ts`
- Modify: `examples/hono-prisma-api/src/app.test.ts` (replace the ad-hoc `forkScope` test — its local `RequestId` tag id would collide with the new real one)

**Interfaces:**

- Consumes: `Logger` port from `application/ports.ts`; `Layer.inject` from Task 1.
- Produces: `RequestId` tag (service `{ readonly id: string }`), `RequestLogger` tag (service = `ServiceOf<Logger>`), `RequestScopeLive: Layer<RequestId | RequestLogger, never, Logger>` — Task 6's middleware forks with it.

- [ ] **Step 1: Write the failing test**

In `examples/hono-prisma-api/src/app.test.ts`, REPLACE the test `"forkScope layers a per-request scope on the built app"` (keep the surrounding `describe("combinators on the same app", ...)`) with:

```ts
it("request scope: fresh RequestId per fork, request-tagged logger", async () => {
  const lines: string[] = [];
  const parent = (
    await Layer.build(Layer.value(Logger, { info: (msg) => lines.push(msg) }))
  ).unwrap();

  const idOf = async (): Promise<string> =>
    (
      await Layer.forkScope(parent, RequestScopeLive, (ctx): Result<string, never> => {
        ctx.get(RequestLogger).info("hello");
        return Ok(ctx.get(RequestId).id);
      })
    ).unwrap();

  const first = await idOf();
  const second = await idOf();

  expect(first).not.toBe(second); // fresh instances per fork
  expect(lines).toEqual([`[${first}] hello`, `[${second}] hello`]);
});
```

And add the imports at the top of the file:

```ts
import { Logger } from "./application/ports.js";
import { RequestId, RequestLogger, RequestScopeLive } from "./http/request.js";
```

(The replaced test's `Tag` import — and possibly the `GetTodo` import, which only the replaced test used — may become unused; remove whichever tsc flags.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @demesne-examples/hono-prisma-api exec vitest run -t "request scope"`
Expected: FAIL — cannot resolve `./http/request.js` (module does not exist).

- [ ] **Step 3: Create http/request.ts**

```ts
// HTTP request scope — services that live for ONE request. The routes middleware builds
// them with `Layer.forkScope` off the app context per request (see routes.ts), so every
// request gets a fresh RequestId and a logger that stamps it on every line; the fork
// closes when the request ends. RequestLogger reads BOTH a parent service (Logger) and a
// sibling request service (RequestId) — the fork context sees both.

import { Layer, type ServiceOf, Tag } from "demesne";

import { Logger } from "../application/ports.js";

export class RequestId extends Tag("RequestId")<RequestId, { readonly id: string }>() {}

// Same shape as the Logger port — handlers use it exactly like the app logger.
export class RequestLogger extends Tag("RequestLogger")<RequestLogger, ServiceOf<Logger>>() {}

const RequestIdLive = Layer.factory(RequestId, () => ({ id: crypto.randomUUID() }));

const RequestLoggerLive = Layer.inject(
  RequestLogger,
  { base: Logger, req: RequestId },
  ({ base, req }) => ({ info: (msg) => base.info(`[${req.id}] ${msg}`) }),
);

// One const, shared by reference: RequestIdLive builds ONCE per fork and is exposed
// alongside the wrapped logger (`provideTo` alone would provide only RequestLogger; the
// middleware also reads RequestId for the x-request-id header). Needs = Logger, provided
// by the fork's parent context.
export const RequestScopeLive = Layer.merge(
  RequestIdLive,
  Layer.provideTo(RequestLoggerLive, RequestIdLive),
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @demesne-examples/hono-prisma-api exec vitest run -t "request scope"`
Expected: PASS.

- [ ] **Step 5: Run the full example suite, commit**

Run: `pnpm turbo run typecheck test --filter=@demesne-examples/hono-prisma-api`
Expected: clean and green (9 tests — one replaced).

```bash
git add examples/hono-prisma-api/src/http/request.ts examples/hono-prisma-api/src/app.test.ts
git commit -m "feat(example): request-scoped RequestId + RequestLogger for forkScope

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Example — `HttpApp` as an injected service, per-request middleware

**Files:**

- Modify: `examples/hono-prisma-api/src/http/routes.ts` (full rewrite)
- Modify: `examples/hono-prisma-api/src/bootstrap.ts` (wire `HttpAppLive`)
- Modify: `examples/hono-prisma-api/src/app.test.ts` (`buildTestApp` reads `HttpApp` from the context; new `x-request-id` test)

**Interfaces:**

- Consumes: `CreateTodo` / `ListTodos` (function-shaped, Task 4), `GetTodo` (Service, `.execute(id)`), `AuditSinks` (`readonly { name; record(event) }[]`), `Logger`, `RequestId` / `RequestLogger` / `RequestScopeLive` (Task 5), `Layer.inject` (Task 1).
- Produces: `HttpApp` tag (service `Hono<RequestEnv>`), `HttpAppLive` with `Needs = ListTodos | GetTodo | CreateTodo | AuditSinks | Logger`; `bootstrap(...)` now also provides `HttpApp`. Task 7's server layer reads `ctx.get(HttpApp).fetch`.

- [ ] **Step 1: Write the failing tests**

In `examples/hono-prisma-api/src/app.test.ts`:

(a) Replace the `buildTestApp` helper and drop the `buildRoutes` import:

```ts
// The app is a SERVICE now: bootstrap wires HttpAppLive, so tests read it from the context.
const buildTestApp = async () => (await Layer.build(fakeApp())).unwrap().get(HttpApp);
```

with import `import { HttpApp } from "./http/routes.js";` (and remove `import { buildRoutes } from "./http/routes.js";` and the now-unused `import type { Hono } from "hono";` — change `call`'s parameter type to `Awaited<ReturnType<typeof buildTestApp>>`):

```ts
const call = async (
  app: Awaited<ReturnType<typeof buildTestApp>>,
  path: string,
  init?: RequestInit,
) => {
  const res = await app.request(path, init);
  return { status: res.status, body: (await res.json()) as unknown };
};
```

(b) Add a new test inside `describe("todos api (HTTP)", ...)`:

```ts
it("every response carries a fresh x-request-id (per-request forkScope)", async () => {
  const app = await buildTestApp();

  const first = await app.request("/todos");
  const second = await app.request("/todos");

  expect(first.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
  expect(first.headers.get("x-request-id")).not.toBe(second.headers.get("x-request-id"));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @demesne-examples/hono-prisma-api exec vitest run`
Expected: FAIL — `routes.js` has no export `HttpApp` (compile/import error).

- [ ] **Step 3: Rewrite routes.ts**

Replace the entire content of `examples/hono-prisma-api/src/http/routes.ts`:

```ts
// HTTP edge — the Hono app is ITSELF a demesne service. `Layer.inject` builds it from the
// use cases + audit sinks + logger (the record is its declared dependency list — no more
// hand-maintained `Context<...>` annotation), and the injected `ctx` is the forkScope
// parent for the per-request scope: a middleware forks `RequestScopeLive` around every
// request — fresh RequestId, request-tagged logger, x-request-id response header — and the
// fork closes when the request ends. Handlers map unthrown Results to responses with
// `.match`: ok → 200/201, a domain `TodoNotFound` → 404, any other modeled error → 500,
// and a defect (an unmodeled throw) → 500. zod validates the request body.

import type { Context as DemesneContext } from "demesne";
import { Layer, Tag } from "demesne";
import { Hono } from "hono";
import { fromPromise, TaggedError } from "unthrown";
import { z } from "zod";

import { CreateTodo } from "../application/create-todo.js";
import { GetTodo } from "../application/get-todo.js";
import { ListTodos } from "../application/list-todos.js";
import { AuditSinks } from "../application/plugins.js";
import { Logger } from "../application/ports.js";
import { RequestId, RequestLogger, RequestScopeLive } from "./request.js";

const CreateTodoBody = z.object({ title: z.string().min(1).max(200) });

// What the scope middleware exposes to handlers: the forked per-request context.
type RequestEnv = {
  Variables: { scope: DemesneContext<Logger | RequestId | RequestLogger> };
};

// A handler rejection crossing the fork boundary, qualified into the fork's error union.
class RequestFailed extends TaggedError("RequestFailed")<{ cause: unknown }> {}

export class HttpApp extends Tag("HttpApp")<HttpApp, Hono<RequestEnv>>() {}

// `logger` sits in the record for the FORK PARENT, not for direct use: RequestScopeLive
// needs Logger, and the fork's parent is this layer's own ctx — so Logger must be in the
// declared record for the fork to type-check.
export const HttpAppLive = Layer.inject(
  HttpApp,
  { list: ListTodos, get: GetTodo, create: CreateTodo, audit: AuditSinks, logger: Logger },
  ({ list, get, create, audit }, ctx) => {
    const app = new Hono<RequestEnv>();

    // Per-request scope: fork off the app context, hand the forked context to handlers,
    // stamp the response with the request id, close the fork after `next`.
    app.use(async (c, next) => {
      const out = await Layer.forkScope(ctx, RequestScopeLive, (reqCtx) => {
        c.set("scope", reqCtx);
        c.header("x-request-id", reqCtx.get(RequestId).id);
        return fromPromise(next(), (cause) => new RequestFailed({ cause }));
      });
      if (!out.isOk()) return c.json({ error: "internal error" }, 500);
    });

    app.get("/todos", async (c) => {
      c.get("scope").get(RequestLogger).info("GET /todos");
      return (await list()).match<Response>({
        ok: (todos) => c.json(todos),
        err: (error) => c.json({ error: error._tag }, 500),
        defect: () => c.json({ error: "internal error" }, 500),
      });
    });

    app.get("/todos/:id", async (c) => {
      const id = c.req.param("id");
      c.get("scope").get(RequestLogger).info(`GET /todos/${id}`);
      return (await get.execute(id)).match<Response>({
        ok: (todo) => c.json(todo),
        err: (error) =>
          error._tag === "TodoNotFound"
            ? c.json({ error: "todo not found" }, 404)
            : c.json({ error: error._tag }, 500),
        defect: () => c.json({ error: "internal error" }, 500),
      });
    });

    app.post("/todos", async (c) => {
      const body = CreateTodoBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) {
        return c.json(
          { error: "invalid body", issues: body.error.issues.map((i) => i.message) },
          400,
        );
      }
      c.get("scope").get(RequestLogger).info(`POST /todos "${body.data.title}"`);
      return (await create(body.data)).match<Response>({
        ok: (todo) => {
          // fan the event out to every audit sink (the multi-binding collection)
          for (const sink of audit) sink.record({ action: "create", detail: todo.id });
          return c.json(todo, 201);
        },
        err: (error) => c.json({ error: error._tag }, 500),
        defect: () => c.json({ error: "internal error" }, 500),
      });
    });

    return app;
  },
);
```

- [ ] **Step 4: Wire HttpAppLive in bootstrap.ts**

In `examples/hono-prisma-api/src/bootstrap.ts`, add the import:

```ts
import { HttpAppLive } from "./http/routes.js";
```

and change the function body to:

```ts
export const bootstrap = <R extends Layer<TodoRepository, unknown, unknown>>(repository: R) => {
  // the audit collection reads Logger (its console sink); discharge that need up front
  const audit = Layer.provideTo(AuditSinksLive, LoggerLive);
  // the use cases each need Logger + TodoRepository — feed both in. GetTodo is a `Service`;
  // ListTodos / CreateTodo are function-shaped `Layer.inject` layers.
  const useCases = Layer.merge(ListTodosLive, GetTodoLive, CreateTodoLive);
  const useCasesWired = Layer.provideTo(useCases, Layer.merge(LoggerLive, repository));
  // the HTTP app is itself a service: inject the wired use cases, the audit collection,
  // and the Logger (which is also the fork parent for the per-request scope).
  const httpWired = Layer.provideTo(HttpAppLive, Layer.merge(useCasesWired, audit, LoggerLive));
  // expose everything; shared layers (LoggerLive, the repository, the wired use cases)
  // build once (memoized by reference).
  return Layer.merge(LoggerLive, audit, repository, useCasesWired, httpWired);
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm turbo run typecheck test --filter=@demesne-examples/hono-prisma-api`
Expected: typecheck clean; all tests PASS (10: 9 previous + the x-request-id test). The audit-sink and 404 tests prove the handlers still behave identically through the injected app.

- [ ] **Step 6: Commit**

```bash
git add examples/hono-prisma-api/src/http/routes.ts examples/hono-prisma-api/src/bootstrap.ts examples/hono-prisma-api/src/app.test.ts
git commit -m "feat(example): HttpApp as an injected service with per-request forkScope

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Example — HTTP listener as a resource; app/server composition

**Files:**

- Create: `examples/hono-prisma-api/src/http/server.ts`
- Modify: `examples/hono-prisma-api/src/app.ts` (compose `HttpServerLive`)
- Modify: `examples/hono-prisma-api/src/server.ts` (full rewrite — shrink to scoped + wait)
- Modify: `examples/hono-prisma-api/src/app.test.ts` (new listener integration test)

**Interfaces:**

- Consumes: `HttpApp` (Task 6), `AppConfig` (service is the zod `Env`: `{ DATABASE_URL: string; PORT: number; LOG_LEVEL: ... }`), `Logger`, `bootstrap(...)`, `AppStarted`/`AppLayer` in app.ts.
- Produces: `HttpServer` tag (service `{ readonly port: number; readonly server: ServerType }` — the handle is carried so release can close it), `HttpServerLive: Layer<HttpServer, ListenError, HttpApp | AppConfig | Logger | Scope>`; `AppLayer` in app.ts now includes the listener.

- [ ] **Step 1: Write the failing integration test**

Add to `examples/hono-prisma-api/src/app.test.ts`, inside `describe("combinators on the same app", ...)`. Note `use` must return a `Result`/`AsyncResult` — the raw `fetch` promise is qualified with `fromSafePromise`:

```ts
it("the HTTP listener is a resource: serves inside the scope, closed after", async () => {
  // PORT 0 → the OS assigns a free port; the acquired service reports the real one.
  const TestConfig = Layer.value(AppConfig, {
    DATABASE_URL: "postgres://unused",
    PORT: 0,
    LOG_LEVEL: "info",
  });
  const boot = fakeApp();
  const withServer = Layer.merge(
    boot,
    Layer.provideTo(HttpServerLive, Layer.merge(boot, TestConfig)),
  );

  let url = "";
  const out = await Layer.scoped(withServer, (ctx) => {
    url = `http://127.0.0.1:${ctx.get(HttpServer).port}`;
    return fromSafePromise(fetch(`${url}/todos`).then((res) => res.status));
  });

  expect(out.unwrap()).toBe(200);
  // the scope has closed → the listener is released and the port refuses connections
  await expect(fetch(`${url}/todos`)).rejects.toThrow();
});
```

New imports needed at the top of app.test.ts:

```ts
import { fromSafePromise } from "unthrown"; // extend the existing unthrown import
import { AppConfig } from "./config/env.js";
import { HttpServer, HttpServerLive } from "./http/server.js";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @demesne-examples/hono-prisma-api exec vitest run -t "listener is a resource"`
Expected: FAIL — cannot resolve `./http/server.js`.

- [ ] **Step 3: Create http/server.ts**

Note the service shape carries the `server` handle alongside the port: `acquireRelease`'s release receives the ACQUIRED service, so the service must carry what release needs to close.

```ts
// HTTP listener as a RESOURCE: acquire starts the Node server and resolves once it is
// actually listening (reporting the real port — PORT 0 works in tests); release closes
// it. Because it is an `acquireRelease`, the graph carries `Scope`: the listener can
// never leak past `Layer.scoped` — shutdown closes it in LIFO order with the database.

import { serve, type ServerType } from "@hono/node-server";
import { type Context, Layer, Tag } from "demesne";
import { fromPromise, TaggedError } from "unthrown";

import { Logger } from "../application/ports.js";
import { AppConfig } from "../config/env.js";
import { HttpApp } from "./routes.js";

export class HttpServer extends Tag("HttpServer")<
  HttpServer,
  { readonly port: number; readonly server: ServerType }
>() {}

export class ListenError extends TaggedError("ListenError")<{ cause: unknown }> {}

export const HttpServerLive = Layer.acquireRelease(
  HttpServer,
  (ctx: Context<HttpApp | AppConfig | Logger>) =>
    fromPromise(
      new Promise<{ readonly port: number; readonly server: ServerType }>((resolve, reject) => {
        const server = serve(
          { fetch: ctx.get(HttpApp).fetch, port: ctx.get(AppConfig).PORT },
          (info) => {
            ctx.get(Logger).info(`listening on http://localhost:${info.port}`);
            resolve({ port: info.port, server });
          },
        );
        server.once("error", reject); // e.g. EADDRINUSE → modeled ListenError
      }),
      (cause) => new ListenError({ cause }),
    ),
  ({ server }) => new Promise<void>((resolve) => server.close(() => resolve())),
);
```

- [ ] **Step 4: Compose the server in app.ts**

In `examples/hono-prisma-api/src/app.ts`, add the import:

```ts
import { HttpServerLive } from "./http/server.js";
```

and replace:

```ts
export const AppLayer = bootstrap(PrismaRepository);
```

with:

```ts
// `boot` bound once and shared by reference: the merge keeps the bootstrap provisions
// (AppConfig for the port, Database for the health check, HttpApp) visible alongside the
// listener, and the shared reference builds everything once.
const boot = bootstrap(PrismaRepository);
export const AppLayer = Layer.merge(boot, Layer.provideTo(HttpServerLive, boot));
```

(Keep the `AppStarted = Layer.onStart(AppLayer, ...)` health check exactly as is. Update the `//    ^?` type comment above AppLayer if present: it now also provides `HttpApp | HttpServer` and errors also include `ListenError`.)

- [ ] **Step 5: Rewrite server.ts**

Replace the entire content of `examples/hono-prisma-api/src/server.ts`:

```ts
// Entry point — run the assembled graph with `Layer.scoped`: building it connects Prisma,
// starts the HTTP listener (an `acquireRelease` resource), and runs the startup check.
// `use` just waits for a shutdown signal; when it resolves, the scope closes and teardown
// runs LIFO — the listener stops accepting, then Prisma disconnects. Every startup failure
// is a static union handled once, below.

import { Layer } from "demesne";
import { fromSafePromise } from "unthrown";

import { AppStarted } from "./app.js";
import { Logger } from "./application/ports.js";

const waitForShutdown = (): Promise<void> =>
  new Promise((resolve) => {
    const shutdown = (): void => {
      console.log("shutting down…");
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

const outcome = await Layer.scoped(AppStarted, (ctx) => {
  ctx.get(Logger).info("todos api ready");
  return fromSafePromise(waitForShutdown());
});

// The scope has closed here — listener closed, Prisma disconnected — whether startup
// failed or the server was stopped.
outcome.match({
  ok: () => console.log("bye"),
  err: (error) =>
    console.error(
      error._tag === "ConfigError"
        ? `config invalid: ${error.issues}`
        : error._tag === "MigrationError"
          ? `startup check failed: ${String(error.cause)}`
          : error._tag === "ListenError"
            ? `could not listen: ${String(error.cause)}`
            : `database unreachable: ${String(error.cause)}`,
    ),
  defect: (cause) => console.error(`panic: ${String(cause)}`),
});
```

- [ ] **Step 6: Run the full example suite to verify everything passes**

Run: `pnpm turbo run typecheck test --filter=@demesne-examples/hono-prisma-api`
Expected: typecheck clean; all tests PASS (11: previous 10 + the listener test). The listener test proves acquire (real socket, real port), use-inside-scope, and release (connection refused after).

- [ ] **Step 7: Commit**

```bash
git add examples/hono-prisma-api/src/http/server.ts examples/hono-prisma-api/src/app.ts examples/hono-prisma-api/src/server.ts examples/hono-prisma-api/src/app.test.ts
git commit -m "feat(example): HTTP listener as an acquireRelease resource; scoped entry point

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Example README + full-repo verification

**Files:**

- Modify: `examples/hono-prisma-api/README.md` (architecture description)
- Verify: whole repo

**Interfaces:**

- Consumes: everything above; no new exports.

- [ ] **Step 1: Update the example README**

Read `examples/hono-prisma-api/README.md` and update its architecture/walkthrough prose to match the new shape (keep the file's existing style and length):

- Use cases: `ListTodos` / `CreateTodo` are **function-shaped** (`Layer.inject` from a deps record; called as `ctx.get(CreateTodo)(input)`); `GetTodo` stays a `Service` — state or several methods is when a class earns its keep.
- The HTTP edge is in the DI: `HttpApp` (the Hono app) is an injected service; a middleware opens a `Layer.forkScope` per request (fresh `RequestId`, request-tagged `RequestLogger`, `x-request-id` header); the listener is an `acquireRelease` resource (`HttpServerLive`), so shutdown closes it LIFO with Prisma.
- `server.ts` is: `Layer.scoped(AppStarted, waitForShutdown)`.
- Remove/replace any sentence describing `buildRoutes(ctx)` or `Layer.class` interactors.

- [ ] **Step 2: Optional sanity render of the graph**

Run: `pnpm --filter @demesne-examples/hono-prisma-api exec tsx -e "import { AppLayer } from './src/app.js'; import { Layer } from 'demesne'; console.log(Layer.toDot(AppLayer))"`
Expected: DOT output where `HttpApp` has SOLID edges to `ListTodos`/`GetTodo`/`CreateTodo`/`AuditSinks`/`Logger` (inject = exact) and `HttpServer` is a dashed box (resource). Paste the interesting lines into the README if it has a graph section; otherwise just confirm and move on.

- [ ] **Step 3: Full-repo verification**

Run: `pnpm turbo run build typecheck test && pnpm lint && pnpm oxfmt --check . && pnpm knip && (cd packages/core && pnpm check:package)`
Expected: every task green; lint/format/knip clean; publint + attw clean.

- [ ] **Step 4: Commit**

```bash
git add examples/hono-prisma-api/README.md
git commit -m "docs(example): describe the full-DI shape (inject use cases, HttpApp, listener resource)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
