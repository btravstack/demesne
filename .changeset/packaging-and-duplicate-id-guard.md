---
"demesne": patch
---

Packaging hardening and a duplicate-tag-id guard.

- **Duplicate `Tag` id guard.** Two distinct tag classes that share an `Id` are distinct
  types but the same runtime map key, so in a `Context` one would silently read the other's
  service. `Tag` now **warns** (once per id, never throws) when an id repeats, catching the
  one runtime-unsound corner of the nominal-tag scheme.
- **Published surface.** The top-level `types` field now points to `index.d.cts` (correct for
  legacy `node10` CJS resolution; modern resolvers use the `exports` map either way), `files`
  ships `src/index.ts` so the declaration/source maps resolve (and drops the never-built
  `docs`), and `"sideEffects": false` is declared for better tree-shaking. `publint` and
  `@arethetypeswrong/cli` now report a clean surface across every resolution mode.
