import { defineConfig } from "tsdown";

// Core has zero runtime dependencies of its own; `unthrown` is a peer (provided
// by the consumer), so nothing needs to be bundled or externalized explicitly.
// This config is the single source of truth for the build (the `build` / `dev`
// scripts run bare `tsdown`). Sourcemaps ship for BOTH formats — `package.json`'s
// `files` array ships `src/index.ts` specifically to back them.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
