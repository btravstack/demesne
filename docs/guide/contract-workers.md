# Contract Workers

The btravstack contract libraries —
[amqp-contract](https://github.com/btravstack/amqp-contract) (message consumers / RPC
servers) and [temporal-contract](https://github.com/btravstack/temporal-contract)
(activity workers) — share one context model: a **`createContext` factory** seeds a
per-invocation context, and an **accumulating middleware chain** narrows it on the way
to the handler. Neither library ships a container; the seed and the middleware are
yours to implement.

demesne is the designed engine for that seam: `Layer.scoped` holds the **worker
singletons**, `Layer.forkScope` opens the **per-message / per-activity scope**, and
because both libraries already speak unthrown `AsyncResult`s, the two compose with
**zero adapters**. (The mechanics of `scoped` / `forkScope` live in
[Resources & Scopes](./resources-and-scopes); this page is the integration recipe.)

## 1. Worker singletons: `Layer.scoped` around the worker's lifetime

Build the app graph **once** at startup. Connections are `acquireRelease` resources,
topology assertions / migrations are `onStart` hooks, graceful shutdown is `onStop` —
so the graph carries `Scope`, and the compiler forces the whole worker to run inside
`Layer.scoped`. The worker's lifetime IS the `use` callback:

```ts
import { Layer } from "demesne";
import { fromSafePromise } from "unthrown";

// AppLayer: Logger, the domain ports, use cases, and the broker/Temporal connection
// as an acquireRelease — exactly the shape of the hono-prisma example's AppLayer.
const outcome = await Layer.scoped(AppStarted, (appCtx) => {
  const worker = createWorker(appCtx); // below — amqp or temporal
  return fromSafePromise(waitForShutdown(worker));
});
// scope closed: worker drained, then connections released, LIFO
```

A failed connection, a failed `onStart` topology check — every construction failure is
one static union on `outcome`, handled once (see
[Errors at the Edge](./errors-at-the-edge)).

## 2. Per-message scope: `forkScope` as the middleware

The per-invocation services — a correlation-id logger, a per-message transaction, a
unit-of-work — are a **request layer** forked off the built app context. The
middleware seam is where the fork belongs, because middleware _brackets_ the handler:
the fork opens, `next` runs inside it, and the fork's resources release (LIFO) when
the handler finishes — success or failure.

With **amqp-contract** (`@amqp-contract/worker`):

```ts
import {
  composeMiddleware,
  defineMiddleware,
  type EmptyContext,
  TypedAmqpWorker,
} from "@amqp-contract/worker";
import { type Context, Layer } from "demesne";

// What handlers see: the forked per-message context.
type MessageScope = { scope: Context<Logger | MessageId | Txn> };

const createWorker = (appCtx: Context<AppServices>) => {
  // MessageScopeLive: MessageId (factory), a tagged logger (inject), Txn (acquireRelease) —
  // the same shape as the hono-prisma example's RequestScopeLive.
  const messageScope = defineMiddleware<EmptyContext, MessageScope>((_args, next) =>
    Layer.forkScope(appCtx, MessageScopeLive, (msgCtx) => next({ context: { scope: msgCtx } })),
  );

  return TypedAmqpWorker.create({
    contract,
    middleware: composeMiddleware(messageScope /* , auth, timing, … */),
    handlers: {
      // Zero adapters: the handler reads a wired use case and returns its AsyncResult.
      createTodo: ({ payload }, _raw, { scope }) => scope.get(CreateTodo)(payload),
    },
    urls,
  });
};
```

Three properties make this composition exact:

- **The error channels line up.** `next(...)` returns an `AsyncResult`, `forkScope`'s
  `use` must return one — they are the same call. If `MessageScopeLive` is infallible
  (`factory` / `inject` layers), the fork adds `never` to the union and the middleware's
  type is **unchanged**. If it is fallible (a `Txn` whose `begin` can fail), the build
  error joins the union and you triage it right there —
  `.mapErr((e) => e._tag === "@app/TxnError" ? retryable("txn open failed") : e)` —
  the same retry/DLQ vocabulary as any handler error.
- **The fork brackets the handler.** The transaction opened for the message is released
  (LIFO) when the handler resolves, whether it returned `Ok`, `Err`, or panicked —
  `forkScope` closes on every path. One message, one fork; the next message forks fresh
  instances.
- **The parent never tears down.** The fork releases only what `MessageScopeLive`
  acquired; the pool, the connection, the singleton use cases stay alive for the next
  message.

## 3. Per-activity scope: the same fork, Temporal-shaped

**temporal-contract** (`@temporal-contract/worker`) has the identical seam —
`declareActivitiesHandler` takes a `createContext` seed and a contract-aware middleware
chain operating on the `AsyncResult` inside the validation boundary:

```ts
import {
  declareActivitiesHandler,
  defineActivityMiddleware,
  type EmptyContext,
} from "@temporal-contract/worker/activity";
import { type Context, Layer } from "demesne";

// What activities see: the forked per-invocation context (ActivityScopeLive's provisions).
type ActivityScope = { scope: Context<Logger | Txn> };

const createWorker = (appCtx: Context<AppServices>) => {
  const activityScope = defineActivityMiddleware<EmptyContext, ActivityScope>((_invocation, next) =>
    Layer.forkScope(appCtx, ActivityScopeLive, (actCtx) => next({ context: { scope: actCtx } })),
  );

  return declareActivitiesHandler({
    contract,
    middleware: [activityScope],
    activities: {
      chargePayment: (args, { context: { scope } }) => scope.get(ChargePayment)(args),
    },
  });
};
```

`createContext` (on both libraries) stays available for **resource-free** seeding —
`createContext: () => ({ scope: appCtx })` hands handlers the singletons directly when
nothing is per-invocation. The moment something must be _released_ after the handler
(a transaction, a lease), it belongs in the middleware fork: `createContext` only
creates, middleware brackets.

## 4. Testing: the same seam as everywhere else

The test story is the
[bootstrap pattern](./layers-and-wiring#testing-parameterize-the-graph-by-its-dependencies): the
worker graph is a `bootstrap(repository)` composition, so a test builds the same
handlers against an in-memory fake — no broker, no Temporal server — and drives them
through the contract library's own test harness. The fork still opens per invocation;
the fake still sees every consumer that captured the port.

## Positioning: an optional peer, on purpose

The contract libraries do **not** depend on demesne — `createContext` and the
middleware are plain functions, and you can seed them with a hand-rolled object.
demesne is the _recommended_ provider once the graph is worth wiring: requirements and
construction errors become compile-time unions, connections become scoped resources,
and the per-invocation lifetime becomes a fork the compiler won't let you leak. The
integration lives entirely in your composition root; neither library imports the
other.
