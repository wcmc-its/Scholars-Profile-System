/**
 * Phase 6 ANALYTICS-03 — profile completeness snapshot computation.
 *
 * D-07 (completeness definition): a profile is "complete" if BOTH:
 *   1. `overview` is non-null
 *   2. at least one confirmed authorship (PublicationAuthor.isConfirmed = true)
 * Headshot is NOT a separate predicate: per RESEARCH.md Pattern 8 the
 * `identityImageEndpoint` field is computed from cwid for every active
 * scholar, so the headshot condition reduces to "scholar has a cwid"
 * which is always true for active scholars. The remaining bottleneck is
 * overview + publications.
 *
 * D-08: equal weight — every active scholar counts equally.
 *
 * Boundary semantics:
 *   - threshold check is STRICTLY less than 70 (`< 70`), not `≤ 70`
 *   - `totalScholars === 0` returns 0% but `belowThreshold = false`
 *     (no spurious escalation during DB bootstrap or test fixtures)
 */
import { prisma } from "@/lib/db";

/** Phase 6 escalation threshold. CloudWatch alarm fires when below. */
export const COMPLETENESS_THRESHOLD = 70;

export type CompletenessResult = {
  totalScholars: number;
  completeCount: number;
  completenessPercent: number;
  belowThreshold: boolean;
};

/**
 * Counts active scholars and complete profiles, writes one
 * `completeness_snapshot` row, returns the computed values.
 *
 * Caller (etl/completeness/index.ts) wraps this in process-level
 * try/catch and exits with the appropriate code. Within etl/orchestrate.ts
 * the wrapping step uses best-effort handling so failure does NOT abort
 * the daily ETL chain (Pitfall 3).
 */
export async function computeCompletenessSnapshot(): Promise<CompletenessResult> {
  const totalScholars = await prisma.scholar.count({
    where: { deletedAt: null, status: "active" },
  });

  const completeCount = await prisma.scholar.count({
    where: {
      deletedAt: null,
      status: "active",
      overview: { not: null },
      authorships: { some: { isConfirmed: true } },
    },
  });

  const completenessPercent =
    totalScholars === 0 ? 0 : (completeCount / totalScholars) * 100;
  const belowThreshold =
    totalScholars > 0 && completenessPercent < COMPLETENESS_THRESHOLD;

  await prisma.completenessSnapshot.create({
    data: {
      totalScholars,
      completeCount,
      completenessPercent,
      belowThreshold,
    },
  });

  return { totalScholars, completeCount, completenessPercent, belowThreshold };
}
