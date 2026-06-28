# demesne

> Type-safe dependency injection — the wiring sibling of
> [`unthrown`](https://github.com/btravstack/unthrown). A container holds your
> services' domain (a typed `Context`) and provides it; requirements and construction
> errors are tracked in the type system.

```sh
pnpm add demesne unthrown
```

```ts
import { build, make, Tag } from "demesne";
import { Err, Ok, type Result, TaggedError } from "unthrown";

// The class IS the tag; the service shape is inlined.
class AppConfig extends Tag("AppConfig")<AppConfig, { readonly dbUrl: string }>() {}

// Recover the inlined shape by name when a signature wants it.
type ServiceOf<T> = T extends Tag<unknown, infer S> ? S : never;

class ConfigError extends TaggedError("ConfigError")<{ reason: string }> {}

const ConfigLive = make(AppConfig, (): Result<ServiceOf<typeof AppConfig>, ConfigError> => {
  const url = "postgres://localhost/app";
  return url.startsWith("postgres://")
    ? Ok({ dbUrl: url })
    : Err(new ConfigError({ reason: "DB_URL must be a postgres:// url" }));
});

const result = await build(ConfigLive);
//    ^? Result<Context<AppConfig>, ConfigError>

const dbUrl = result.match({
  ok: (ctx) => ctx.get(AppConfig).dbUrl,
  err: (e) => `config failed: ${e.reason}`,
  defect: (cause) => `panic: ${String(cause)}`,
});
```

- **Requirements as a static union** — you cannot `build` until every dependency is
  wired (`Needs = never`).
- **Errors as a static union** — every way construction can fail is in the result
  type, handled once at the edge as an `unthrown` `AsyncResult`.
- **`Tag` / `Context` / `Layer`** with `value` / `factory` / `make` constructors and
  `merge` / `provideTo` / `build` combinators.
- `unthrown` is a peer dependency; demesne does the wiring, `unthrown` the errors.

See the [project README](https://github.com/btravstack/demesne#readme) for the full
guide, design notes, and roadmap.

## License

[MIT](../../LICENSE) © Benoit TRAVERS
