---
"demesne": minor
---

Export a `ServiceOf<T>` type helper. A tag's type is its nominal identity (deliberately
distinct from the service shape, so two structurally identical services never collide),
so a signature that needs the shape by name — a constructor parameter, a port type —
recovers it with `ServiceOf`. It accepts either the tag instance type
(`ServiceOf<Logger>`) or the tag value's type (`ServiceOf<typeof Logger>`), removing the
need to redefine the helper in every project.
