---
"demesne": minor
---

`merge` is now variadic: it accepts any number of independent layers
(`merge(a, b, c, …)`, at least one) instead of exactly two, unioning `Provides`,
the error channel, and `Needs` across all of them. They still build in parallel,
and existing two-argument calls are unchanged.
