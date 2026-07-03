// Application — a plugin collection (multi-binding). Several audit sinks are accumulated into
// one `readonly AuditSink[]` service with `Layer.member` + `Layer.collect`, so the HTTP edge
// can fan a "todo created" event out to every one without knowing them individually.

import { type Context, Layer, Tag } from "demesne";

import { Logger } from "./ports.js";

export type AuditEvent = { readonly action: string; readonly detail: string };

// The item shape stays a named type; the tag names the *collection*.
type AuditSink = { readonly name: string; readonly record: (event: AuditEvent) => void };

export class AuditSinks extends Tag("AuditSinks")<AuditSinks, readonly AuditSink[]>() {}

// One contribution, built from the port it needs (the Logger). `member` mirrors `factory`:
// synchronous and infallible, providing the collection tag with a single item. It reads the
// Logger at build time (capturing the value), so `wire` defers this member a round until the
// Logger is available — no `provideTo` needed.
const ConsoleAuditLive = Layer.member(AuditSinks, (ctx: Context<Logger>) => {
  const logger = ctx.get(Logger);
  return {
    name: "console",
    record: (event) => logger.info(`audit ${event.action}: ${event.detail}`),
  };
});

// Another contribution, self-contained.
const InMemoryAuditLive = Layer.member(AuditSinks, () => {
  const events: AuditEvent[] = [];
  return { name: "in-memory", record: (event) => void events.push(event) };
});

// collect concatenates every member into the AuditSinks array (in listed order), unioning
// their requirements — so this layer needs the Logger the console sink reads.
export const AuditSinksLive = Layer.collect(AuditSinks, [ConsoleAuditLive, InMemoryAuditLive]);
