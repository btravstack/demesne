// runHost — the process loop (factor IX, disposability). Promotes the example's `server.ts`:
// given a fully-assembled `Layer<P, E, Scope>` (the transport's resource layer already merged
// in), it builds the graph once with `Layer.scoped`, runs `use`, then closes the scope so every
// finalizer (`acquireRelease` / `onStop`) runs in reverse order — whether `use` resolved, failed,
// or the build failed partway. The default `use` blocks until a shutdown signal, which is the
// long-lived-server case; teardown then runs on SIGINT/SIGTERM.
//
// Invariant K2 — the scope's lifetime IS `use`; there is no open/hold/close handle.
// Invariant K3 — `runHost` requires `Needs = Scope` and nothing more; a still-unmet service is a
// compile error at the call, never a boot-time throw. It never calls `Layer.build` (a resource
// graph carries `Scope`, which `build` rejects) — only `scoped`, which discharges it.

import { type Context, Layer, type Scope } from "demesne";
import { type AsyncResult, fromSafePromise, type Result } from "unthrown";

const DEFAULT_SIGNALS = ["SIGINT", "SIGTERM"] as const satisfies readonly NodeJS.Signals[];

export type RunHostOptions<P, A, E2> = {
  /** What to do with the built context. Default: block until a shutdown signal (`A = void`). */
  readonly use?: (ctx: Context<P>) => Result<A, E2> | AsyncResult<A, E2>;
  /** Signals that resolve the default `use`. Default: `["SIGINT", "SIGTERM"]`. */
  readonly signals?: readonly NodeJS.Signals[];
  /** Ran after the graph is built (post-`onStart`), before `use` — e.g. a readiness log line. */
  readonly onReady?: (ctx: Context<P>) => void;
};

const waitForShutdown = (signals: readonly NodeJS.Signals[]): Promise<void> =>
  new Promise<void>((resolve) => {
    const shutdown = (): void => resolve();
    for (const signal of signals) process.once(signal, shutdown);
  });

export const runHost = <P, E, A = void, E2 = never>(
  app: Layer<P, E, Scope>,
  opts?: RunHostOptions<P, A, E2>,
): AsyncResult<A, E | E2> => {
  const signals = opts?.signals ?? DEFAULT_SIGNALS;
  const use = opts?.use;
  const onReady = opts?.onReady;

  return Layer.scoped(app, (ctx): Result<A, E2> | AsyncResult<A, E2> => {
    onReady?.(ctx);
    if (use !== undefined) return use(ctx);
    // Default path only: with no `use`, `A` is `void` and `E2` is `never`, so the wait's
    // `AsyncResult<void, never>` fits `AsyncResult<A, E2>`. The cast covers the unreachable
    // case where a caller supplied a custom `use` (this branch is dead then).
    return fromSafePromise(waitForShutdown(signals)) as unknown as AsyncResult<A, E2>;
  });
};
