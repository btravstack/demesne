// Prisma 7 config — the connection URL for the CLI (Migrate) lives here, not in the schema.
// The application itself reads DATABASE_URL through the zod-validated `AppConfig` and passes
// it to the driver adapter (see src/infra/prisma.ts); this file is only for `prisma migrate`.
//
// The datasource is added only when DATABASE_URL is set, so `prisma generate` (which needs
// no connection) works without any environment — it's `prisma migrate` that requires it.

import { defineConfig } from "prisma/config";

const url = process.env["DATABASE_URL"];

export default defineConfig({
  schema: "prisma/schema.prisma",
  ...(url ? { datasource: { url } } : {}),
});
