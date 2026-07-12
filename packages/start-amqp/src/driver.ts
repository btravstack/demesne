// The consume loop as a demesne RESOURCE, plus the wire-driver seam. `runConsumer` subscribes the
// `MessageRouter` to a broker via a minimal `AmqpDriver` interface (implemented by a real amqplib
// adapter, or a fake in tests — no broker dependency here) and, being an `acquireRelease`, carries
// `Scope`: subscriptions are cancelled on shutdown (factor IX). Redelivery is expected on AMQP, so
// an optional `IdempotencyStore` dedupes by message id — the concern api never has.

import { type Context, Layer, type Scope, type ServiceOf, Tag } from "demesne";
import { fromPromise, TaggedError } from "unthrown";

import { type AmqpDisposition, amqp } from "./disposition.js";
import { MessageRouter } from "./router.js";

// One delivery handed up from the broker. `messageId` drives idempotent redelivery when present.
export type AmqpDelivery = {
  readonly queue: string;
  readonly messageId?: string;
  readonly body: unknown;
};

export type AmqpSubscription = { readonly cancel: () => Promise<void> };

// The wire seam: subscribe a settle callback to a queue; the driver applies each returned
// disposition (ack / requeue / dead-letter) to the broker. A real amqplib adapter implements this.
export type AmqpDriver = {
  readonly consume: (
    queue: string,
    onDelivery: (delivery: AmqpDelivery) => Promise<AmqpDisposition>,
  ) => Promise<AmqpSubscription>;
};

// A dedupe store for at-least-once redelivery: `seen` reports whether a message id was already
// processed; `record` marks one processed. A real store is Redis/Postgres-backed with a TTL.
export type IdempotencyStore = {
  readonly seen: (messageId: string) => Promise<boolean>;
  readonly record: (messageId: string) => Promise<void>;
};

export class Consumer extends Tag("@btravstack/start-amqp/Consumer")<
  Consumer,
  { readonly queues: readonly string[] }
>() {}

export class ConsumeError extends TaggedError("@btravstack/start-amqp/ConsumeError", {
  name: "ConsumeError",
})<{
  readonly cause: unknown;
}> {}

// Route one delivery: skip (ack) a duplicate, else dispatch and record on success. Total — it
// never rejects, so a driver that calls it without awaiting can't cause an unhandled rejection.
// `router.dispatch` is itself total; the guard here covers a throwing idempotency store (I/O),
// which is treated as transient and requeued.
const deliver = async (
  router: ServiceOf<MessageRouter>,
  delivery: AmqpDelivery,
  store: IdempotencyStore | undefined,
): Promise<AmqpDisposition> => {
  try {
    const id = store !== undefined ? delivery.messageId : undefined;
    if (store !== undefined && id !== undefined && (await store.seen(id))) return amqp.ack();

    const disposition = await router.dispatch(delivery.queue, delivery.body);

    if (store !== undefined && id !== undefined && disposition.kind === "ack") {
      await store.record(id);
    }
    return disposition;
  } catch {
    return amqp.requeue();
  }
};

export const runConsumer = (opts: {
  readonly driver: AmqpDriver;
  readonly queues: readonly string[];
  readonly idempotency?: IdempotencyStore;
}): Layer<Consumer, ConsumeError, MessageRouter | Scope> => {
  // Shared by acquire (fills) and release (drains) — both closures live in this call.
  const subscriptions: AmqpSubscription[] = [];

  return Layer.acquireRelease(
    Consumer,
    (ctx: Context<MessageRouter>) =>
      fromPromise(
        (async (): Promise<{ readonly queues: readonly string[] }> => {
          const router = ctx.get(MessageRouter);
          for (const queue of opts.queues) {
            subscriptions.push(
              await opts.driver.consume(queue, (delivery) =>
                deliver(router, delivery, opts.idempotency),
              ),
            );
          }
          return { queues: opts.queues };
        })(),
        (cause) => new ConsumeError({ cause }),
      ),
    async () => {
      for (const subscription of subscriptions) await subscription.cancel();
    },
  );
};
