# API Reference

This reference is generated from the source with
[TypeDoc](https://typedoc.org/) at build time.

## Packages

- [**demesne**](./core/) — the core `Tag` / `Context` / `Layer` types, the
  `ServiceOf` helper, the `Layer.value` / `Layer.factory` / `Layer.make`
  constructors, the `Layer.merge` / `Layer.provideTo` combinators, the terminal
  `Layer.build`, and `Context.empty`.

`Context` and `Layer` are each both a **type** and a **value** (the companion-object
pattern): `Context<R>` / `Context.empty()`, `Layer<P, E, N>` / `Layer.make(...)`.
`Tag` is top-level — it names a service, building neither.
