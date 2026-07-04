---
"demesne": patch
---

Packaging hardening, a duplicate-tag-id guard, and Defect-safety for `factory` / `member`.

- **Duplicate `Tag` id guard.** Two distinct tag classes that share an `Id` are distinct
  types but the same runtime map key, so in a `Context` one would silently read the other's
  service. `Tag` now **warns** (once per id, never throws) when an id repeats — a
  **development-only** aid gated on `process.env.NODE_ENV`, so bundlers strip it and the
  library stays side-effect-free in production.
- **`factory` / `member` capture throws as Defects.** A throw in a `factory` or `member` body
  now becomes a `Defect` (handled at the edge via `.match`) instead of escaping as an
  exception, matching `make` / `acquireRelease`. The `E` channel is unchanged (still `never`).
- **Published surface.** The top-level `types` field now points to `index.d.cts` (correct for
  legacy `node10` CJS resolution; modern resolvers use the `exports` map either way), `files`
  ships `src/index.ts` so the declaration/source maps resolve (and drops the never-built
  `docs`), and `"sideEffects": false` is declared for better tree-shaking. `publint` and
  `@arethetypeswrong/cli` now report a clean surface across every resolution mode.
