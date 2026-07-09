// HTTP request scope — services that live for ONE request. The routes middleware builds
// them with `Layer.forkScope` off the app context per request (see routes.ts), so every
// request gets a fresh RequestId and a logger that stamps it on every line; the fork
// closes when the request ends. RequestLogger reads BOTH a parent service (Logger) and a
// sibling request service (RequestId) — the fork context sees both.

import { Layer, type ServiceOf, Tag } from "demesne";

import { Logger } from "../application/ports.js";

export class RequestId extends Tag("RequestId")<RequestId, { readonly id: string }>() {}

// Same shape as the Logger port — handlers use it exactly like the app logger.
export class RequestLogger extends Tag("RequestLogger")<RequestLogger, ServiceOf<Logger>>() {}

const RequestIdLive = Layer.factory(RequestId, () => ({ id: crypto.randomUUID() }));

const RequestLoggerLive = Layer.inject(
  RequestLogger,
  { base: Logger, req: RequestId },
  ({ base, req }) => ({ info: (msg) => base.info(`[${req.id}] ${msg}`) }),
);

// One const, shared by reference: RequestIdLive builds ONCE per fork and is exposed
// alongside the wrapped logger (`provideTo` alone would provide only RequestLogger; the
// middleware also reads RequestId for the x-request-id header). Needs = Logger, provided
// by the fork's parent context.
export const RequestScopeLive = Layer.merge(
  RequestIdLive,
  Layer.provideTo(RequestLoggerLive, RequestIdLive),
);
