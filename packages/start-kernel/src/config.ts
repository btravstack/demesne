// defineConfig — factor III in one call. Reads a source (defaults to `process.env`) through a
// zod schema, at the edge, ONCE, and returns a demesne Tag plus its layer. A parse failure
// becomes a modeled `ConfigError` in the wiring error union — never a thrown exception. This is
// the promotion of the example's `config/env.ts`: zod and unthrown meet where `safeParse`'s
// discriminated result is lifted into `Layer.make`.
//
// Invariant K1 — config is read once and injected, never ambient. Business code injects the
// returned `Config` tag; it never touches `process.env`. The whole source object is handed to
// zod, so no property is read off an index signature.

import { Layer, Tag, type TagClass } from "demesne";
import { Err, Ok, type Result, TaggedError } from "unthrown";
import type { z } from "zod";

import { formatIssues } from "./internal/zod.js";

// The nominal identity a config tag carries in a Context's requirement union `R`. There is one
// config per app, so a fixed brand (rather than a per-call unique type) is correct: a second
// `defineConfig` in the same process is a mistake, and the fixed runtime key makes demesne's
// duplicate-id guard warn about it in development.
declare const ConfigBrand: unique symbol;
export type ConfigTag<A> = { readonly [ConfigBrand]: A };

const CONFIG_KEY = "@btravstack/start/Config";

export class ConfigError extends TaggedError("@btravstack/start/ConfigError", {
  name: "ConfigError",
})<{
  readonly issues: string;
}> {}

export type ConfigModule<A> = {
  /** Inject this tag wherever config is needed; `ctx.get(Config)` yields the parsed `A`. */
  readonly Config: TagClass<ConfigTag<A>, typeof CONFIG_KEY, A>;
  /** The layer that parses the source into `A`; fails with `ConfigError`, needs nothing. */
  readonly ConfigLive: Layer<ConfigTag<A>, ConfigError, never>;
};

export const defineConfig = <S extends z.ZodType>(
  schema: S,
  opts?: { readonly source?: Record<string, string | undefined> },
): ConfigModule<z.infer<S>> => {
  const Config = Tag(CONFIG_KEY)<ConfigTag<z.infer<S>>, z.infer<S>>();
  const source = opts?.source;

  const ConfigLive = Layer.make(Config, (): Result<z.infer<S>, ConfigError> => {
    const parsed = schema.safeParse(source ?? process.env);
    if (parsed.success) return Ok(parsed.data);
    return Err(new ConfigError({ issues: formatIssues(parsed.error) }));
  });

  return { Config, ConfigLive };
};
