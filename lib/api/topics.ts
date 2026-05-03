/**
 * Topic-page data assembly. Reads `publication_topic` rows attributed to a
 * parent topic and computes Variant B rankings via `lib/ranking.ts`. Three
 * surfaces:
 *   - getTopScholarsForTopic()           RANKING-03 — D-13 first-or-senior aggregation
 *                                        + D-14 FT-faculty-only carve + compressed
 *                                        top_scholars recency curve.
 *   - getRecentHighlightsForTopic()      RANKING-02 — publication-centric pool
 *                                        (no author-position filter), recent_highlights
 *                                        curve, dedup-per-pmid.
 *   - getTopicPublications()             CSR browsable feed — D-08/D-09 four sort modes,
 *                                        two filter modes, subtopic filter, pagination.
 *   - getSubtopicsForTopic()             D-07 subtopic rail counts for the topic detail page.
 *   - getDistinctScholarCountForTopic()  D-10 — all-roles distinct scholar count for
 *                                        "View all N scholars in this area" affordance.
 *
 * Both surfaces honour:
 *   - D-12 sparse-state hide (return null + emit structured warn log).
 *   - D-15 ReCiterAI scoring data floor (year >= 2020).
 *   - design spec v1.7.1: hard-exclude Letter / Editorial Article / Erratum.
 *   - design spec v1.7.1: no citation count on either output type.
 *
 * Schema shape: D-02 candidate (e). `topic.id` IS the slug. `publication_topic`
 * is the (publication × scholar × parent_topic) triple table; `author_position`
 * already encodes first/last; the table FK-relates to `publication` (both
 * VARCHAR(32) on pmid), so paper metadata is fetched via Prisma
 * `include: { publication }` directly.
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

export async function getTopic(slug: string) {
  return prisma.topic.findUnique({ where: { id: slug } });
}

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
  // narrowed carve. Publication metadata included via FK relation.
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
      publication: { publicationType: { notIn: ["Letter", "Editorial Article", "Erratum"] } },
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
      publication: {
        select: { pmid: true, publicationType: true, dateAddedToEntrez: true },
      },
    },
  });

  if (rows.length === 0) {
    logSparseHide("topic_top_scholars", 0, TOP_SCHOLARS_FLOOR, topicSlug);
    return null;
  }

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
    const pub = r.publication;

    const rankable: RankablePublication = {
      pmid: r.pmid,
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
  const pmidStrings = Array.from(new Set(rows.map((r) => r.pmid)));

  // Fetch publication metadata + WCM author chip data. The author-chip include
  // uses the existing publication.authors relation (PublicationAuthor); the
  // publication_topic FK is used by the rows query above. Hard-exclude bad
  // types here since publication-centric. (Could be inverted to a single
  // publication.findMany with a publicationTopics: { some } filter; current
  // shape preserves per-pmid score lookup which the dedup loop below needs.)
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
    const existing = bestRowByPmid.get(r.pmid);
    if (!existing || Number(r.score) > Number(existing.score)) {
      bestRowByPmid.set(r.pmid, r);
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

export type SubtopicWithCount = {
  id: string;
  label: string;
  description: string | null;
  pubCount: number;
};

/**
 * Returns all subtopics for a topic with pubCount per subtopic for rail ordering.
 *
 * Implements D-07: count by primarySubtopicId only (not the union with subtopicIds
 * JSON array) for query performance. Subtopics with pubCount 0 are included; they
 * render below the "Less common" divider in the rail.
 *
 * Design note: counting via primarySubtopicId only was chosen over the union of
 * primarySubtopicId + subtopicIds JSON array. The JSON array union approach was
 * considered and rejected — it requires application-side JSON parsing on every row
 * in the pool (O(n) per row), cannot be indexed, and the additional coverage
 * (secondary subtopics) is editorial value that doesn't justify the cost.
 */
export async function getSubtopicsForTopic(topicSlug: string): Promise<SubtopicWithCount[] | null> {
  const topic = await prisma.topic.findUnique({ where: { id: topicSlug } });
  if (!topic) return null;

  const catalog = await prisma.subtopic.findMany({
    where: { parentTopicId: topicSlug },
    select: { id: true, label: true, description: true },
  });

  const countRows = await prisma.publicationTopic.groupBy({
    by: ["primarySubtopicId"],
    where: { parentTopicId: topicSlug, primarySubtopicId: { not: null } },
    _count: { pmid: true },
  });
  const countMap = new Map<string, number>();
  for (const r of countRows) {
    if (r.primarySubtopicId) countMap.set(r.primarySubtopicId, r._count.pmid);
  }

  return catalog
    .map((s) => ({ id: s.id, label: s.label, description: s.description, pubCount: countMap.get(s.id) ?? 0 }))
    .sort((a, b) => b.pubCount - a.pubCount);
}

export type TopicPublicationSort = "newest" | "most_cited" | "by_impact" | "curated";
export type TopicPublicationFilter = "research_articles_only" | "all";

export type TopicPublicationHit = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number;
  publicationType: string | null;
  citationCount: number | null;
  pubmedUrl: string | null;
  doi: string | null;
  authors: Array<{ name: string; cwid?: string; slug?: string }>;
};

export type TopicPublicationsResult = {
  hits: TopicPublicationHit[];
  total: number;
  page: number;
  pageSize: number;
};

const TOPIC_PUBLICATIONS_PAGE_SIZE = 20;
const HARD_EXCLUDE_TYPES = ["Letter", "Editorial Article", "Erratum"];

/**
 * CSR browsable publication feed for a topic detail page.
 *
 * Sort modes:
 *   - newest      SQL ORDER BY year DESC, dateAddedToEntrez DESC
 *   - most_cited  SQL ORDER BY citationCount DESC NULLS LAST
 *   - by_impact   In-process Variant B: scorePublication(row, "recent_highlights", false)
 *   - curated     Same Variant B scoring as by_impact (surface alias per D-09)
 *
 * Filter modes:
 *   - research_articles_only (default) excludes Letter / Editorial Article / Erratum
 *   - all                              includes all publication types
 *
 * Security: Allowlist validation of sort/filter/subtopic/slug must happen in the
 * route handler (app/api/topics/[slug]/publications/route.ts) before calling this
 * function. This function trusts its inputs have already been validated.
 *
 * Pool limit: by_impact/curated use POOL_LIMIT=5000 for DoS mitigation per
 * 03-RESEARCH.md threat table. Page clamped to MAX_PAGE=500 in route handler.
 */
export async function getTopicPublications(
  topicSlug: string,
  opts: { sort: TopicPublicationSort; subtopic?: string; page?: number; filter?: TopicPublicationFilter },
  now: Date = new Date(),
): Promise<TopicPublicationsResult | null> {
  const topic = await prisma.topic.findUnique({ where: { id: topicSlug } });
  if (!topic) return null;

  const page = Math.max(0, opts.page ?? 0);
  const filter = opts.filter ?? "research_articles_only";
  const subtopicFilter = opts.subtopic && opts.subtopic.length > 0 ? opts.subtopic : undefined;

  const baseWhere: Record<string, unknown> = { parentTopicId: topicSlug };
  if (subtopicFilter) baseWhere.primarySubtopicId = subtopicFilter;
  if (filter === "research_articles_only") {
    baseWhere.publication = { publicationType: { notIn: HARD_EXCLUDE_TYPES } };
  }

  // SQL-direct sort path (newest, most_cited) — do NOT call scorePublication here.
  if (opts.sort === "newest" || opts.sort === "most_cited") {
    // most_cited: sort DESC. MySQL/MariaDB do not support NULLS LAST natively in
    // older versions; Prisma 7 with mariadb adapter does not expose a nulls option
    // on scalar fields. Rows with NULL citationCount will sort first under DESC
    // (NULL > value in MySQL). The route handler clamps page to MAX_PAGE so the
    // null rows only affect the first page for datasets where all rows are null —
    // an acceptable trade-off vs. a raw SQL workaround per 03-RESEARCH.md.
    const orderBy =
      opts.sort === "newest"
        ? [{ year: "desc" as const }, { publication: { dateAddedToEntrez: "desc" as const } }]
        : [{ publication: { citationCount: "desc" as const } }];
    const skip = page * TOPIC_PUBLICATIONS_PAGE_SIZE;
    const pubSelectFields = {
      pmid: true,
      title: true,
      journal: true,
      year: true,
      publicationType: true,
      citationCount: true,
      pubmedUrl: true,
      doi: true,
      dateAddedToEntrez: true,
    } as const;
    const [rows, total] = await prisma.$transaction([
      prisma.publicationTopic.findMany({
        where: baseWhere,
        skip,
        take: TOPIC_PUBLICATIONS_PAGE_SIZE,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        orderBy: orderBy as any,
        distinct: ["pmid"],
        include: { publication: { select: pubSelectFields } },
      }),
      prisma.publicationTopic.count({ where: baseWhere }),
    ]);
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hits: (rows as any[]).map(mapToTopicPublicationHit),
      total,
      page,
      pageSize: TOPIC_PUBLICATIONS_PAGE_SIZE,
    };
  }

  // In-process Variant B scoring path (by_impact, curated).
  // Pool size: 5000 covers ≤500 page bound × 20 = 10k ceiling per 03-RESEARCH.md DoS mitigation.
  const POOL_LIMIT = 5000;
  const candidates = await prisma.publicationTopic.findMany({
    where: baseWhere,
    take: POOL_LIMIT,
    distinct: ["pmid"],
    include: {
      publication: {
        select: {
          pmid: true,
          title: true,
          journal: true,
          year: true,
          publicationType: true,
          citationCount: true,
          pubmedUrl: true,
          doi: true,
          dateAddedToEntrez: true,
        },
      },
    },
  });

  const scored = candidates.map((r) => {
    const rankable: RankablePublication = {
      pmid: r.pmid,
      publicationType: r.publication.publicationType ?? "",
      reciteraiImpact: Number(r.score),
      dateAddedToEntrez: r.publication.dateAddedToEntrez ?? new Date(0),
      // Publication-centric surface: scholarCentric=false makes authorshipWeight=1.0
      // regardless of position, per D-13 (no first/senior filter on topic pub feed).
      authorship: { isFirst: false, isLast: false, isPenultimate: false },
      isConfirmed: true,
    };
    return { row: r, score: scorePublication(rankable, "recent_highlights", false, now) };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.row.publication.year ?? 0) - (a.row.publication.year ?? 0);
  });

  const total = scored.length;
  const slice = scored.slice(page * TOPIC_PUBLICATIONS_PAGE_SIZE, (page + 1) * TOPIC_PUBLICATIONS_PAGE_SIZE);
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hits: slice.map((s) => mapToTopicPublicationHit(s.row as any)),
    total,
    page,
    pageSize: TOPIC_PUBLICATIONS_PAGE_SIZE,
  };
}

/**
 * Map a raw PublicationTopic+Publication row to the public TopicPublicationHit shape.
 * Authors field: returns empty array for first pass; Plan 07 may enrich if author
 * chips are required by the UI spec. The existing getRecentHighlightsForTopic pattern
 * uses a separate publication.findMany with included authors — that approach requires
 * a second query per page and is deferred until the UI contract is confirmed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapToTopicPublicationHit(r: any): TopicPublicationHit {
  return {
    pmid: r.pmid,
    title: r.publication.title ?? "",
    journal: r.publication.journal ?? null,
    year: r.publication.year ?? 0,
    publicationType: r.publication.publicationType ?? null,
    citationCount: r.publication.citationCount ?? null,
    pubmedUrl: r.publication.pubmedUrl ?? null,
    doi: r.publication.doi ?? null,
    // Authors deferred to Plan 07 UI integration. Returning [] here is intentional
    // (not a stub that blocks the feature — the publication card renders without
    // author chips on first pass per design spec v1.7.1 absence-as-default).
    authors: [],
  };
}

/**
 * D-10 — Distinct active-scholar count for a topic.
 *
 * Powers the "View all N scholars in this area →" affordance on the topic page.
 * All-roles count (NO eligibility carve) — this is an enumerative surface, not
 * algorithmic. Returns 0 when the topic has no attributed scholars.
 */
export async function getDistinctScholarCountForTopic(topicSlug: string): Promise<number> {
  const distinctRows = await prisma.publicationTopic.groupBy({
    by: ["cwid"],
    where: {
      parentTopicId: topicSlug,
      scholar: { deletedAt: null, status: "active" },
    },
    _count: { _all: true },
  });
  return distinctRows.length;
}
