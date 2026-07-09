// Type-level tests for the unthrown × Prisma bridge, checked by the example's regular
// `tsc --noEmit`. They guard the two claims the extension is built on: payload inference
// (`select` / `include`) survives the wrap, and the error channel is per-operation — a
// read cannot fail with a write's constraint violations. Assertions accumulate in the
// exported `_Assertions` tuple (so nothing is an unused local); `@ts-expect-error` guards
// the cases that must NOT compile.

import type { ServiceOf } from "demesne";
import type { AsyncErrOf, AsyncOkOf } from "unthrown";

import type { Database } from "./prisma.js";
import type {
  DriverError,
  ForeignKeyViolation,
  RecordNotFound,
  UniqueConstraintViolation,
} from "./unthrown-prisma.js";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

declare const db: ServiceOf<Database>;

// --- payload inference survives the wrap --------------------------------------

const all = db.todo.tryFindMany();
const selected = db.todo.tryFindMany({ select: { id: true } });
const created = db.todo.tryCreate({ data: { title: "x" } });
const fetched = db.todo.tryFindUniqueOrThrow({ where: { id: "1" } });
const counted = db.todo.tryCount();

// @ts-expect-error — `title` was not selected; the payload narrowed to `{ id }`.
selected.map((rows) => rows.map((r) => r.title));

// @ts-expect-error — an unknown arg key is rejected (`Prisma.Exact`).
db.todo.tryFindMany({ bogus: true });

// --- the error channel is per-operation ----------------------------------------

// @ts-expect-error — a read cannot fail with UniqueConstraintViolation.
const _readNarrow: AsyncErrOf<typeof all> = null as unknown as UniqueConstraintViolation;

// --- $tryTransaction: errors union, try-methods inside, no nesting -------------

const tx = db.$tryTransaction((txc) => txc.todo.tryCreate({ data: { title: "x" } }));

db.$tryTransaction((txc) => {
  // @ts-expect-error — no nested transactions inside the callback.
  txc.$tryTransaction;
  // @ts-expect-error — the raw `$transaction` is denied inside the callback too.
  txc.$transaction;
  return txc.todo.tryFindMany();
});

export type _Assertions = [
  // full read: default payload flows through
  Expect<Equal<AsyncOkOf<typeof all>[number]["createdAt"], Date>>,
  Expect<Equal<AsyncOkOf<typeof counted>, number>>,
  // select narrowing is exact
  Expect<Equal<AsyncOkOf<typeof selected>, { id: string }[]>>,
  Expect<Equal<AsyncOkOf<typeof created>["title"], string>>,
  // reads fail only in the driver; writes carry their constraint violations;
  // `*OrThrow` adds P2025
  Expect<Equal<AsyncErrOf<typeof all>, DriverError>>,
  Expect<
    Equal<AsyncErrOf<typeof created>, UniqueConstraintViolation | ForeignKeyViolation | DriverError>
  >,
  Expect<Equal<AsyncErrOf<typeof fetched>, RecordNotFound | DriverError>>,
  // the transaction unions the callback's errors with the transaction's own
  Expect<
    Equal<
      AsyncErrOf<typeof tx>,
      UniqueConstraintViolation | ForeignKeyViolation | RecordNotFound | DriverError
    >
  >,
  Expect<Equal<AsyncOkOf<typeof tx>["title"], string>>,
];
