import { defineContract, handler } from "@btravstack/start-kernel";
import { Layer, type ServiceOf, Tag } from "demesne";
import { type AsyncResult, Err, Ok, TaggedError } from "unthrown";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { amqp } from "./disposition.js";
import { createConsumer, MessageRouter } from "./router.js";

// --- fixtures: a Repo port + a CreateTodo use case (same shape as the other hosts) -------------

type Todo = { readonly id: string; readonly title: string };

class RepoError extends TaggedError("@test/RepoError", { name: "RepoError" })<{
  readonly cause: string;
}> {}

class Repo extends Tag("@test/Repo")<
  Repo,
  { readonly create: (title: string) => AsyncResult<Todo, RepoError> }
>() {}

class CreateTodo extends Tag("@test/CreateTodo")<
  CreateTodo,
  (title: string) => AsyncResult<Todo, RepoError>
>() {}

const CreateTodoLive = Layer.inject(CreateTodo, { repo: Repo }, ({ repo }) => repo.create);

class RequestId extends Tag("@test/RequestId")<RequestId, { readonly id: string }>() {}
const RequestIdLive = Layer.factory(RequestId, () => ({ id: "req-1" }));

const contract = defineContract({
  input: z.object({ title: z.string().min(1) }),
  output: z.object({ id: z.string(), title: z.string() }),
});

const buildRouter = async (
  create: (title: string) => AsyncResult<Todo, RepoError>,
): Promise<ServiceOf<MessageRouter>> => {
  const repo = Layer.value(Repo, { create });
  const parent = Layer.merge(repo, Layer.provideTo(CreateTodoLive, repo));

  const routerLayer = createConsumer<Repo | CreateTodo>()(RequestIdLive)
    .consume({
      queue: "todos.create",
      handler: handler.use(contract, CreateTodo, (fn, input) => fn(input.title)),
      errors: {
        "@test/RepoError": (error) =>
          error.cause === "transient" ? amqp.requeue() : amqp.deadLetter("permanent"),
      },
    })
    .build();

  const built = await Layer.build(Layer.provideTo(routerLayer, parent));
  return built.match({
    ok: (ctx) => ctx.get(MessageRouter),
    err: () => {
      throw new Error("unexpected build error");
    },
    defect: (cause) => {
      throw cause;
    },
  });
};

describe("MessageRouter dispatch triage", () => {
  it("acks a successfully handled message", async () => {
    const router = await buildRouter((title) => Ok({ id: "t1", title }).toAsync());
    expect(await router.dispatch("todos.create", { title: "buy milk" })).toEqual({ kind: "ack" });
  });

  it("dead-letters a malformed message (ContractError — permanent)", async () => {
    const router = await buildRouter((title) => Ok({ id: "t1", title }).toAsync());
    expect(await router.dispatch("todos.create", { title: "" })).toMatchObject({
      kind: "deadLetter",
    });
  });

  it("requeues a transient domain error via the disposition map", async () => {
    const router = await buildRouter(() => Err(new RepoError({ cause: "transient" })).toAsync());
    expect(await router.dispatch("todos.create", { title: "x" })).toEqual({ kind: "requeue" });
  });

  it("dead-letters a permanent domain error via the disposition map", async () => {
    const router = await buildRouter(() => Err(new RepoError({ cause: "fatal" })).toAsync());
    expect(await router.dispatch("todos.create", { title: "x" })).toEqual({
      kind: "deadLetter",
      reason: "permanent",
    });
  });

  it("dead-letters a message for a queue with no consumer", async () => {
    const router = await buildRouter((title) => Ok({ id: "t1", title }).toAsync());
    expect(await router.dispatch("unknown.queue", {})).toMatchObject({
      kind: "deadLetter",
      reason: expect.stringContaining("no consumer"),
    });
  });
});
