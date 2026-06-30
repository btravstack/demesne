// Adapter — env-backed configuration. `AppConfig` is an infrastructure-only tag
// (not an application port); `ConfigError` surfaces in the wiring error union.

import { Layer, Tag } from "demesne";
import { Err, Ok, TaggedError } from "unthrown";

export class AppConfig extends Tag("AppConfig")<AppConfig, { readonly dbUrl: string }>() {}

export class ConfigError extends TaggedError("ConfigError")<{ reason: string }> {}

// Sync but fallible. The service shape comes from the tag and the error type is
// inferred from the `Err` you return, so neither is annotated.
export const ConfigLive = Layer.make(AppConfig, () => {
  const url = "postgres://localhost/app"; // from env in real code
  return url.startsWith("postgres://")
    ? Ok({ dbUrl: url })
    : Err(new ConfigError({ reason: "DATABASE_URL must be a postgres:// url" }));
});
