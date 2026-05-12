/**
 * One-off investigation pass for GH #181.
 *
 * Answers two questions before we ship the "N co-pubs" badge interaction:
 *
 *   1. Distribution of N (p50/p90/p99/max) across all mentor-mentee pairs
 *      with co-pubs > 0. Drives the inline popover cap.
 *
 *   2. Unlinked-alumni share — fraction of mentee CWIDs (with co-pubs > 0)
 *      that have no `status='active'` row in the local Scholar table.
 *
 * Drift against the search index (Q3 in the issue) is omitted: option A
 * (link to /search) is off the table, so the drift number does not gate
 * the chosen implementation.
 *
 * Run: npx tsx etl/reciter/probe-mentor-mentee-copubs.ts
 * Read-only.
 */
import "dotenv/config";
import { withReciterConnection, closeReciterPool } from "@/lib/sources/reciterdb";
import { prisma } from "@/lib/db";

type PairRow = { mentor_cwid: string; mentee_cwid: string; n: number };

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

async function main() {
  const pairs = await withReciterConnection(async (conn) => {
    return (await conn.query(
      `SELECT a1.personIdentifier AS mentor_cwid,
              a2.personIdentifier AS mentee_cwid,
              COUNT(DISTINCT a1.pmid) AS n
         FROM reporting_students_mentors m
         JOIN analysis_summary_author a1
           ON a1.personIdentifier = m.mentorCWID
         JOIN analysis_summary_author a2
           ON a2.pmid = a1.pmid
          AND a2.personIdentifier = m.studentCWID
        WHERE m.mentorCWID IS NOT NULL
          AND m.studentCWID IS NOT NULL
          AND m.studentCWID != ''
        GROUP BY a1.personIdentifier, a2.personIdentifier
        HAVING n > 0`,
    )) as PairRow[];
  });

  const counts = pairs.map((p) => (typeof p.n === "bigint" ? Number(p.n) : p.n));
  counts.sort((a, b) => a - b);

  console.log("\n========== Q1: Distribution of N across mentor-mentee pairs (n > 0) ==========");
  console.log(`  pairs with co-pubs > 0:  ${counts.length}`);
  console.log(`  min:                     ${counts[0] ?? 0}`);
  console.log(`  p50:                     ${quantile(counts, 0.5)}`);
  console.log(`  p75:                     ${quantile(counts, 0.75)}`);
  console.log(`  p90:                     ${quantile(counts, 0.9)}`);
  console.log(`  p95:                     ${quantile(counts, 0.95)}`);
  console.log(`  p99:                     ${quantile(counts, 0.99)}`);
  console.log(`  max:                     ${counts[counts.length - 1] ?? 0}`);

  const buckets = [1, 2, 3, 5, 10, 20, 50, 100];
  console.log("\n  histogram (count of pairs with N >= bucket):");
  for (const b of buckets) {
    const c = counts.filter((n) => n >= b).length;
    const pct = ((c / counts.length) * 100).toFixed(1);
    console.log(`    N >= ${String(b).padStart(3)}:  ${String(c).padStart(6)}  (${pct}%)`);
  }

  console.log("\n========== Q2: Unlinked-alumni share among co-pub-bearing mentees ==========");
  const menteeCwids = [...new Set(pairs.map((p) => p.mentee_cwid))];
  console.log(`  distinct mentee CWIDs with co-pubs > 0:  ${menteeCwids.length}`);

  const linkedScholars = await prisma.scholar.findMany({
    where: { cwid: { in: menteeCwids }, deletedAt: null, status: "active" },
    select: { cwid: true },
  });
  const linkedSet = new Set(linkedScholars.map((s) => s.cwid));

  const linked = menteeCwids.filter((c) => linkedSet.has(c)).length;
  const unlinked = menteeCwids.length - linked;
  const unlinkedPct = ((unlinked / menteeCwids.length) * 100).toFixed(1);

  console.log(`  linked (active Scholar row):             ${linked}`);
  console.log(`  unlinked (alumni / suppressed / absent): ${unlinked}  (${unlinkedPct}%)`);

  // Also: pairs-weighted view (a heavy-mentor alumnus matters more than a
  // single-mentee alumnus when reasoning about visible badge interactions).
  const pairsUnlinked = pairs.filter((p) => !linkedSet.has(p.mentee_cwid)).length;
  const pairsPct = ((pairsUnlinked / pairs.length) * 100).toFixed(1);
  console.log(
    `  pairs-weighted: ${pairsUnlinked} / ${pairs.length} pairs land on unlinked mentees (${pairsPct}%)`,
  );

  await closeReciterPool();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await closeReciterPool();
  await prisma.$disconnect();
  process.exit(1);
});
