# @btravstack/start-kernel

> Incubating. The process spine of **btravstack start** — the config layer and lifecycle
> host every transport (api / amqp / temporal) reuses. See `design/btravstack-start*.md`
> at the repo root for the full design.

demesne does the wiring, unthrown carries the errors, and 12-factor falls out of building
your app as a demesne graph. This package promotes the reusable spine out of the
`hono-prisma-api` example.

## What's here

- **`defineConfig(schema)`** — factor III. Reads a source (default `process.env`) through a
  zod schema, once, at the edge. Returns a demesne `Config` tag + its layer; a parse failure
  is a modeled `ConfigError`, never a throw.

  ```ts
  export const { Config, ConfigLive } = defineConfig(
    z.object({
      DATABASE_URL: z.string().startsWith("postgres"),
      PORT: z.coerce.number().int().positive().default(3000),
    }),
  );
  ```

- **`runHost(app, opts?)`** — factor IX. Builds a `Layer<P, E, Scope>` with `Layer.scoped`,
  runs `use` (default: block until `SIGINT`/`SIGTERM`), then closes the scope so finalizers
  run LIFO. Requires `Needs = Scope` and nothing more — a missing service is a compile error.

  ```ts
  await runHost(AppLayer, { onReady: (ctx) => ctx.get(Logger).info("ready") });
  ```

- **The transport seam** — `defineContract` (zod I/O boundary), `handler` / `handler.use`
  (bind a contract to a demesne-injected edge), `runHandler` (the per-invocation
  fork → validate → dispatch every host reuses), and `DispositionMap` / `dispatch` (the
  total domain-error → transport-disposition map). See
  `design/btravstack-start-handler-binding.md`, and the `start-api` / `start-amqp` /
  `start-temporal` hosts that build on it.

  ```ts
  const contract = defineContract({ input: TitleSchema, output: TodoSchema });
  const create = handler.use(contract, CreateTodo, (todo, input) => todo(input));
  ```

## Not here yet

A formal `Host` interface — deferred until it earns its keep; each host currently exposes its
own builder (`createHttpApp` / `createConsumer` / `createActivities`) over `runHandler` +
`DispositionMap`, which turned out to be all the shared seam a host needs.
