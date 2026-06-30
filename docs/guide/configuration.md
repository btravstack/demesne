# Configuration

Reading config from the environment and validating it is the most common fallible
construction in a real app — and it's just a **fallible `Layer.make`** fed by a schema.
demesne adds **no** config primitive of its own (that would break "does one thing:
wiring"). The schema → `Result` bridge already lives in unthrown's ecosystem; demesne
only wires the validated result.

## With `@unthrown/standard-schema`

[`@unthrown/standard-schema`](https://github.com/btravstack/unthrown/tree/main/packages/standard-schema)
turns any [Standard Schema](https://standardschema.dev/) (Zod, Valibot, ArkType, …) into
an `unthrown` `Result`. Compose it inside `Layer.make`.

Inject the raw environment as a **port** rather than reaching for `process.env` inside
the layer — it keeps config testable (a fake env in tests, the real one at the edge) and
is the boundary-declared style demesne favours.

```ts
import { type Context, Layer, Tag } from "demesne";
import { fromSchema, type SchemaIssues } from "@unthrown/standard-schema";
import { type Result, TaggedError } from "unthrown";
import { z } from "zod"; // any Standard Schema validator

// The raw environment is a provided port.
class Env extends Tag("Env")<Env, Record<string, string | undefined>>() {}

const ConfigSchema = z.object({ dbUrl: z.string().url() });
class AppConfig extends Tag("AppConfig")<AppConfig, z.infer<typeof ConfigSchema>>() {}

// A modeled, discriminated error for the E channel (nicer at the edge than a raw
// issues array). Drop the `mapErr` if `SchemaIssues` is fine for you.
class ConfigError extends TaggedError("ConfigError")<{ issues: SchemaIssues }> {}

const AppConfigLive = Layer.make(AppConfig, (ctx: Context<Env>) =>
  fromSchema(ConfigSchema)(ctx.get(Env)).mapErr((issues) => new ConfigError({ issues })),
);
//    ^? Layer<AppConfig, ConfigError, Env>

// Wire the env at the composition edge.
const result = await Layer.build(Layer.provideTo(AppConfigLive, Layer.value(Env, process.env)));
//    ^? Result<Context<AppConfig>, ConfigError>
```

Use `fromSchemaAsync` instead if your schema validates asynchronously — it returns an
`AsyncResult`, which `Layer.make` accepts unchanged.

## Where sugar belongs

If you find yourself repeating this trio, it promotes cleanly into a thin
`@demesne/standard-schema` adapter package (the monorepo is built to grow that way) —
but it does **not** belong in the core.
