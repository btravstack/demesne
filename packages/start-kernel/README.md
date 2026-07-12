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

## Not here yet

The transport seam — `Host`, `defineContract`, `handler` (see
`design/btravstack-start-kernel-api.md` and `-handler-binding.md`). This package is the
config + lifecycle core those build on.
