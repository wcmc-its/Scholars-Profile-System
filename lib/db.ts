import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@/lib/generated/prisma/client";

declare global {
  var __prisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Did you copy .env.example to .env.local?");
  }
  // The MariaDB adapter accepts a MySQL connection URL and works against MySQL 8.
  const adapter = new PrismaMariaDb(url);
  return new PrismaClient({ adapter });
}

// Reuse the client across hot-reloads in dev to avoid exhausting the connection pool.
export const prisma = globalThis.__prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}
