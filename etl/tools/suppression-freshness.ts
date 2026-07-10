/**
 * #1502 — freshness probe for the tools-ETL sha256 short-circuit.
 *
 * The tools ETL bakes ADR-005 suppression-filtered exemplar/usage sentences into
 * `scholar_family` / `family_entity_usage` at write time (the write path calls
 * `loadAllPublicationSuppressions` and drops suppressed pmids), but the
 * short-circuit in ./index.ts compares only the S3 artifact sha — blind to
 * Aurora-side takedowns. So a whole-publication takedown or per-author hide made
 * after the last artifact publish leaves the suppressed paper's verbatim sentence
 * + source pmid live in the public method surfaces until ReciterAI happens to
 * republish the artifact.
 *
 * This asks: has any publication suppression changed state (created OR revoked)
 * since `since`? A create bumps `createdAt`, a revoke bumps `revokedAt` — the only
 * two state transitions (the `suppression` table has no `updatedAt`) — so one
 * indexed `findFirst` per column closes both directions. The publication
 * suppression set is tiny (takedowns are rare superuser actions), so this stays
 * cheap even on the short-circuit hot path.
 *
 * Client-injected and side-effect-free at import time — the same testability
 * contract as ./manifest-signature.ts, so it can be unit-tested without executing
 * index.ts's top-level `main()`.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";

type SuppressionFreshnessClient = Pick<PrismaClient, "suppression">;

export async function publicationSuppressionChangedSince(
  client: SuppressionFreshnessClient,
  since: Date | null,
): Promise<boolean> {
  // No prior successful run to compare against ⇒ never short-circuit on this axis.
  if (since === null) return true;
  const [created, revoked] = await Promise.all([
    client.suppression.findFirst({
      where: { entityType: "publication", createdAt: { gt: since } },
      select: { id: true },
    }),
    client.suppression.findFirst({
      where: { entityType: "publication", revokedAt: { gt: since } },
      select: { id: true },
    }),
  ]);
  return created !== null || revoked !== null;
}
