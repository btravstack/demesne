# API Reference

This reference is generated from the source with
[TypeDoc](https://typedoc.org/) at build time.

## Packages

- [**demesne**](./core/) — the core `Tag` / `Context` / `Layer` / `Scope` types, the
  `ServiceOf` helper, the `Layer.value` / `Layer.factory` / `Layer.make` /
  `Layer.acquireRelease` / `Layer.member` / `Layer.class` constructors, the `Layer.merge` /
  `Layer.provideTo` / `Layer.collect` / `Layer.onStart` / `Layer.onStop` combinators, and
  the terminals `Layer.build` / `Layer.scoped` /
  `Layer.forkScope` (plus `Context.empty` and the `Service` self-injecting service base).

`Context` and `Layer` are each both a **type** and a **value** (the companion-object
pattern): `Context<R>` / `Context.empty()`, `Layer<P, E, N>` / `Layer.make(...)`.
`Tag` and `Service` are top-level — `Tag` names a service (building neither); `Service`
mints a self-injecting service class (a `Tag` plus a `.layer`).
