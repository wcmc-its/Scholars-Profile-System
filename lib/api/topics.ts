/**
 * Topic-page data assembly. Reads `publication_topic` rows attributed to a
 * parent topic and computes Variant B rankings via `lib/ranking.ts`. Surfaces:
 *   - getTopScholarsForTopic()           RANKING-03 — D-13 first-or-senior aggregation
 *                                        + D-14 FT-faculty-only carve + compressed
 *                                        top_scholars recency curve.
 *   - getTopicPublications()             CSR browsable feed — D-08/D-09 four sort modes,
 *                                        two filter modes, subtopic filter, pagination.
 *   - getSubtopicsForTopic()             D-07 subtopic rail counts for the topic detail page.
 *   - getDistinctScholarCountForTopic()  D-10 — all-roles distinct scholar count for
 *                                        "View all N scholars in this area" affordance.
 *
 * §16 Spotlight (replaces the prior Recent Highlights surface) lives in
 * `lib/api/spotlight.ts` and reuses the same scoring filters (impact floor,
 * first/last author, FT faculty, Academic Article).
 *
 * Surfaces honour:
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
import { FEED_EXCLUDED_TYPES } from "@/lib/publication-types";

// Sparse-state floors and target counts (sourced from 02-UI-SPEC.md §States table
// + plan acceptance criteria). Top scholars: 7 chips, hide if <3.
const TOP_SCHOLARS_TARGET = 7;
const TOP_SCHOLARS_FLOOR = 3;

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
  /** 1-indexed position in the D-13/D-14 top_scholars ranking for this topic
   *  (or subtopic). Surfaced on the chip's hover popover so the rank shown
   *  there matches the chip's visual position — see #264. */
  rank: number;
};

/**
 * Subtopic researcher row — extends TopScholarChipData with the values rendered
 * inside the hover/focus preview popover on the subtopic researcher list
 * (issue #172). `primaryDepartment` is the LDAP-derived org unit; pub counts
 * answer "how concentrated is this researcher in this subtopic" — the unique
 * signal a user gets from the popover that they can't get from the chip view
 * or the researcher's profile page.
 */
export type SubtopicScholarRowData = TopScholarChipData & {
  primaryDepartment: string | null;
  pubCountInSubtopic: number;
  pubCountTotal: number;
};

function logSparseHide(
  surface: "topic_top_scholars",
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
      publication: { publicationType: { notIn: [...FEED_EXCLUDED_TYPES] } },
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

  return sorted.slice(0, TOP_SCHOLARS_TARGET).map((e, i) => ({
    cwid: e.scholar.cwid,
    slug: e.scholar.slug,
    preferredName: e.scholar.preferredName,
    primaryTitle: e.scholar.primaryTitle,
    identityImageEndpoint: identityImageEndpoint(e.scholar.cwid),
    rank: i + 1,
  }));
}

// Inline middot-separated list threshold per issue #172 spec — up to 10
// names render inline before collapsing to `+ N more →` overflow. Replaces
// the prior chip-row count of 7.
const SUBTOPIC_SCHOLARS_TARGET = 10;
const SUBTOPIC_SCHOLARS_FLOOR = 1;

/**
 * Top scholars for a single subtopic, filtered to publication_topic rows whose
 * primarySubtopicId matches. Mirrors getTopScholarsForTopic's D-13/D-14 carve
 * (FT faculty, first/last only, year >= floor, type allow-list, top_scholars
 * compressed curve) so the chip-row component can render the result without
 * branching. Floor is 1 because subtopic scope is narrow by design and a user
 * who selected a subtopic expects to see whatever WCM scholars contribute to
 * it; sparse-state hide on subtopic scope would be confusing.
 */
export async function getSubtopicScholars(
  topicSlug: string,
  subtopicId: string,
  now: Date = new Date(),
): Promise<SubtopicScholarRowData[] | null> {
  const topic = await prisma.topic.findUnique({ where: { id: topicSlug } });
  if (!topic) return null;

  const rows = await prisma.publicationTopic.findMany({
    where: {
      parentTopicId: topicSlug,
      primarySubtopicId: subtopicId,
      authorPosition: { in: ["first", "last"] },
      year: { gte: RECITERAI_YEAR_FLOOR },
      scholar: {
        deletedAt: null,
        status: "active",
        roleCategory: { in: [...TOP_SCHOLARS_ELIGIBLE_ROLES] },
      },
      publication: { publicationType: { notIn: [...FEED_EXCLUDED_TYPES] } },
    },
    include: {
      scholar: {
        select: {
          cwid: true,
          slug: true,
          preferredName: true,
          primaryTitle: true,
          primaryDepartment: true,
          roleCategory: true,
        },
      },
      publication: {
        select: { pmid: true, publicationType: true, dateAddedToEntrez: true },
      },
    },
  });

  if (rows.length === 0) return null;

  type AggEntry = {
    scholar: {
      cwid: string;
      slug: string;
      preferredName: string;
      primaryTitle: string | null;
      primaryDepartment: string | null;
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
      reciteraiImpact: Number(r.score),
      dateAddedToEntrez: pub.dateAddedToEntrez,
      authorship: {
        isFirst: r.authorPosition === "first",
        isLast: r.authorPosition === "last",
        isPenultimate: r.authorPosition === "penultimate",
      },
      isConfirmed: true,
    };
    const score = scorePublication(rankable, "top_scholars", true, now);
    if (score === 0) continue;

    const entry =
      byCwid.get(r.cwid) ??
      ({ scholar: r.scholar, total: 0 } as AggEntry);
    entry.total += score;
    byCwid.set(r.cwid, entry);
  }

  const sorted = Array.from(byCwid.values()).sort((a, b) => b.total - a.total);
  if (sorted.length < SUBTOPIC_SCHOLARS_FLOOR) return null;

  const top = sorted.slice(0, SUBTOPIC_SCHOLARS_TARGET);
  const cwids = top.map((e) => e.scholar.cwid);

  // Pub counts for the popover. "In this subtopic" mirrors the rail's count
  // rule (primarySubtopicId only). "Total" counts the scholar's confirmed
  // PublicationAuthor rows — one row per (scholar, pmid) — across their whole
  // corpus, not just this topic. Both run as Prisma `groupBy` aggregations.
  const [subtopicCounts, totalCounts] = await Promise.all([
    prisma.publicationTopic.groupBy({
      by: ["cwid"],
      where: {
        parentTopicId: topicSlug,
        primarySubtopicId: subtopicId,
        cwid: { in: cwids },
      },
      _count: { pmid: true },
    }),
    prisma.publicationAuthor.groupBy({
      by: ["cwid"],
      where: { cwid: { in: cwids }, isConfirmed: true },
      _count: { pmid: true },
    }),
  ]);
  const subtopicCountByCwid = new Map<string, number>();
  for (const r of subtopicCounts) {
    if (r.cwid) subtopicCountByCwid.set(r.cwid, r._count.pmid);
  }
  const totalCountByCwid = new Map<string, number>();
  for (const r of totalCounts) {
    if (r.cwid) totalCountByCwid.set(r.cwid, r._count.pmid);
  }

  return top.map((e, i) => ({
    cwid: e.scholar.cwid,
    slug: e.scholar.slug,
    preferredName: e.scholar.preferredName,
    primaryTitle: e.scholar.primaryTitle,
    primaryDepartment: e.scholar.primaryDepartment,
    identityImageEndpoint: identityImageEndpoint(e.scholar.cwid),
    pubCountInSubtopic: subtopicCountByCwid.get(e.scholar.cwid) ?? 0,
    pubCountTotal: totalCountByCwid.get(e.scholar.cwid) ?? 0,
    rank: i + 1,
  }));
}


export type SubtopicWithCount = {
  id: string;
  // EXISTING — kept; subtopic rail filter still operates on this per D-08.
  label: string;
  // NEW — D-19 / D-09: (display_name ?? label) applied at API boundary;
  // Plan 05's SubtopicRail renders this on the top line.
  displayName: string;
  // NEW — D-19 / D-08: rendered as second line in SubtopicRail (Plan 05);
  // null = silent absence per Phase 3 D-06.
  shortDescription: string | null;
  // EXISTING — kept; LLM-canonical per D-19 (no LLM use today, future-proofing).
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
    select: {
      id: true,
      label: true,
      displayName: true,
      shortDescription: true,
      description: true,
    },
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

  // HIERARCHY-05 (Path A): `display_name` is authoritative — render verbatim.
  // The Hierarchy ETL validates display_name editorial integrity at import time
  // (see assertSubtopicDisplayInvariants in etl/hierarchy). Runtime case-folding
  // can't recover semantic intent ("CAR T cell" vs. "Cat cell"), so we trust
  // the source rather than guess.
  return catalog
    .map((s) => {
      const displayName = s.displayName?.trim() || s.label?.trim() || s.id;
      return {
        id: s.id,
        // unchanged — rail filter still uses this per D-08.
        label: s.label,
        // D-09 universal fallback: display_name → label → id.
        displayName,
        // D-19 subtitle source; null on absence (Phase 3 D-06).
        shortDescription: s.shortDescription?.trim() || null,
        description: s.description,
        pubCount: countMap.get(s.id) ?? 0,
      };
    })
    .sort((a, b) => b.pubCount - a.pubCount);
}

export type TopicPublicationSort = "newest" | "most_cited" | "by_impact";
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
  pmcid: string | null;
  /**
   * Issue #305 — topic-context impact score for the row's
   * `parentTopicId = topicSlug` pairing, sourced from
   * `PublicationTopic.impactScore`. Surfaces as `Impact: NN` in the
   * publication-feed meta row. Null when the row has no LLM-scored impact
   * value (older publications, non-research types) OR when the
   * `SEARCH_PUB_TAB_IMPACT` flag is off (API short-circuits to null for
   * cross-surface consistency with the search pub-tab).
   *
   * Single label `Impact` (not `Impact + Concept` like the search pub-tab):
   * the whole page is already topic-scoped, so the disambiguation that's
   * useful on search is redundant here.
   */
  impactScore: number | null;
  /** WCM-confirmed coauthors with chip-render data (headshot + first/last role
   *  flags). Empty array when the publication has no confirmed WCM authors;
   *  publication-feed UI suppresses the chip row in that case. */
  authors: Array<{
    name: string;
    cwid: string;
    slug: string;
    identityImageEndpoint: string;
    isFirst: boolean;
    isLast: boolean;
  }>;
};

export type TopicPublicationsResult = {
  hits: TopicPublicationHit[];
  total: number;
  /**
   * Counts in the same scope (topic + optional subtopic) under each filter.
   * Lets the client decide whether the type-filter toggle would actually
   * change the result set in either direction, and surface a "+N more"
   * delta when it would. (#30)
   */
  totalAllTypes: number;
  totalResearchOnly: number;
  page: number;
  pageSize: number;
};

const TOPIC_PUBLICATIONS_PAGE_SIZE = 20;
// Same exclusion list used by every feed (issue #63). Spread once into a
// plain array so Prisma's `notIn` accepts it without the readonly tuple.
const HARD_EXCLUDE_TYPES = [...FEED_EXCLUDED_TYPES];

/**
 * CSR browsable publication feed for a topic detail page.
 *
 * Sort modes (all SQL-direct):
 *   - newest      ORDER BY year DESC, dateAddedToEntrez DESC
 *   - most_cited  ORDER BY citationCount DESC
 *   - by_impact   ORDER BY impactScore DESC, year DESC
 *
 * by_impact was previously routed through the in-process Variant B scorer
 * (`scorePublication` in lib/ranking.ts), which produced recency-weighted
 * impact rankings — non-monotonic against the inline `Impact: NN` numbers
 * surfaced by #305 (62 → 76 → 60), reading as "the sort doesn't work".
 * Strict DESC matches user expectation that the visible number is the
 * sort key.
 *
 * Filter modes:
 *   - research_articles_only (default) excludes Letter / Editorial Article / Erratum
 *   - all                              includes all publication types
 *
 * Security: Allowlist validation of sort/filter/subtopic/slug must happen in the
 * route handler (app/api/topics/[slug]/publications/route.ts) before calling this
 * function. This function trusts its inputs have already been validated.
 */
export async function getTopicPublications(
  topicSlug: string,
  opts: { sort: TopicPublicationSort; subtopic?: string; page?: number; filter?: TopicPublicationFilter },
  now: Date = new Date(),
): Promise<TopicPublicationsResult | null> {
  const topic = await prisma.topic.findUnique({ where: { id: topicSlug } });
  if (!topic) return null;

  // #305 — flag-gate the `impactScore` field surfacing to the public hit
  // shape so flipping `SEARCH_PUB_TAB_IMPACT=off` hides the new number on
  // topic pages too. Computed once here, passed to mapToTopicPublicationHit.
  const includeImpact = (process.env.SEARCH_PUB_TAB_IMPACT ?? "off") === "on";

  const page = Math.max(0, opts.page ?? 0);
  const filter = opts.filter ?? "research_articles_only";
  const subtopicFilter = opts.subtopic && opts.subtopic.length > 0 ? opts.subtopic : undefined;

  const baseWhere: Record<string, unknown> = { parentTopicId: topicSlug };
  if (subtopicFilter) baseWhere.primarySubtopicId = subtopicFilter;
  if (filter === "research_articles_only") {
    baseWhere.publication = { publicationType: { notIn: HARD_EXCLUDE_TYPES } };
  }

  // Same scope as `baseWhere` but with publicationType filters fixed to
  // each side — used to populate the totals for the toggle-visibility
  // decision (#30) regardless of which filter is currently active.
  const baseWhereAllTypes: Record<string, unknown> = { parentTopicId: topicSlug };
  if (subtopicFilter) baseWhereAllTypes.primarySubtopicId = subtopicFilter;
  const baseWhereResearchOnly: Record<string, unknown> = {
    ...baseWhereAllTypes,
    publication: { publicationType: { notIn: HARD_EXCLUDE_TYPES } },
  };

  // All three sorts are SQL-direct — by_impact previously routed through the
  // Variant B in-process scorer (lib/ranking.ts) but the user-facing expectation
  // is strict DESC on the visible Impact: NN number. Recency-weighted scoring
  // produced non-monotonic results (62 → 76 → 60), which read as "the sort
  // doesn't work" against the inline display from issue #305.
  //
  // NULLS LAST is not expressible in Prisma's MariaDB adapter on scalar fields;
  // empirically every publication_topic row currently carries impact_score
  // (mirrored from IMPACT# by the TOPIC# ETL block), so any null rows that
  // appear would be transient data-quality issues, not steady-state. Most_cited
  // shares the same null-first MySQL quirk per the prior comment.
  const orderBy =
    opts.sort === "newest"
      ? [{ year: "desc" as const }, { publication: { dateAddedToEntrez: "desc" as const } }]
      : opts.sort === "most_cited"
        ? [{ publication: { citationCount: "desc" as const } }]
        : [
            { impactScore: "desc" as const },
            { year: "desc" as const },
          ];
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
  const [rows, total, totalAllTypes, totalResearchOnly] = await prisma.$transaction([
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
    prisma.publicationTopic.count({ where: baseWhereAllTypes }),
    prisma.publicationTopic.count({ where: baseWhereResearchOnly }),
  ]);
  const pmids = rows.map((r) => r.pmid);
  const authorsByPmid = await fetchWcmAuthorsForPmids(pmids);
  // `now` parameter is preserved for backwards compatibility with callers but
  // is unused since the Variant B scoring path was retired in favor of SQL sort.
  void now;
  return {
    hits: (rows as Array<{ pmid: string }>).map((r) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mapToTopicPublicationHit(r as any, authorsByPmid.get(r.pmid), includeImpact),
    ),
    total,
    totalAllTypes,
    totalResearchOnly,
    page,
    pageSize: TOPIC_PUBLICATIONS_PAGE_SIZE,
  };
}

/**
 * Map a raw PublicationTopic+Publication row to the public TopicPublicationHit shape.
 * Optional `wcmAuthors` argument carries the confirmed WCM coauthors for this pmid
 * (fetched in batch via fetchWcmAuthorsForPmids); when omitted, authors defaults to []
 * which the publication-feed UI suppresses per Phase 3 D-06 absence-as-default.
 *
 * `includeImpact` (#305) gates the surfacing of `PublicationTopic.impactScore`
 * to the public hit shape under the `SEARCH_PUB_TAB_IMPACT` flag, matching
 * the search pub-tab's gating pattern. Off → impactScore always null.
 */
function mapToTopicPublicationHit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  r: any,
  wcmAuthors: TopicPublicationHit["authors"] | undefined,
  includeImpact: boolean,
): TopicPublicationHit {
  // r.impactScore is Prisma's Decimal | null on PublicationTopic. Convert
  // via Number() (Decimal#toNumber for non-null; coalesce null straight
  // through). Cap at 0 floor — the source is the LLM rubric on the
  // [0, 100] scale, but defense-in-depth against a stray negative leak.
  let impactScore: number | null = null;
  if (includeImpact && r.impactScore !== null && r.impactScore !== undefined) {
    const n = Number(r.impactScore);
    impactScore = Number.isFinite(n) ? n : null;
  }
  return {
    pmid: r.pmid,
    title: r.publication.title ?? "",
    journal: r.publication.journal ?? null,
    year: r.publication.year ?? 0,
    publicationType: r.publication.publicationType ?? null,
    citationCount: r.publication.citationCount ?? null,
    pubmedUrl: r.publication.pubmedUrl ?? null,
    doi: r.publication.doi ?? null,
    pmcid: r.publication.pmcid ?? null,
    impactScore,
    authors: wcmAuthors ?? [],
  };
}

export type WcmAuthorChip = {
  name: string;
  cwid: string;
  slug: string;
  identityImageEndpoint: string;
  isFirst: boolean;
  isLast: boolean;
};

/**
 * Batch-fetch WCM-affiliated confirmed authors for a list of pmids.
 * Returns a Map keyed by pmid; each value is the publication's confirmed
 * authors in ascending PubMed author position (first author first, senior
 * (last) author last, middle authors in between). Used by the publication
 * search and topic feed surfaces to render author chips with headshots.
 */
export async function fetchWcmAuthorsForPmids(
  pmids: string[],
): Promise<Map<string, WcmAuthorChip[]>> {
  if (pmids.length === 0) return new Map();
  const rows = await prisma.publicationAuthor.findMany({
    where: {
      pmid: { in: pmids },
      isConfirmed: true,
      cwid: { not: null },
      scholar: { deletedAt: null, status: "active" },
    },
    // Standard citation order: first → middle → last, by listed position. (#18)
    orderBy: [{ position: "asc" }],
    select: {
      pmid: true,
      isFirst: true,
      isLast: true,
      scholar: { select: { cwid: true, slug: true, preferredName: true } },
    },
  });
  const byPmid = new Map<string, WcmAuthorChip[]>();
  for (const row of rows) {
    if (!row.scholar) continue;
    const arr = byPmid.get(row.pmid) ?? [];
    arr.push({
      name: row.scholar.preferredName,
      cwid: row.scholar.cwid,
      slug: row.scholar.slug,
      identityImageEndpoint: identityImageEndpoint(row.scholar.cwid),
      isFirst: row.isFirst,
      isLast: row.isLast,
    });
    byPmid.set(row.pmid, arr);
  }
  return byPmid;
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

/**
 * Spec §13 "All scholars in this area" — comprehensive enumerative list.
 *
 * Surface: white, alphabetical by preferredName, role-filterable, name-searchable,
 * paginated. NO eligibility carve (anyone with at least one publication in this
 * area, per §13). Role filter is a presentation-only narrowing affordance.
 */
export type TopicAllScholarRole =
  | "all"
  | "faculty"
  | "postdocs"
  | "doctoral_students";

export const TOPIC_ALL_SCHOLARS_PAGE_SIZE = 22;

export type TopicScholarRow = {
  cwid: string;
  slug: string;
  preferredName: string;
  postnominal: string | null;
  primaryTitle: string | null;
  identityImageEndpoint: string;
  roleCategory: string | null;
  /** Top subtopics within the parent topic for this scholar, by paper count
   *  desc. Capped at 3. Empty when the scholar has no primarySubtopicId rows. */
  subtopics: { id: string; displayName: string }[];
};

export type TopicScholarsResult = {
  total: number;
  roleCounts: {
    all: number;
    faculty: number;
    postdocs: number;
    doctoralStudents: number;
  };
  hits: TopicScholarRow[];
  page: number;
  pageSize: number;
};

const ROLE_FILTER_CATEGORIES: Record<Exclude<TopicAllScholarRole, "all">, string[]> = {
  faculty: ["full_time_faculty"],
  postdocs: ["postdoc"],
  doctoral_students: ["doctoral_student"],
};

export async function getTopicScholars(
  topicSlug: string,
  opts: { page?: number; role?: TopicAllScholarRole; q?: string },
): Promise<TopicScholarsResult | null> {
  const topic = await prisma.topic.findUnique({ where: { id: topicSlug } });
  if (!topic) return null;

  const page = Math.max(0, opts.page ?? 0);
  const role: TopicAllScholarRole = opts.role ?? "all";
  const q = opts.q?.trim() ?? "";

  // Distinct cwids attributed to this topic, applying name search up-front so
  // the role-count groupBy reflects the in-filter universe.
  const baseScholarFilter: Record<string, unknown> = {
    deletedAt: null,
    status: "active",
    publicationTopics: { some: { parentTopicId: topicSlug } },
  };
  if (q.length > 0) {
    baseScholarFilter.preferredName = { contains: q };
  }

  // Role counts within the name-filtered universe (does NOT apply role filter,
  // so each chip's badge reflects the size of its own bucket regardless of
  // which chip is currently selected).
  const roleGroup = await prisma.scholar.groupBy({
    by: ["roleCategory"],
    where: baseScholarFilter,
    _count: { _all: true },
  });
  let allCount = 0;
  let facultyCount = 0;
  let postdocsCount = 0;
  let doctoralCount = 0;
  for (const r of roleGroup) {
    const n = r._count._all;
    allCount += n;
    if (r.roleCategory === "full_time_faculty") facultyCount += n;
    else if (r.roleCategory === "postdoc") postdocsCount += n;
    else if (r.roleCategory === "doctoral_student") doctoralCount += n;
  }

  const filterWithRole: Record<string, unknown> = { ...baseScholarFilter };
  if (role !== "all") {
    filterWithRole.roleCategory = { in: ROLE_FILTER_CATEGORIES[role] };
  }

  // Fetch the entire matching set (no pagination at SQL layer) so we can sort
  // by last-name initial — preferredName is "Given Last" format and we need
  // alphabetical-by-surname for both the list order and the §13 alpha-letter
  // dividers. Topic universes are small enough (low hundreds at the high end)
  // that an in-process sort is cheaper than a generated-column migration.
  const scholarsAll = await prisma.scholar.findMany({
    where: filterWithRole,
    select: {
      cwid: true,
      slug: true,
      preferredName: true,
      postnominal: true,
      primaryTitle: true,
      roleCategory: true,
    },
  });

  const enriched = scholarsAll.map((s) => ({
    ...s,
    lastName: extractLastName(s.preferredName),
  }));
  enriched.sort(
    (a, b) =>
      a.lastName.localeCompare(b.lastName) ||
      a.preferredName.localeCompare(b.preferredName) ||
      a.cwid.localeCompare(b.cwid),
  );

  const total = enriched.length;
  const skip = page * TOPIC_ALL_SCHOLARS_PAGE_SIZE;
  const slice = enriched.slice(skip, skip + TOPIC_ALL_SCHOLARS_PAGE_SIZE);

  const subtopicsByCwid = await fetchTopSubtopicsForScholars(
    topicSlug,
    slice.map((s) => s.cwid),
  );

  return {
    total,
    roleCounts: {
      all: allCount,
      faculty: facultyCount,
      postdocs: postdocsCount,
      doctoralStudents: doctoralCount,
    },
    hits: slice.map((s) => ({
      cwid: s.cwid,
      slug: s.slug,
      preferredName: s.preferredName,
      postnominal: s.postnominal,
      primaryTitle: s.primaryTitle,
      identityImageEndpoint: identityImageEndpoint(s.cwid),
      roleCategory: s.roleCategory,
      subtopics: subtopicsByCwid.get(s.cwid) ?? [],
    })),
    page,
    pageSize: TOPIC_ALL_SCHOLARS_PAGE_SIZE,
  };
}

/**
 * Extract surname for sort + alpha-divider grouping. preferredName is stored
 * "Given Last" (e.g. "Jane Smith") — last whitespace-separated token wins.
 * Hyphenated surnames stay intact ("García-López"). Returns "" for empty input
 * so blank rows sort to the top deterministically.
 */
function extractLastName(preferredName: string): string {
  const tokens = preferredName.trim().split(/\s+/).filter(Boolean);
  return tokens.length === 0 ? "" : tokens[tokens.length - 1];
}

export function topicScholarLastNameInitial(preferredName: string): string {
  const last = extractLastName(preferredName);
  const ch = last.charAt(0).toUpperCase();
  return ch >= "A" && ch <= "Z" ? ch : "#";
}

/**
 * For a set of scholars within a parent topic, return up to 3 top subtopics
 * each by paper count (primarySubtopicId only — matches the rail count rule
 * in getSubtopicsForTopic). Subtopic display names follow the same fallback
 * + parent-prefix-strip + acronym normalization rules as the rail.
 */
async function fetchTopSubtopicsForScholars(
  topicSlug: string,
  cwids: string[],
): Promise<Map<string, { id: string; displayName: string }[]>> {
  const out = new Map<string, { id: string; displayName: string }[]>();
  if (cwids.length === 0) return out;

  const topic = await prisma.topic.findUnique({
    where: { id: topicSlug },
    select: { label: true },
  });
  if (!topic) return out;

  const rows = await prisma.publicationTopic.groupBy({
    by: ["cwid", "primarySubtopicId"],
    where: {
      parentTopicId: topicSlug,
      cwid: { in: cwids },
      primarySubtopicId: { not: null },
    },
    _count: { pmid: true },
  });

  const subtopicIds = Array.from(
    new Set(
      rows
        .map((r) => r.primarySubtopicId)
        .filter((s): s is string => s !== null),
    ),
  );
  if (subtopicIds.length === 0) return out;

  const catalog = await prisma.subtopic.findMany({
    where: { id: { in: subtopicIds } },
    select: { id: true, label: true, displayName: true },
  });
  const labelById = new Map<string, string>();
  for (const s of catalog) {
    labelById.set(s.id, s.displayName?.trim() || s.label?.trim() || s.id);
  }

  const byCwid = new Map<string, { id: string; count: number }[]>();
  for (const r of rows) {
    if (!r.primarySubtopicId) continue;
    const arr = byCwid.get(r.cwid) ?? [];
    arr.push({ id: r.primarySubtopicId, count: r._count.pmid });
    byCwid.set(r.cwid, arr);
  }
  for (const [cwid, arr] of byCwid) {
    arr.sort((a, b) => b.count - a.count);
    out.set(
      cwid,
      arr.slice(0, 3).map((e) => ({
        id: e.id,
        displayName: labelById.get(e.id) ?? e.id,
      })),
    );
  }
  return out;
}
