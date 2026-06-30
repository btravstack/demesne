# Errors at the Edge

demesne tracks failures in two places, one level apart — and both are ordinary
`unthrown` results you handle the same way.

## 1. The wiring union

`Layer.build` returns an `AsyncResult` whose error channel is the **static union of
every construction failure** the graph can produce. Handle it once:

```ts
const wiring = await Layer.build(AppLayer);
//    ^? Result<Context<Logger | OrderRepository>, ConnectionError | ConfigError>

if (wiring.isErr()) {
  const e = wiring.unwrapErr(); // ConnectionError | ConfigError
  console.error(e._tag === "ConfigError" ? `config: ${e.reason}` : `db: ${e.url}`);
}
```

Because the channel is a real union (not `any`), `match` must cover every arm — add a
new fallible `Layer.make` anywhere in the graph and the type forces you to handle its
error too:

```ts
const message = wiring.match({
  ok: (ctx) => ctx.get(Logger).log("wired") ?? "ok",
  err: (e) => (e._tag === "ConfigError" ? `config failed: ${e.reason}` : `db failed: ${e.url}`),
  defect: (cause) => `panic: ${String(cause)}`,
});
```

## 2. Service operations

A wired service's **operations** are unthrown results too. A repository's `findById`
realistically does an async, fallible lookup, so it returns an `AsyncResult` — not a
bare `Order | null`:

```ts
class OrderRepository extends Tag("OrderRepository")<OrderRepository, {
  readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
}>() {}
```

So once the graph is built, you handle a **second** unthrown result, one level down:

```ts
if (wiring.isOk()) {
  const ctx = wiring.unwrap();
  const order = await ctx.get(OrderRepository).findById("order-1");
  console.log(
    order.match({
      ok: (o) => `found ${o.id}`,
      err: (notFound) => `no such order: ${notFound.id}`,
      defect: (cause) => `query panicked: ${String(cause)}`,
    }),
  );
}
```

This separation is the point: **construction errors** (wiring) and **operation errors**
are distinct unions, each handled where it belongs.

## The defect channel

demesne never invents its own panic channel — it inherits `unthrown`'s. A value thrown
during construction (e.g. inside a `Layer.make` body, or a raw `Promise` rejection that
slipped past a combinator) becomes a **`Defect`**: invisible to the type, observable only
via the `defect` handler in `match`. Qualify async work with `fromPromise` /
`fromSafePromise` so real failures stay modeled — see
[Layers & Wiring](./layers-and-wiring#qualify-at-the-boundary).
