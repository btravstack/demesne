// Factor III in one call: read + validate the environment once, at the edge. `Config` is a
// demesne tag injected wherever config is needed; a parse failure is a modeled `ConfigError`.
import { defineConfig } from "@btravstack/start-kernel";
import { z } from "zod";

export const { Config, ConfigLive } = defineConfig(
  z.object({
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(["debug", "info", "warn"]).default("info"),
  }),
);
