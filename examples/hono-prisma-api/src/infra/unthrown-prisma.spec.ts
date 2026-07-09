// The pure half of the bridge: P-code → tagged error. The extension surface itself needs
// a live database to exercise; the qualification is where the mapping logic lives, so it
// is what gets unit-tested.

import { describe, expect, it } from "vitest";

import { Prisma } from "../generated/prisma/client.ts";
import { qualifyPrismaError } from "./unthrown-prisma.js";

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError("boom", {
    code,
    clientVersion: "7.0.0",
    ...(meta ? { meta } : {}),
  });

describe("qualifyPrismaError", () => {
  it("maps P2002 to UniqueConstraintViolation with the offending fields", () => {
    const cause = known("P2002", { target: ["title"] });
    expect(qualifyPrismaError(cause)).toEqual(
      expect.objectContaining({ _tag: "UniqueConstraintViolation", fields: ["title"], cause }),
    );
  });

  it("maps P2002 without a target to an empty field list", () => {
    expect(qualifyPrismaError(known("P2002"))).toEqual(
      expect.objectContaining({ _tag: "UniqueConstraintViolation", fields: [] }),
    );
  });

  it("maps P2003 to ForeignKeyViolation", () => {
    const cause = known("P2003");
    expect(qualifyPrismaError(cause)).toEqual(
      expect.objectContaining({ _tag: "ForeignKeyViolation", cause }),
    );
  });

  it("maps P2025 to RecordNotFound", () => {
    const cause = known("P2025");
    expect(qualifyPrismaError(cause)).toEqual(
      expect.objectContaining({ _tag: "RecordNotFound", cause }),
    );
  });

  it("maps an unhandled P-code to DriverError", () => {
    const cause = known("P2024");
    expect(qualifyPrismaError(cause)).toEqual(
      expect.objectContaining({ _tag: "DriverError", cause }),
    );
  });

  it("maps a non-Prisma rejection to DriverError, preserving the cause", () => {
    const cause = new Error("socket hang up");
    expect(qualifyPrismaError(cause)).toEqual(
      expect.objectContaining({ _tag: "DriverError", cause }),
    );
  });
});
