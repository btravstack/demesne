---
"demesne": patch
---

Duplicate-id guard fixed to match its spec, demesne-branded runtime internals, and dual-format sourcemaps.

- **Duplicate `Tag` id guard: warn once, strip cleanly.** The guard now warns exactly **once
  per repeated id** (it previously re-warned on every mint after the first), and the
  `process.env.NODE_ENV` check moved **inside the call with dot access** so bundler
  define-replacement folds the whole body out of production builds (the previous bracket
  access, `process.env["NODE_ENV"]`, defeated esbuild/Vite/webpack replacement — and the
  `typeof process === "undefined"` fallback left production **browser** bundles permanently
  in dev mode). The id registry is now allocated lazily, so importing the module has no side
  effects; environments without a `process` global are silent.
- **`demesne/*` runtime branding.** The internal brand symbols were still registered as
  `Symbol.for("mini-di/…")` (the library's pre-fork name), and the absent-service error read
  `mini-di: service … not found in context`. Both now say `demesne`. Note the global-registry
  keys changed: a dependency tree mixing this version with an older copy no longer shares
  brand identity with it.
- **`BuildState` exported as a type.** It appears in `Layer`'s public `build` property
  signature, so a hand-written `{ build }` layer needs to be able to name it. Type-only —
  instances are still created only by the build terminals.
- **CJS sourcemap.** The build now emits sourcemaps for **both** formats (`index.cjs.map` was
  missing; only the ESM map shipped).
