/**
 * MeSH per-descriptor coverage ETL — spec §1.7.
 *
 * Run via `npm run etl:mesh-coverage`. One run does:
 *
 *   1. Compute `local_pub_coverage` per MeSH descriptor as
 *      COUNT(DISTINCT pmid where mesh_terms contains the descriptor's ui)
 *      / COUNT(*) from `publication`.
 *   2. UPDATE every row in `mesh_descriptor` in a single statement (server-
 *      side; LEFT JOIN with COALESCE so descriptors with no tagged pubs
 *      land at 0.0, not NULL).
 *   3. Pull the p50/p90/p99 distribution into Node and log it so Phase 3
 *      §3.3 (too-broad cutoff) has grounding before it's built.
 *   4. Record the run in `etl_run` under source="MeshCoverage".
 *
 * Cadence: daily, after the publication ETL refreshes (so the numerator
 * is fresh). Wired into etl/orchestrate.ts.
 *
 * Standalone (does not piggyback on `etl:mesh-anchors`): different cadence
 * (anchors are on-demand; coverage is daily) and different failure modes.
 *
 * Resolver impact: the in-memory MeshMap (lib/api/search-taxonomy.ts) keeps
 * serving the previous load until its next 1h refresh tick. A partial
 * UPDATE rollback is invisible to readers.
 */
import { prisma } from "@/lib/db";
import { percentiles } from "../mesh-anchors/derive";

async function recordRun(args: {
  status: "success" | "failed";
  rowsProcessed: number;
  errorMessage?: string;
}): Promise<void> {
  await prisma.etlRun.create({
    data: {
      source: "MeshCoverage",
      status: args.status,
      completedAt: new Date(),
      rowsProcessed: args.rowsProcessed,
      errorMessage: args.errorMessage ?? null,
    },
  });
}

/**
 * Single server-side UPDATE. Numerator and denominator are computed in one
 * round-trip; the denominator is materialized once via a scalar CROSS JOIN
 * so MariaDB doesn't recompute COUNT(*) per descriptor row.
 *
 * `CASE WHEN total > 0` guards the empty-publication-table case
 * (test-DB seeding race, or a freshly-truncated environment); coverage is
 * left NULL rather than triggering a divide-by-zero.
 *
 * Returns the affected row count. With LEFT JOIN this is the full
 * `mesh_descriptor` row count, not just descriptors with tagged pubs.
 */
async function updateAllCoverages(): Promise<number> {
  const affected = await prisma.$executeRaw`
    UPDATE mesh_descriptor md
    LEFT JOIN (
      SELECT jt.ui AS descriptor_ui, COUNT(DISTINCT p.pmid) AS n_pubs
      FROM publication p
      CROSS JOIN JSON_TABLE(
        p.mesh_terms,
        '$[*]' COLUMNS (ui VARCHAR(10) PATH '$.ui')
      ) jt
      WHERE jt.ui IS NOT NULL
      GROUP BY jt.ui
    ) c ON md.descriptor_ui = c.descriptor_ui COLLATE utf8mb4_unicode_ci
    CROSS JOIN (SELECT COUNT(*) AS total FROM publication) t
    SET md.local_pub_coverage =
      CASE WHEN t.total > 0
           THEN COALESCE(c.n_pubs, 0) / t.total
           ELSE NULL
      END
  `;
  return Number(affected);
}

async function loadCoverageDistribution(): Promise<number[]> {
  const rows = await prisma.$queryRaw<{ cov: number | null }[]>`
    SELECT local_pub_coverage AS cov
    FROM mesh_descriptor
    WHERE local_pub_coverage IS NOT NULL
  `;
  return rows
    .map((r) => (r.cov == null ? null : Number(r.cov)))
    .filter((n): n is number => n !== null);
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  const rowsProcessed = await updateAllCoverages();

  const coverages = await loadCoverageDistribution();
  const stats = percentiles(coverages);
  const max = coverages.length > 0 ? Math.max(...coverages) : null;
  const nonZero = coverages.filter((c) => c > 0).length;

  console.log(
    `[MeshCoverage] ${JSON.stringify({
      event: "mesh_coverage_etl_complete",
      descriptorsUpdated: rowsProcessed,
      descriptorsWithCoverage: coverages.length,
      descriptorsWithNonZeroCoverage: nonZero,
      maxCoverage: max,
      p50: stats.p50,
      p90: stats.p90,
      p99: stats.p99,
      durationMs: Date.now() - startedAt,
    })}`,
  );

  await recordRun({ status: "success", rowsProcessed });
}

main()
  .catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[MeshCoverage] ${JSON.stringify({ event: "fatal", error: message })}`,
    );
    await recordRun({
      status: "failed",
      rowsProcessed: 0,
      errorMessage: message,
    }).catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
