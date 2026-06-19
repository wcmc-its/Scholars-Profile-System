/**
 * Faculty coverage metric (NOT an ETL): "What % of full-time faculty surface in at
 * least one algorithmic context?" — for About-page / stakeholder coverage claims.
 * Findings + interpretation: docs/faculty-coverage-metric.md.
 *
 * Three signals, each restricted to the FT-faculty population (the denominator):
 *   A. Spotlight   — author on a surviving (non-dark) paper in any `spotlight` row.
 *   B. Methods/tools — has ≥1 `scholar_family` OR `scholar_tool` row (pmid_count > 0).
 *   C. Research-area experts — ranks in a DISPLAYED expert listing:
 *        C1 = topic "Top scholars" (top 7, sparse-hide < 3)   [the selective surface]
 *        C2 = subtopic scholars rail (top 10, floor 1)        [the inclusive surface]
 *
 * Signals A and C reuse the app's OWN loaders/scoring (scorePublication with the
 * `top_scholars` recency curve, the eligibility carve, the suppression layer) so the
 * counts match what a visitor actually sees — not a re-derived approximation.
 *
 * Read-only (SELECT-only). Recompute:
 *   - Against STAGING RDS (authoritative):  scripts/run-staging-probe.sh scripts/faculty-coverage-metric.ts
 *     (injects this file into the staging ETL task's existing image — no image roll)
 *   - Against a local staging snapshot:      npm run metrics:faculty-coverage
 *     (needs DATABASE_URL pointed at a populated db)
 *
 * Prints per-signal counts + union %. Methods/tools (signal B) only populates in an
 * env where the methods-lens backfill has run (staging yes; prod not yet) — the
 * "WITHOUT methods-lens" union shows what an env without it surfaces.
 */
import { prisma } from "@/lib/db";
import {
  isAuthorHidden,
  loadPublicationSuppressions,
  resolveDarkPmids,
} from "@/lib/api/manual-layer";
import { scorePublication, type RankablePublication } from "@/lib/ranking";
import { TOP_SCHOLARS_ELIGIBLE_ROLES } from "@/lib/eligibility";
import { FEED_EXCLUDED_TYPES } from "@/lib/publication-types";

const RECITERAI_YEAR_FLOOR = 2020; // D-15
const TOP_SCHOLARS_TARGET = 7;
const TOP_SCHOLARS_FLOOR = 3;
const SUBTOPIC_SCHOLARS_TARGET = 10;
const SUBTOPIC_SCHOLARS_FLOOR = 1;

type ArtifactPaper = { pmid: string };

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
}

async function main() {
  const now = new Date();

  // ---- Denominator: all publicly-active full-time faculty ----------------
  const ftFaculty = await prisma.scholar.findMany({
    where: { deletedAt: null, status: "active", roleCategory: "full_time_faculty" },
    select: { cwid: true },
  });
  const ft = new Set(ftFaculty.map((s) => s.cwid));
  const inFt = (cwid: string | null | undefined): cwid is string =>
    cwid != null && ft.has(cwid);

  // ---- Signal A: Spotlight authors (mirrors lib/api/home.ts) --------------
  const spotlightCwids = new Set<string>();
  {
    const rows = await prisma.spotlight.findMany({ select: { papers: true } });
    const pmids = Array.from(
      new Set(
        rows.flatMap((r) =>
          (r.papers as unknown as ArtifactPaper[]).map((p) => p.pmid),
        ),
      ),
    );
    if (pmids.length > 0) {
      const suppressions = await loadPublicationSuppressions(pmids, prisma);
      const darkPmids = await resolveDarkPmids(pmids, suppressions, prisma);
      const authorRows = await prisma.publicationAuthor.findMany({
        where: {
          pmid: { in: pmids },
          cwid: { not: null },
          scholar: {
            deletedAt: null,
            status: "active",
            roleCategory: "full_time_faculty",
          },
        },
        select: { pmid: true, cwid: true },
      });
      for (const r of authorRows) {
        if (!r.cwid || darkPmids.has(r.pmid)) continue;
        if (isAuthorHidden(suppressions, r.pmid, r.cwid)) continue;
        if (inFt(r.cwid)) spotlightCwids.add(r.cwid);
      }
    }
  }

  // ---- Signal B: tool / method-family expertise ---------------------------
  const toolsCwids = new Set<string>();
  {
    const ftScholar = {
      deletedAt: null,
      status: "active",
      roleCategory: "full_time_faculty",
    } as const;
    const [fams, tools] = await Promise.all([
      prisma.scholarFamily.findMany({
        where: { pmidCount: { gt: 0 }, scholar: ftScholar },
        select: { cwid: true },
      }),
      prisma.scholarTool.findMany({
        where: { pmidCount: { gt: 0 }, scholar: ftScholar },
        select: { cwid: true },
      }),
    ]);
    for (const r of [...fams, ...tools]) if (inFt(r.cwid)) toolsCwids.add(r.cwid);
  }

  // ---- Signal C: research-area expert listings (mirrors lib/api/topics.ts) -
  const topicExpertCwids = new Set<string>(); // C1: topic top-7
  const subtopicExpertCwids = new Set<string>(); // C2: subtopic top-10
  {
    const topics = await prisma.topic.findMany({ select: { id: true } });
    for (const topic of topics) {
      const rows = await prisma.publicationTopic.findMany({
        where: {
          parentTopicId: topic.id,
          authorPosition: { in: ["first", "last"] }, // D-13
          year: { gte: RECITERAI_YEAR_FLOOR }, // D-15
          scholar: {
            deletedAt: null,
            status: "active",
            roleCategory: { in: [...TOP_SCHOLARS_ELIGIBLE_ROLES] }, // D-14 (FT only)
          },
          publication: { publicationType: { notIn: [...FEED_EXCLUDED_TYPES] } },
        },
        select: {
          cwid: true,
          score: true,
          pmid: true,
          authorPosition: true,
          primarySubtopicId: true,
          publication: { select: { publicationType: true, dateAddedToEntrez: true } },
        },
      });

      const topicAgg = new Map<string, number>();
      const subAgg = new Map<string, Map<string, number>>();
      for (const r of rows) {
        const rankable: RankablePublication = {
          pmid: r.pmid,
          publicationType: r.publication.publicationType,
          reciteraiImpact: Number(r.score),
          dateAddedToEntrez: r.publication.dateAddedToEntrez,
          authorship: {
            isFirst: r.authorPosition === "first",
            isLast: r.authorPosition === "last",
            isPenultimate: r.authorPosition === "penultimate",
          },
          isConfirmed: true,
        };
        const score = scorePublication(rankable, "top_scholars", true, now);
        if (score === 0) continue;
        topicAgg.set(r.cwid, (topicAgg.get(r.cwid) ?? 0) + score);
        const sub = r.primarySubtopicId;
        if (sub) {
          let m = subAgg.get(sub);
          if (!m) subAgg.set(sub, (m = new Map()));
          m.set(r.cwid, (m.get(r.cwid) ?? 0) + score);
        }
      }

      // C1 — topic Top scholars: hide whole list if < floor.
      if (topicAgg.size >= TOP_SCHOLARS_FLOOR) {
        const top = [...topicAgg.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, TOP_SCHOLARS_TARGET);
        for (const [cwid] of top) topicExpertCwids.add(cwid);
      }
      // C2 — subtopic rail: floor 1, top 10.
      for (const m of subAgg.values()) {
        if (m.size < SUBTOPIC_SCHOLARS_FLOOR) continue;
        const top = [...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, SUBTOPIC_SCHOLARS_TARGET);
        for (const [cwid] of top) subtopicExpertCwids.add(cwid);
      }
    }
  }

  // ---- Unions -------------------------------------------------------------
  const selective = new Set<string>([
    ...spotlightCwids,
    ...toolsCwids,
    ...topicExpertCwids,
  ]); // A ∪ B ∪ C1 — "spotlight, tool expertise, or research-area expert (top-7)"
  const inclusive = new Set<string>([...selective, ...subtopicExpertCwids]); // + C2

  // Methods-lens-independent unions (what an env with NO tool/family backfill
  // — e.g. prod today — would surface):
  const noMethodsSelective = new Set<string>([...spotlightCwids, ...topicExpertCwids]); // A ∪ C1
  const noMethodsInclusive = new Set<string>([...noMethodsSelective, ...subtopicExpertCwids]); // A ∪ C1 ∪ C2

  const D = ft.size;
  console.log("\n=== About-page coverage probe ===\n");
  console.log(`Full-time faculty (denominator):     ${D}`);
  console.log("");
  console.log(`A. Spotlight snippet:                 ${spotlightCwids.size}  (${pct(spotlightCwids.size, D)})`);
  console.log(`B. Methods / tool expertise:          ${toolsCwids.size}  (${pct(toolsCwids.size, D)})`);
  console.log(`C1. Research-area expert (topic top-7): ${topicExpertCwids.size}  (${pct(topicExpertCwids.size, D)})`);
  console.log(`C2. Subtopic rail (top-10):           ${subtopicExpertCwids.size}  (${pct(subtopicExpertCwids.size, D)})`);
  console.log("");
  console.log("-- with methods-lens data (staging-like) --");
  console.log(`UNION A∪B∪C1 (selective):             ${selective.size}  (${pct(selective.size, D)})`);
  console.log(`UNION A∪B∪C1∪C2 (any area surface):   ${inclusive.size}  (${pct(inclusive.size, D)})`);
  console.log("-- WITHOUT methods-lens (prod today) --");
  console.log(`UNION A∪C1 (selective):               ${noMethodsSelective.size}  (${pct(noMethodsSelective.size, D)})`);
  console.log(`UNION A∪C1∪C2 (any area surface):     ${noMethodsInclusive.size}  (${pct(noMethodsInclusive.size, D)})`);
  console.log("");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
