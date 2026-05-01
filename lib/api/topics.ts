/**
 * Topic-page data assembly. Reads `publication_topic` rows attributed to a
 * parent topic and computes Variant B rankings via `lib/ranking.ts`. Two
 * surfaces:
 *   - getTopScholarsForTopic()      RANKING-03 — D-13 first-or-senior aggregation
 *                                    + D-14 FT-faculty-only carve + compressed
 *                                    top_scholars recency curve.
 *   - getRecentHighlightsForTopic() RANKING-02 — publication-centric pool
 *                                    (no author-position filter), recent_highlights
 *                                    curve, dedup-per-pmid.
 *
 * Both surfaces honour:
 *   - D-12 sparse-state hide (return null + emit structured warn log).
 *   - D-15 ReCiterAI scoring data floor (year >= 2020).
 *   - design spec v1.7.1: hard-exclude Letter / Editorial Article / Erratum.
 *   - design spec v1.7.1: no citation count on either output type.
 *
 * Schema shape: D-02 candidate (e). `topic.id` IS the slug. `publication_topic`
 * is the (publication × scholar × parent_topic) triple table; `author_position`
 * already encodes first/last; the table has no Prisma relation to `publication`
 * (pmid types differ — string on `publication`, unsigned int here), so paper
 * metadata is fetched via a second `publication.findMany` keyed by string PMID.
 *
 * See:
 *   - .planning/phases/02-algorithmic-surfaces-and-home-composition/02-CONTEXT.md (D-12, D-13, D-14, D-15)
 *   - .planning/phases/02-algorithmic-surfaces-and-home-composition/02-SCHEMA-DECISION.md (candidate (e))
 *   - lib/ranking.ts (Variant B math, surface-keyed recency curves)
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import { scorePublication, type RankablePublication } from "@/lib/ranking";
import { TOP_SCHOLARS_ELIGIBLE_ROLES } from "@/lib/eligibility";

// Sparse-state floors and target counts (sourced from 02-UI-SPEC.md §States table
// + plan acceptance criteria). Top scholars: 7 chips, hide if <3.
// Recent highlights: 3 cards, hide if <1.
const TOP_SCHOLARS_TARGET = 7;
const TOP_SCHOLARS_FLOOR = 3;
const RECENT_HIGHLIGHTS_TARGET = 3;
const RECENT_HIGHLIGHTS_FLOOR = 1;

const RECITERAI_YEAR_FLOOR = 2020; // D-15

export type TopScholarChipData = {
  cwid: string;
  slug: string;
  preferredName: string;
  primaryTitle: string | null;
  identityImageEndpoint: string;
};

export type RecentHighlight = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
  pubmedUrl: string | null;
  doi: string | null;
  authors: Array<{
    cwid: string | null;
    slug: string | null;
    preferredName: string;
  }>;
  // No citation-count field — locked by design spec v1.7.1.
};

function logSparseHide(
  surface: "topic_top_scholars" | "topic_recent_highlights",
  qualifying: number,
  floor: number,
  topic: string,
): void {
  console.warn(
    JSON.stringify({
      event: "sparse_state_hide",
      surface,
      qualifying,
      floor,
      topic,
    }),
  );
}

/**
 * RANKING-03 — Top scholars chip row.
 *
 * D-13 + D-14 narrowing:
 *   - WHERE filter: scholar.role_category IN TOP_SCHOLARS_ELIGIBLE_ROLES
 *     (full_time_faculty only — PI surface).
 *   - WHERE filter: author_position IN ('first', 'last') — only first/senior
 *     papers contribute to the chip-row aggregation.
 *   - Score each row with the COMPRESSED `top_scholars` recency curve, NOT
 *     `recent_highlights`.
 *   - Aggregate per scholar, sort desc, slice top 7.
 *   - Sparse-state hide if fewer than 3 chips qualify.
 */
export async function getTopScholarsForTopic(
  topicSlug: string,
  now: Date = new Date(),
): Promise<TopScholarChipData[] | null> {
  // Under candidate (e) topic.id IS the slug. Look up parent topic to validate.
  const topic = await prisma.topic.findUnique({ where: { id: topicSlug } });
  if (!topic) return null;

  // Pull all publication_topic rows for this topic that match the D-13/D-14
  // narrowed carve. Publication metadata is fetched separately because the
  // schema has no Prisma relation between PublicationTopic.pmid (Int) and
  // Publication.pmid (String).
  const rows = await prisma.publicationTopic.findMany({
    where: {
      parentTopicId: topicSlug,
      authorPosition: { in: ["first", "last"] }, // D-13 aggregation filter
      year: { gte: RECITERAI_YEAR_FLOOR }, // D-15
      scholar: {
        deletedAt: null,
        status: "active",
        roleCategory: { in: [...TOP_SCHOLARS_ELIGIBLE_ROLES] }, // D-14 narrowed (FT only)
      },
    },
    include: {
      scholar: {
        select: {
          cwid: true,
          slug: true,
          preferredName: true,
          primaryTitle: true,
          roleCategory: true,
        },
      },
    },
  });

  if (rows.length === 0) {
    logSparseHide("topic_top_scholars", 0, TOP_SCHOLARS_FLOOR, topicSlug);
    return null;
  }

  // Fetch publication metadata for the unique pmids referenced by these rows.
  // PublicationTopic.pmid is Int unsigned; Publication.pmid is String — cast.
  const pmidStrings = Array.from(new Set(rows.map((r) => String(r.pmid))));
  const pubs = await prisma.publication.findMany({
    where: {
      pmid: { in: pmidStrings },
      publicationType: { notIn: ["Letter", "Editorial Article", "Erratum"] },
    },
    select: {
      pmid: true,
      publicationType: true,
      dateAddedToEntrez: true,
    },
  });
  const pubByPmid = new Map(pubs.map((p) => [p.pmid, p]));

  // Aggregate per scholar using the compressed top_scholars curve (D-14).
  type AggEntry = {
    scholar: {
      cwid: string;
      slug: string;
      preferredName: string;
      primaryTitle: string | null;
    };
    total: number;
  };
  const byCwid = new Map<string, AggEntry>();

  for (const r of rows) {
    if (!r.scholar) continue;
    const pub = pubByPmid.get(String(r.pmid));
    if (!pub) continue; // pub filtered out by hard-exclude type or missing

    const rankable: RankablePublication = {
      pmid: String(r.pmid),
      publicationType: pub.publicationType,
      // Variant B sources reciteraiImpact from PublicationScore.score in
      // profile-page contexts; here `publication_topic.score` is the per-
      // (pmid, cwid, parent_topic) ReCiterAI parent-topic score, projected
      // from TOPIC#.score per ADR-006. Decimal → number conversion.
      reciteraiImpact: Number(r.score),
      dateAddedToEntrez: pub.dateAddedToEntrez,
      authorship: {
        isFirst: r.authorPosition === "first",
        isLast: r.authorPosition === "last",
        isPenultimate: r.authorPosition === "penultimate",
      },
      isConfirmed: true,
    };
    // D-14: explicitly use the compressed `top_scholars` recency curve.
    const score = scorePublication(rankable, "top_scholars", true, now);
    if (score === 0) continue;

    const entry =
      byCwid.get(r.cwid) ??
      ({
        scholar: r.scholar,
        total: 0,
      } as AggEntry);
    entry.total += score;
    byCwid.set(r.cwid, entry);
  }

  const sorted = Array.from(byCwid.values()).sort((a, b) => b.total - a.total);

  if (sorted.length < TOP_SCHOLARS_FLOOR) {
    logSparseHide(
      "topic_top_scholars",
      sorted.length,
      TOP_SCHOLARS_FLOOR,
      topicSlug,
    );
    return null;
  }

  return sorted.slice(0, TOP_SCHOLARS_TARGET).map((e) => ({
    cwid: e.scholar.cwid,
    slug: e.scholar.slug,
    preferredName: e.scholar.preferredName,
    primaryTitle: e.scholar.primaryTitle,
    identityImageEndpoint: identityImageEndpoint(e.scholar.cwid),
  }));
}

/**
 * RANKING-02 — Recent highlights.
 *
 * D-13 publication-centric pool: NO author-position filter at the WHERE clause.
 * Any author position contributes a row to the pool. Score each pmid once via
 * the `recent_highlights` curve with scholarCentric=false (so authorshipWeight
 * is 1.0 regardless of position), dedupe per pmid, take top N.
 *
 * D-15: 2020+ year floor.
 * Hard-excluded pub types are filtered at publication.findMany.
 * Sparse-state hide if 0 papers qualify.
 */
export async function getRecentHighlightsForTopic(
  topicSlug: string,
  now: Date = new Date(),
): Promise<RecentHighlight[] | null> {
  const topic = await prisma.topic.findUnique({ where: { id: topicSlug } });
  if (!topic) return null;

  const rows = await prisma.publicationTopic.findMany({
    where: {
      parentTopicId: topicSlug,
      year: { gte: RECITERAI_YEAR_FLOOR }, // D-15
      // NO authorPosition filter — publication-centric pool per D-13.
      scholar: {
        deletedAt: null,
        status: "active",
        // Recent highlights uses the general carve per spec v1.7.1; however,
        // for Phase 2 the carve is applied at the scholar attribution layer
        // when rendering author chips. The raw pool is publication-centric:
        // a pmid is in the pool if ANY of its WCM author rows attributes the
        // paper to the topic. We do NOT pre-filter by role here.
      },
    },
    orderBy: [{ year: "desc" }, { score: "desc" }],
  });

  if (rows.length === 0) {
    logSparseHide(
      "topic_recent_highlights",
      0,
      RECENT_HIGHLIGHTS_FLOOR,
      topicSlug,
    );
    return null;
  }

  // Dedupe pmids (the same paper may have multiple per-author rows).
  const pmidStrings = Array.from(new Set(rows.map((r) => String(r.pmid))));

  // Fetch publication metadata + WCM author chip data, hard-excluding bad types.
  const pubs = await prisma.publication.findMany({
    where: {
      pmid: { in: pmidStrings },
      publicationType: { notIn: ["Letter", "Editorial Article", "Erratum"] },
    },
    include: {
      authors: {
        where: {
          isConfirmed: true,
          scholar: { deletedAt: null, status: "active" },
        },
        orderBy: [{ isFirst: "desc" }, { isLast: "desc" }, { position: "asc" }],
        include: {
          scholar: {
            select: {
              cwid: true,
              slug: true,
              preferredName: true,
              status: true,
              deletedAt: true,
            },
          },
        },
      },
    },
  });
  const pubByPmid = new Map(pubs.map((p) => [p.pmid, p]));

  // For score lookup we want the highest publication_topic score per pmid (a
  // pmid may have multiple per-author rows in the topic; collapse them).
  const bestRowByPmid = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = String(r.pmid);
    const existing = bestRowByPmid.get(key);
    if (!existing || Number(r.score) > Number(existing.score)) {
      bestRowByPmid.set(key, r);
    }
  }

  // Score each unique pmid via the recent_highlights curve.
  const scored: Array<{
    pub: (typeof pubs)[number];
    score: number;
  }> = [];
  for (const [pmid, pub] of pubByPmid) {
    const r = bestRowByPmid.get(pmid);
    if (!r) continue;
    const rankable: RankablePublication = {
      pmid,
      publicationType: pub.publicationType,
      reciteraiImpact: Number(r.score),
      dateAddedToEntrez: pub.dateAddedToEntrez,
      // For publication-centric scoring, scholarCentric=false makes
      // authorshipWeight return 1.0 regardless of position values here.
      authorship: { isFirst: false, isLast: false, isPenultimate: false },
      isConfirmed: true,
    };
    const score = scorePublication(rankable, "recent_highlights", false, now);
    if (score > 0) scored.push({ pub, score });
  }

  scored.sort((a, b) => b.score - a.score);

  if (scored.length < RECENT_HIGHLIGHTS_FLOOR) {
    logSparseHide(
      "topic_recent_highlights",
      scored.length,
      RECENT_HIGHLIGHTS_FLOOR,
      topicSlug,
    );
    return null;
  }

  return scored.slice(0, RECENT_HIGHLIGHTS_TARGET).map(({ pub }) => ({
    pmid: pub.pmid,
    title: pub.title,
    journal: pub.journal,
    year: pub.year,
    pubmedUrl: pub.pubmedUrl ?? null,
    doi: pub.doi ?? null,
    authors: pub.authors.slice(0, 5).map((a) => ({
      cwid: a.cwid ?? null,
      slug: a.scholar?.slug ?? null,
      preferredName:
        a.scholar?.preferredName ?? a.externalName ?? "—",
    })),
    // No citation-count field — locked by design spec v1.7.1.
  }));
}
