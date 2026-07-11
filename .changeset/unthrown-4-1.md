---
"demesne": minor
---

Require `unthrown` `^4.1.0` as a peer dependency (was `^3.0.0`). demesne's own API and
behavior are unchanged — the unthrown surface it builds on (`Ok` / `Err` / `allAsync` /
`fromPromise` / `fromSafePromise` / `TaggedError`, plus the `Result` / `AsyncResult`
combinators) is identical in 4.1 — but consumers must now be on unthrown 4.1+, which
type-gates `unwrap()` / `unwrapErr()` (compile only when the discarded channel is
`never`) and renames the operator families (`orElse` → `flatMapErr`, `recover` →
`recoverErr`, `unwrap…` → `get…`; the old names survive as deprecated aliases). The
docs, specs and the example now use the 4.1 names, `@unthrown/vitest` matchers, and
org-convention namespaced error tags (`"@app/ConfigError"` with a bare `Error.name`).
