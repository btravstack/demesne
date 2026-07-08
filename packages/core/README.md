# demesne

> Type-safe dependency injection — the wiring sibling of
> [`unthrown`](https://github.com/btravstack/unthrown). A container holds your
> services' domain (a typed `Context`) and provides it; requirements and construction
> errors are tracked in the type system.

📖 **[Documentation](https://btravstack.github.io/demesne/)** ·
[API Reference](https://btravstack.github.io/demesne/api/core/)

```sh
pnpm add demesne unthrown
```

```ts
import { Layer, Tag } from "demesne";
import { Err, Ok, type Result, TaggedError } from "unthrown";

// The class IS the tag; the service shape is inlined.
class AppConfig extends Tag("AppConfig")<AppConfig, { readonly dbUrl: string }>() {}

class ConfigError extends TaggedError("ConfigError")<{ reason: string }> {}

// Service comes from the tag; the error type is inferred from the `Err` you return.
const ConfigLive = Layer.make(AppConfig, () => {
  const url = "postgres://localhost/app";
  return url.startsWith("postgres://")
    ? Ok({ dbUrl: url })
    : Err(new ConfigError({ reason: "DB_URL must be a postgres:// url" }));
});
//    ^? Layer<AppConfig, ConfigError, never>

const result = await Layer.build(ConfigLive);
//    ^? Result<Context<AppConfig>, ConfigError>

const dbUrl = result.match({
  ok: (ctx) => ctx.get(AppConfig).dbUrl,
  err: (e) => `config failed: ${e.reason}`,
  defect: (cause) => `panic: ${String(cause)}`,
});
```

- **Requirements as a static union** — you cannot `Layer.build` until every dependency
  is wired (`Needs = never`).
- **Errors as a static union** — every way construction can fail is in the result
  type, handled once at the edge as an `unthrown` `AsyncResult`.
- **`Tag` / `Context` / `Layer`** — operations grouped under `Layer.*` (constructors
  `value` / `factory` / `make` / `class` / `fromService` / `inject`, resources `acquireRelease`,
  multi-bindings `member` / `collect`, lifecycle `onStart` / `onStop`, composition
  `merge` / `provideTo`, introspection `describe` / `toDot`, terminals
  `build` / `scoped` / `forkScope`) and `Context.*` (`empty`). `Tag`, `Service` (a
  self-injecting service class) and the `ServiceOf` helper stay top-level.
- `unthrown` is a peer dependency; demesne does the wiring, `unthrown` the errors.

See the [project README](https://github.com/btravstack/demesne#readme) for the full
guide, design notes, and roadmap.

## License

[MIT](../../LICENSE) © Benoit TRAVERS
