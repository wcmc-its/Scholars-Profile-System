import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@/lib/generated/prisma/client";

declare global {
  var __prisma: PrismaClient | undefined;
}

/**
 * Build a PrismaClient. The adapter is constructed eagerly but does NOT open a
 * connection — connections are lazily established on the first query. This
 * matters during `next build`, when route modules are imported to collect page
 * metadata: that import path must not require DATABASE_URL to be set.
 *
 * Missing-DATABASE_URL errors surface at query time instead, which only
 * happens when an actual request hits a route that talks to the DB.
 */
function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL ?? "mysql://_unset:_unset@localhost:3306/_unset";
  const adapter = new PrismaMariaDb(url);
  return new PrismaClient({ adapter });
}

// Reuse the client across hot-reloads in dev to avoid exhausting the pool.
export const prisma = globalThis.__prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}
