---
"demesne": minor
---

Add **`Layer.member`** and **`Layer.collect`** — multi-bindings / plugin collections.

A _collection tag_ is a tag whose service is a `readonly Item[]`. `Layer.member(tag, f)` is a
single contribution — it mirrors `Layer.factory` (synchronous, infallible) and provides the
tag with a one-element array. `Layer.collect(tag, members)` builds every member in parallel
(memoized, first `Err` short-circuits), concatenates their items in listed order (flattening,
so a member may contribute several), and provides the tag with the full array. Errors and
requirements union across members; a foreign tag is a compile error, and an empty member list
is an empty collection.

This is the multi-binding pattern (Guice `@IntoSet`, Angular `multi`) with no runtime
registry — accumulate N implementations of a port (middlewares, health checks, subscribers,
plugins) into one array service. For a fallible or async contribution, use `Layer.make(tag,
…)` returning a one-element array; `collect` accepts any layer that provides the collection
tag.
