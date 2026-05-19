import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@/lib/generated/prisma/client";

declare global {
  var __prismaWrite: PrismaClient | undefined;
  var __prismaRead: PrismaClient | undefined;
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
function createPrismaClient(url: string): PrismaClient {
  const adapter = new PrismaMariaDb(url);
  return new PrismaClient({ adapter });
}

const PLACEHOLDER_URL = "mysql://_unset:_unset@localhost:3306/_unset";

const writeUrl = process.env.DATABASE_URL ?? PLACEHOLDER_URL;
// The reader endpoint is optional: an unset DATABASE_URL_RO collapses reads
// onto the writer — the supported single-endpoint posture (B16 / #115).
const readUrl = process.env.DATABASE_URL_RO ?? writeUrl;
const splitEnabled = readUrl !== writeUrl;

// Reuse clients across dev hot-reloads to avoid exhausting the pool.
const writeClient = globalThis.__prismaWrite ?? createPrismaClient(writeUrl);
const readClient = splitEnabled
  ? (globalThis.__prismaRead ?? createPrismaClient(readUrl))
  : writeClient;

if (process.env.NODE_ENV !== "production") {
  globalThis.__prismaWrite = writeClient;
  globalThis.__prismaRead = readClient;
}

/**
 * Reader/writer-split Prisma access (B16 / #115).
 *
 *   db.write — Aurora writer endpoint. Mutations, ETL, seed, migrations.
 *   db.read  — Aurora reader endpoint; route handlers + server components.
 *              Falls back to the writer when DATABASE_URL_RO is unset, in
 *              which case db.read and db.write are the same client (one pool).
 */
export const db = { read: readClient, write: writeClient } as const;

/**
 * @deprecated Use `db.read` for queries or `db.write` for mutations.
 *
 * Alias of `db.read`, retained so reader call sites can migrate incrementally.
 * New code must import `db`; ETL/seed/scripts must write through `db.write`.
 */
export const prisma = readClient;
