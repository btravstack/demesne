---
"demesne": minor
---

Require `unthrown` `^2.0.0` as a peer dependency (was `^1.0.0`). demesne's own API and
behavior are unchanged — the unthrown surface it builds on (`Ok` / `Err` / `allAsync` /
`fromPromise` / `fromSafePromise` / `TaggedError`, plus the `Result` / `AsyncResult`
combinators) is identical in 2.0.0 — but consumers must now be on unthrown 2.x.
