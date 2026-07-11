// Configuration — parse `process.env` through a zod schema, at the edge, once. The parsed,
// typed config becomes the `AppConfig` service; a parse failure becomes a modeled
// `ConfigError` in the wiring error union (never a thrown exception). This is how zod and
// unthrown meet: `safeParse` returns a discriminated result, which we lift into `Layer.make`.

import { Layer, Tag } from "demesne";
import { Err, Ok, type Result, TaggedError } from "unthrown";
import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().startsWith("postgres"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

export class AppConfig extends Tag("AppConfig")<AppConfig, Env>() {}

export class ConfigError extends TaggedError("@app/ConfigError", { name: "ConfigError" })<{
  issues: string;
}> {}

// Sync but fallible: `Layer.make` lifts the `Result` `safeParse` gives us. The env object
// is passed whole to zod, so no property is read off the `process.env` index signature.
export const ConfigLive = Layer.make(AppConfig, (): Result<Env, ConfigError> => {
  const parsed = EnvSchema.safeParse(process.env);
  if (parsed.success) return Ok(parsed.data);
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return Err(new ConfigError({ issues }));
});
