import { defineConfig } from "tsdown";

// Core has zero runtime dependencies of its own; `unthrown` is a peer (provided
// by the consumer), so nothing needs to be bundled or externalized explicitly.
// Entry and formats are passed via the build script's CLI flags.
export default defineConfig({});
