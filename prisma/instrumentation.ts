/**
 * Prisma OTel instrumentation re-export.
 *
 * Renamed from `prisma/middleware.ts` (COORDINATION's original OWNS entry)
 * because Prisma 7 removed the `$use` middleware API in favor of the OTel
 * tracing event emitted by the engine. `@prisma/instrumentation` patches
 * the client at module-load time once the OTel SDK is registered, so the
 * actual hook lives in `lib/tracing/init.ts` (called from the repo-root
 * `instrumentation.ts`). What this file provides is a single import path
 * that re-exports the existing read/write split clients so callers wanting
 * the instrumented surface have one obvious entry.
 *
 * Importing from `@/lib/db` directly continues to work -- the OTel
 * registration patches the Prisma client by global engine hook, not by
 * wrapping the instance, so the same client emits spans regardless of
 * import path.
 */

export { db, prisma } from "@/lib/db";
