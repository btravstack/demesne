// The Temporal host's dispatch core: a builder that turns (contract + handler + disposition map)
// activities into an `ActivityRegistry` service — a record of activity functions ready for a
// Temporal worker (`new Worker({ activities: registry.activities, … })`). Each function runs a
// message through the kernel's `runHandler` and, on failure, throws a `TemporalActivityFailure`
// carrying the retryability the disposition map chose; a real worker adapter maps that to
// `ApplicationFailure.create({ nonRetryable })`. This is the amqp/api analog on the activity side.
//
// Determinism note: this package integrates demesne on the ACTIVITY side only. Activities do I/O —
// that is their job — so a normal demesne-wired use case is exactly right here. WORKFLOWS must be
// deterministic; they orchestrate by calling activity proxies and are handed no demesne context,
// so I/O can't reach them — determinism by construction, no `Deterministic` marker needed. See the
// package README.
//
// Triage: Ok → return the output. A kernel `ContractError` (bad input) → non-retryable (a retry
// can't fix it). A domain error → the route's TOTAL map. An unmapped tag or request-scope build
// error → retryable (assume transient infra). A defect (a thrown bug) → non-retryable.

import {
  type BoundHandler,
  ContractError,
  dispatch,
  type DispositionMap,
  runHandler,
} from "@btravstack/start-kernel";
import { type Context, Layer, type Scope, Tag } from "demesne";

import { type TemporalDisposition, temporal } from "./disposition.js";

// The error an activity function throws to signal failure to the Temporal worker. `retryable`
// drives whether Temporal's policy retries; a real adapter maps `!retryable` to a non-retryable
// `ApplicationFailure`.
export class TemporalActivityFailure extends Error {
  readonly retryable: boolean;
  readonly reason: string;
  constructor(opts: { readonly retryable: boolean; readonly reason: string }) {
    super(opts.reason);
    this.name = "TemporalActivityFailure";
    this.retryable = opts.retryable;
    this.reason = opts.reason;
  }
}

type ActivityFn = (input: unknown) => Promise<unknown>;

export class ActivityRegistry extends Tag("@btravstack/start-temporal/ActivityRegistry")<
  ActivityRegistry,
  { readonly activities: Readonly<Record<string, ActivityFn>> }
>() {}

export type ActivitySpec<Parent, ReqP, In, Out, E extends { readonly _tag: string }> = {
  readonly name: string;
  readonly handler: BoundHandler<Parent | ReqP, In, Out, E>;
  readonly errors: DispositionMap<E, TemporalDisposition>;
};

export type ActivitiesBuilder<Parent, ReqP, RErr> = {
  readonly activity: <In, Out, E extends { readonly _tag: string }>(
    spec: ActivitySpec<Parent, ReqP, In, Out, E>,
  ) => ActivitiesBuilder<Parent, ReqP, RErr>;
  readonly build: () => Layer<ActivityRegistry, never, Parent>;
};

type Registration<Parent> = (ctx: Context<Parent>, activities: Record<string, ActivityFn>) => void;

const asFailure = (disposition: TemporalDisposition): TemporalActivityFailure =>
  new TemporalActivityFailure(
    disposition.kind === "nonRetryable"
      ? { retryable: false, reason: disposition.reason }
      : { retryable: true, reason: "retryable" },
  );

// `createActivities<AppServices>()(requestLayer)` — curried exactly like the other hosts (Parent
// explicit, ReqP/RErr inferred), for the same reason.
export const createActivities =
  <Parent>() =>
  <ReqP, RErr>(
    requestLayer: Layer<ReqP, RErr, Parent | Scope>,
  ): ActivitiesBuilder<Parent, ReqP, RErr> => {
    const registrations: Registration<Parent>[] = [];

    const builder: ActivitiesBuilder<Parent, ReqP, RErr> = {
      activity: (spec) => {
        registrations.push((ctx, activities) => {
          activities[spec.name] = async (input) => {
            const result = await runHandler(ctx, requestLayer, spec.handler, input);
            return result.match({
              ok: (output) => output,
              err: (error) => {
                if (error instanceof ContractError) {
                  throw asFailure(temporal.nonRetryable(`invalid input: ${error.issues}`));
                }
                const tagged = error as { readonly _tag: string };
                if (Object.hasOwn(spec.errors, tagged._tag)) {
                  // `E` isn't nameable in this non-generic method; widen to the erased map shape
                  // (membership already checked, so dispatch won't throw).
                  throw asFailure(
                    dispatch(
                      spec.errors as unknown as DispositionMap<
                        { readonly _tag: string },
                        TemporalDisposition
                      >,
                      tagged,
                    ),
                  );
                }
                throw asFailure(temporal.retryable());
              },
              defect: () => {
                throw asFailure(temporal.nonRetryable("defect"));
              },
            });
          };
        });
        return builder;
      },
      build: () =>
        Layer.factory(ActivityRegistry, (ctx: Context<Parent>) => {
          const activities: Record<string, ActivityFn> = {};
          for (const register of registrations) register(ctx, activities);
          return { activities };
        }),
    };

    return builder;
  };
