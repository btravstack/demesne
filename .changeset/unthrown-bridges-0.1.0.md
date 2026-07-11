---
---

Example only — no change to the published `demesne` package. Adopt the fixed
`@unthrown/prisma@0.1.0` and `@unthrown/orpc@0.1.0` releases (which now ship
`unthrown: ^4.1.0` correctly) and drop the `pnpm-workspace.yaml` `overrides`
block that worked around the broken `0.0.0` `workspace:^` publishes.
