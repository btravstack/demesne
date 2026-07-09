// Infrastructure — the unthrown × Prisma bridge, prototyped as a shareable client
// extension (extracted to a package it would `Prisma.defineExtension` from
// `@prisma/client/extension`; here it uses the generated client's namespace — the same
// machinery). `$extends` adds `try`-prefixed variants of the delegate operations
// ALONGSIDE the raw ones: each returns an unthrown `AsyncResult` whose error channel is
// the set of P-codes THAT operation can produce, mapped to tagged errors — a read cannot
// fail with `UniqueConstraintViolation` in the type. The raw promise methods stay
// available on purpose: they are the escape hatch for batch `$transaction([...])`, which
// needs unexecuted `PrismaPromise`s.

import { type AsyncResult, fromPromise, TaggedError } from "unthrown";

import { Prisma } from "../generated/prisma/client.ts";

// P2002 — a unique constraint was violated; `fields` is the offending column set.
export class UniqueConstraintViolation extends TaggedError("UniqueConstraintViolation")<{
  fields: readonly string[];
  cause: unknown;
}> {}

// P2003 — a foreign key constraint was violated.
export class ForeignKeyViolation extends TaggedError("ForeignKeyViolation")<{ cause: unknown }> {}

// P2025 — a record required by the operation does not exist.
export class RecordNotFound extends TaggedError("RecordNotFound")<{ cause: unknown }> {}

// Everything else — connection drops, unknown P-codes, driver failures. (Validation
// errors land here too; a published package might re-triage those as defects, since a
// malformed query is a programmer bug, not an anticipated outcome.)
export class DriverError extends TaggedError("DriverError")<{ cause: unknown }> {}

export type PrismaQueryError =
  | UniqueConstraintViolation
  | ForeignKeyViolation
  | RecordNotFound
  | DriverError;

// Qualify a Prisma rejection into a tagged error — the runtime half of the bridge.
// Runtime maps the full union; each try-method NARROWS the static type to the codes its
// operation can actually hit.
export const qualifyPrismaError = (cause: unknown): PrismaQueryError => {
  if (cause instanceof Prisma.PrismaClientKnownRequestError) {
    switch (cause.code) {
      case "P2002": {
        const target = cause.meta?.["target"];
        return new UniqueConstraintViolation({
          fields: Array.isArray(target) ? target.map(String) : [],
          cause,
        });
      }
      case "P2003":
        return new ForeignKeyViolation({ cause });
      case "P2025":
        return new RecordNotFound({ cause });
      default:
        break;
    }
  }
  return new DriverError({ cause });
};

// Per-operation error unions — the static half. Reads can only fail in the driver;
// writes add the constraint violations their SQL can raise; `*OrThrow` and mutations of
// a specific record add P2025.
type ReadError = DriverError;
type CreateError = UniqueConstraintViolation | ForeignKeyViolation | DriverError;
type UpdateError = RecordNotFound | UniqueConstraintViolation | ForeignKeyViolation | DriverError;
type DeleteError = RecordNotFound | ForeignKeyViolation | DriverError;

// The untyped runtime call under the typed surface: `getExtensionContext` resolves the
// concrete delegate and the promise is qualified at the boundary, so a raw Promise never
// escapes. Each public method casts the result down to its per-operation payload and
// error union — the same internal-cast-under-typed-surface posture as demesne's core
// (the `$allModels` implementation side is untyped by design; the declared signatures
// carry the safety).
type UntypedDelegate = Record<string, (args?: unknown) => Promise<unknown>>;

const query = (self: unknown, op: string, args?: unknown): AsyncResult<unknown, PrismaQueryError> =>
  fromPromise(
    (Prisma.getExtensionContext(self) as unknown as UntypedDelegate)[op]!(args),
    qualifyPrismaError,
  );

// The rollback sentinel: an `Err` (or defect) inside `$tryTransaction`'s callback is
// thrown so Prisma aborts the transaction, then unwrapped back out on the other side.
class Rollback extends Error {
  constructor(
    readonly carried: unknown,
    readonly wasDefect: boolean,
  ) {
    super("transaction rolled back");
  }
}

// Mirrors Prisma's `ITXClientDenyList` — what an interactive-transaction client cannot
// do — plus `$tryTransaction` itself: nested transactions are not a thing, and the itx
// client has no `$transaction` for the bridge to delegate to.
type TxDenyList =
  | "$connect"
  | "$disconnect"
  | "$on"
  | "$transaction"
  | "$use"
  | "$extends"
  | "$tryTransaction";

export const unthrownPrisma = Prisma.defineExtension({
  name: "unthrown-prisma",
  model: {
    $allModels: {
      // Typing follows Prisma's documented `$allModels` pattern: `this: T` binds the
      // concrete delegate, `Prisma.Exact` checks args, and `Prisma.Result` computes the
      // payload — so `select` / `include` inference survives the wrap.
      tryFindMany<T, A = Record<string, never>>(
        this: T,
        args?: Prisma.Exact<A, Prisma.Args<T, "findMany">>,
      ): AsyncResult<Prisma.Result<T, A, "findMany">, ReadError> {
        return query(this, "findMany", args) as AsyncResult<
          Prisma.Result<T, A, "findMany">,
          ReadError
        >;
      },

      tryFindUnique<T, A>(
        this: T,
        args: Prisma.Exact<A, Prisma.Args<T, "findUnique">>,
      ): AsyncResult<Prisma.Result<T, A, "findUnique">, ReadError> {
        return query(this, "findUnique", args) as AsyncResult<
          Prisma.Result<T, A, "findUnique">,
          ReadError
        >;
      },

      tryFindUniqueOrThrow<T, A>(
        this: T,
        args: Prisma.Exact<A, Prisma.Args<T, "findUniqueOrThrow">>,
      ): AsyncResult<Prisma.Result<T, A, "findUniqueOrThrow">, RecordNotFound | DriverError> {
        return query(this, "findUniqueOrThrow", args) as AsyncResult<
          Prisma.Result<T, A, "findUniqueOrThrow">,
          RecordNotFound | DriverError
        >;
      },

      tryCount<T, A = Record<string, never>>(
        this: T,
        args?: Prisma.Exact<A, Prisma.Args<T, "count">>,
      ): AsyncResult<Prisma.Result<T, A, "count">, ReadError> {
        return query(this, "count", args) as AsyncResult<Prisma.Result<T, A, "count">, ReadError>;
      },

      tryCreate<T, A>(
        this: T,
        args: Prisma.Exact<A, Prisma.Args<T, "create">>,
      ): AsyncResult<Prisma.Result<T, A, "create">, CreateError> {
        return query(this, "create", args) as AsyncResult<
          Prisma.Result<T, A, "create">,
          CreateError
        >;
      },

      tryUpdate<T, A>(
        this: T,
        args: Prisma.Exact<A, Prisma.Args<T, "update">>,
      ): AsyncResult<Prisma.Result<T, A, "update">, UpdateError> {
        return query(this, "update", args) as AsyncResult<
          Prisma.Result<T, A, "update">,
          UpdateError
        >;
      },

      tryDelete<T, A>(
        this: T,
        args: Prisma.Exact<A, Prisma.Args<T, "delete">>,
      ): AsyncResult<Prisma.Result<T, A, "delete">, DeleteError> {
        return query(this, "delete", args) as AsyncResult<
          Prisma.Result<T, A, "delete">,
          DeleteError
        >;
      },
    },
  },
  client: {
    // The transaction bridge: the callback speaks `AsyncResult`, and an `Err` triggers a
    // ROLLBACK — thrown as a sentinel so Prisma aborts, then unwrapped back into the
    // typed error channel outside (`AsyncResult<T, E | PrismaQueryError>`). A defect
    // inside the callback also rolls back and stays a defect, re-minted through
    // `fromPromise`'s `defect` factory. Extensions propagate into the interactive `tx`,
    // so the `try*` methods are available inside the callback.
    $tryTransaction<C, T, E>(
      this: C,
      fn: (tx: Omit<C, TxDenyList>) => AsyncResult<T, E>,
      options?: {
        maxWait?: number;
        timeout?: number;
        isolationLevel?: Prisma.TransactionIsolationLevel;
      },
    ): AsyncResult<T, E | PrismaQueryError> {
      const client = Prisma.getExtensionContext(this) as unknown as {
        $transaction: <R>(f: (tx: unknown) => Promise<R>, opts?: unknown) => Promise<R>;
      };
      return fromPromise(
        client.$transaction(async (tx) => {
          const result = await fn(tx as Omit<C, TxDenyList>);
          if (result.isOk()) return result.value;
          throw result.isErr()
            ? new Rollback(result.error, false)
            : new Rollback(result.cause, true);
        }, options),
        (cause, defect) =>
          cause instanceof Rollback
            ? cause.wasDefect
              ? defect(cause.carried)
              : (cause.carried as E | PrismaQueryError)
            : qualifyPrismaError(cause),
      );
    },
  },
});
