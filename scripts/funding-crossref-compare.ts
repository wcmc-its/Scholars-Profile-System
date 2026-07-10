/**
 * One-off validation for the cheap forward cross-ref shipped in
 * `lib/api/match-researchers` (`opportunitiesInTopMatches`).
 *
 * Compares, for a handful of the top researchers ranked for one opportunity:
 *   (1) CHEAP — the MySQL-only topic-affinity top-N we ship as `inMyTopMatches`.
 *   (3) FULL  — the real forward matcher (`matchOpportunitiesForScholar`):
 *               OpenSearch Stage-1 retrieval + the full topic/stage/mesh/deadline
 *               blend, the same path that powers each scholar's "Grants for me".
 *
 * Decision it answers: is the cheap signal a good-enough proxy for the full one,
 * or does it diverge enough to warrant running the full matcher per candidate?
 *
 * Run (in the worktree, against the local DB + OpenSearch):
 *   npx tsx scripts/funding-crossref-compare.ts [opportunityId] [topN] [sample]
 */
import { matchOpportunitiesForScholar } from "@/lib/api/match-opportunities";
import { opportunitiesInTopMatches, rankResearchersForOpportunity } from "@/lib/api/match-researchers";
import { db } from "@/lib/db";

const ARG_OPP = process.argv[2];
const TOP_N = Number(process.argv[3] ?? 10);
const SAMPLE = Number(process.argv[4] ?? 8);

async function pickOpportunity(): Promise<string | null> {
  if (ARG_OPP) return ARG_OPP;
  // Prefer an opportunity that actually yields researchers AND looks eligible
  // (so the full matcher can return it), otherwise the comparison is all about
  // eligibility filtering rather than ranking.
  const opps = await db.read.opportunity.findMany({
    select: { opportunityId: true, status: true, dueDate: true, title: true },
  });
  let fallback: string | null = null;
  for (const o of opps) {
    const { scholars: ranked } = await rankResearchersForOpportunity(o.opportunityId, { limit: 3 });
    if (ranked.length < 3) continue;
    fallback ??= o.opportunityId;
    const eligible =
      ["open", "forecasted", "continuous"].includes(o.status) &&
      (o.dueDate === null || o.dueDate.getTime() >= Date.now());
    if (eligible) return o.opportunityId;
  }
  return fallback;
}

async function main() {
  const oppId = await pickOpportunity();
  if (!oppId) {
    console.log("No opportunity yields enough ranked researchers in this DB.");
    return;
  }
  const opp = await db.read.opportunity.findUnique({
    where: { opportunityId: oppId },
    select: { title: true, status: true, dueDate: true, source: true },
  });
  console.log(`\nOpportunity: ${oppId}`);
  console.log(`  title : ${opp?.title ?? "?"}`);
  console.log(`  status: ${opp?.status}   due: ${opp?.dueDate?.toISOString().slice(0, 10) ?? "—"}   source: ${opp?.source}`);
  console.log(`  topN=${TOP_N}  sample=${SAMPLE}\n`);

  const { scholars: ranked } = await rankResearchersForOpportunity(oppId, { limit: SAMPLE });
  const cwids = ranked.map((r) => r.cwid);
  const cheapSet = await opportunitiesInTopMatches(oppId, cwids, TOP_N);

  let agree = 0;
  const rows: string[] = [];
  for (const r of ranked) {
    const fwd = await matchOpportunitiesForScholar(r.cwid, { limit: TOP_N });
    const fullRank = fwd.findIndex((o) => o.opportunityId === oppId); // -1 = not in top-N
    const fullIn = fullRank >= 0;
    const cheapIn = cheapSet.has(r.cwid);
    if (fullIn === cheapIn) agree += 1;
    const name = r.preferredName ?? r.cwid;
    rows.push(
      `  ${cheapIn === fullIn ? "✓" : "✗"}  ${name.padEnd(26)} cheap=${cheapIn ? "Y" : "·"}  full=${
        fullIn ? `#${fullRank + 1}` : "·"
      }  (fwd returned ${fwd.length})`,
    );
  }
  console.log(rows.join("\n"));
  console.log(
    `\nRanking agreement (ELIGIBLE opp only): ${agree}/${ranked.length} (${Math.round(
      (100 * agree) / Math.max(1, ranked.length),
    )}%) on "is this opp in the researcher's top-${TOP_N} Grants-for-me".`,
  );
  console.log(
    "  NOTE: this measures ranking divergence on an eligible opp; it does NOT cover\n" +
      "  closed/past-due/ineligible viewed opps. Those are guarded separately below.\n",
  );

  // Guard: the cheap cross-ref must NOT flag a viewed opp once it is past due (the
  // real forward matcher would never return it). Re-run with the clock advanced one
  // day past this opp's deadline; with the status/deadline pre-filter the opp drops
  // out of the candidate corpus, so no researcher should be flagged.
  if (opp?.dueDate) {
    const afterDue = new Date(opp.dueDate.getTime() + 24 * 60 * 60 * 1000);
    const guardSet = await opportunitiesInTopMatches(oppId, cwids, TOP_N, afterDue);
    const ok = guardSet.size === 0;
    console.log(
      `Past-due guard: clock=${afterDue.toISOString().slice(0, 10)} (1d after due) → ` +
        `${guardSet.size} flagged. ${ok ? "PASS — past-due opp never claimed as a match." : "FAIL — over-claim leaked!"}\n`,
    );
  } else {
    console.log("Past-due guard: skipped (continuous/no-due opp).\n");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
