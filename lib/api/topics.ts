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
  /**
   * Up to 5 confirmed WCM coauthors with the chip-row payload (avatar +
   * first/senior signal). Same shape `AuthorChipRow` consumes elsewhere.
   * (#15)
   */
  authors: Array<{
    name: string;
    cwid: string;
    slug: string;
    identityImageEndpoint: string;
    isFirst: boolean;
    isLast: boolean;
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
/**
 * #15: Recent Highlights uses a deterministic filter + most-recent sort
 * instead of the previous recency-curve scoring path.
 *
 *   - publicationType = "Academic Article"
 *   - scholar.role_category = "full_time_faculty"
 *   - publication_topic.author_position IN ('first', 'last')
 *   - publication_topic.score >= RECENT_HIGHLIGHTS_IMPACT_FLOOR
 *   - year >= RECITERAI_YEAR_FLOOR (2020+)
 *
 * Sort: publication.dateAddedToEntrez DESC, ties by year DESC, score DESC.
 * Target 3, hide section if 0 qualify (sparse-state floor preserved).
 *
 * `now` retained for signature parity with the previous version (and the
 * existing tests). It's no longer consulted: selection no longer depends
 * on a recency curve.
 */
const RECENT_HIGHLIGHTS_IMPACT_FLOOR = 40;

export async function getRecentHighlightsForTopic(
  topicSlug: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _now: Date = new Date(),
): Promise<RecentHighlight[] | null> {
  const topic = await prisma.topic.findUnique({ where: { id: topicSlug } });
  if (!topic) return null;

  const rows = await prisma.publicationTopic.findMany({
    where: {
      parentTopicId: topicSlug,
      year: { gte: RECITERAI_YEAR_FLOOR }, // D-15
      score: { gte: RECENT_HIGHLIGHTS_IMPACT_FLOOR }, // #15: hard impact threshold
      authorPosition: { in: ["first", "last"] }, // #15: first or senior author
      scholar: {
        deletedAt: null,
        status: "active",
        roleCategory: "full_time_faculty", // #15: FT faculty only
      },
      publication: {
        publicationType: "Academic Article", // #15
      },
    },
    include: {
      publication: {
        select: {
          pmid: true,
          title: true,
          journal: true,
          year: true,
          publicationType: true,
          pubmedUrl: true,
          doi: true,
          dateAddedToEntrez: true,
        },
      },
    },
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

  // Dedupe per pmid — multiple WCM authors may attribute the same paper.
  // Keep the row with the highest score so the (impact-floor) tiebreaker
  // is stable.
  const bestByPmid = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const existing = bestByPmid.get(r.pmid);
    if (!existing || Number(r.score) > Number(existing.score)) {
      bestByPmid.set(r.pmid, r);
    }
  }

  const candidates = Array.from(bestByPmid.values());
  candidates.sort((a, b) => {
    const at = a.publication.dateAddedToEntrez?.getTime() ?? 0;
    const bt = b.publication.dateAddedToEntrez?.getTime() ?? 0;
    if (bt !== at) return bt - at;
    const ay = a.publication.year ?? 0;
    const by = b.publication.year ?? 0;
    if (by !== ay) return by - ay;
    return Number(b.score) - Number(a.score);
  });

  if (candidates.length < RECENT_HIGHLIGHTS_FLOOR) {
    logSparseHide(
      "topic_recent_highlights",
      candidates.length,
      RECENT_HIGHLIGHTS_FLOOR,
      topicSlug,
    );
    return null;
  }

  const top = candidates.slice(0, RECENT_HIGHLIGHTS_TARGET);
  const topPmids = top.map((c) => c.pmid);
  const authorsByPmid = await fetchWcmAuthorsForPmids(topPmids);

  return top.map((c) => ({
    pmid: c.pmid,
    title: c.publication.title ?? "",
    journal: c.publication.journal ?? null,
    year: c.publication.year ?? null,
    pubmedUrl: c.publication.pubmedUrl ?? null,
    doi: c.publication.doi ?? null,
    authors: authorsByPmid.get(c.pmid) ?? [],
    // No citation-count field — locked by design spec v1.7.1.
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
/**
 * Known biomedical acronyms that should be uppercased when they appear as
 * lowercase/title-case words in ReCiterAI-generated subtopic labels.
 */
const BIOMEDICAL_ACRONYMS: Record<string, string> = {
  csf: "CSF", ml: "ML", ai: "AI", hiv: "HIV", mri: "MRI", mci: "MCI",
  ftd: "FTD", als: "ALS", pd: "PD", ad: "AD", eeg: "EEG", ct: "CT",
  dna: "DNA", rna: "RNA", gwas: "GWAS", crispr: "CRISPR",
  tdp43: "TDP-43", tdp: "TDP", fus: "FUS", sod1: "SOD1",
  ipsc: "iPSC", bbb: "BBB", tnf: "TNF", ace: "ACE", ms: "MS",
  tbi: "TBI", ptsd: "PTSD", ocd: "OCD", snp: "SNP", mrna: "mRNA",
  // Ophthalmology / vision (#25)
  ccm: "CCM", cnv: "CNV", amd: "AMD", rpe: "RPE", pvd: "PVD",
  vegf: "VEGF", iop: "IOP", aion: "AION", gca: "GCA", oct: "OCT",
  lasik: "LASIK", erg: "ERG", rop: "ROP", dr: "DR",
};

/**
 * Strips the redundant parent-topic prefix from a ReCiterAI subtopic label
 * and applies acronym casing. Applied when returning subtopics from the DB.
 *
 * Example: parent "Neurodegenerative Disease", label "Neurodegenerative Glymphatic Csf Clearance"
 * → "Glymphatic CSF clearance"
 */
function normalizeSubtopicLabel(subtopicLabel: string, parentTopicLabel: string): string {
  const words = subtopicLabel.trim().split(/\s+/);
  if (words.length === 0) return subtopicLabel;

  // Build a set of normalized words from the parent topic name.
  const parentWords = new Set(
    parentTopicLabel
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .split(" ")
      .filter(Boolean),
  );

  // Strip leading subtopic words that appear in the parent topic (prefix removal).
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase().replace(/[^a-z0-9]/g, "");
    if (parentWords.has(w)) {
      start = i + 1;
    } else {
      break;
    }
  }

  // Guard: don't strip everything — fall back to original if nothing remains.
  const stripped = start > 0 && start < words.length ? words.slice(start) : words;

  // Apply acronym substitution; sentence-case everything else.
  return stripped
    .map((w, i) => {
      const key = w.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (BIOMEDICAL_ACRONYMS[key]) return BIOMEDICAL_ACRONYMS[key];
      return i === 0
        ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        : w.toLowerCase();
    })
    .join(" ");
}

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

  // HIERARCHY-05 (Path B — defensive normalization retained):
  //
  //   The artifact's editorial backfill populated `display_name` only for the
  //   subset of subtopics that were relabeled. Long-tail rows still have
  //   `display_name === label`, so they inherit the parent-prefix contamination
  //   from the original ReCiterAI label generation (e.g. parent
  //   "Neurodegenerative Disease" + label
  //   "Neurodegenerative Glymphatic Csf Clearance"). Applying
  //   `normalizeSubtopicLabel` to `display_name` (NOT to `label`, which stays
  //   as-is for the rail filter target per D-08) strips the redundant prefix
  //   on long-tail rows and is a no-op on already-editorial-clean rows whose
  //   first words don't appear in the parent topic name. The function also
  //   applies acronym substitution (csf -> CSF, etc.).
  //
  //   Per CONTEXT.md "Claude's Discretion": evaluate normalizeSubtopicLabel
  //   fate. Path A (delete) would be correct if all rows were editorial-clean;
  //   the documented backfill scope (relabeled set only) means Path B is the
  //   safer default. If/when a future content-task populates display_name for
  //   the full long tail, this normalizer can be removed and Path A taken.
  return catalog
    .map((s) => {
      const rawDisplay = s.displayName?.trim() || s.label?.trim() || s.id;
      const normalizedDisplay = normalizeSubtopicLabel(rawDisplay, topic.label);
      return {
        id: s.id,
        // unchanged — rail filter still uses this per D-08.
        label: s.label,
        // D-09 universal fallback applied above + defensive parent-prefix strip.
        displayName: normalizedDisplay,
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
const HARD_EXCLUDE_TYPES = ["Letter", "Editorial Article", "Erratum"];

/**
 * CSR browsable publication feed for a topic detail page.
 *
 * Sort modes:
 *   - newest      SQL ORDER BY year DESC, dateAddedToEntrez DESC
 *   - most_cited  SQL ORDER BY citationCount DESC NULLS LAST
 *   - by_impact   In-process Variant B: scorePublication(row, "recent_highlights", false)
 *
 * Filter modes:
 *   - research_articles_only (default) excludes Letter / Editorial Article / Erratum
 *   - all                              includes all publication types
 *
 * Security: Allowlist validation of sort/filter/subtopic/slug must happen in the
 * route handler (app/api/topics/[slug]/publications/route.ts) before calling this
 * function. This function trusts its inputs have already been validated.
 *
 * Pool limit: by_impact uses POOL_LIMIT=5000 for DoS mitigation per
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

  // Same scope as `baseWhere` but with publicationType filters fixed to
  // each side — used to populate the totals for the toggle-visibility
  // decision (#30) regardless of which filter is currently active.
  const baseWhereAllTypes: Record<string, unknown> = { parentTopicId: topicSlug };
  if (subtopicFilter) baseWhereAllTypes.primarySubtopicId = subtopicFilter;
  const baseWhereResearchOnly: Record<string, unknown> = {
    ...baseWhereAllTypes,
    publication: { publicationType: { notIn: HARD_EXCLUDE_TYPES } },
  };

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
    return {
      hits: (rows as Array<{ pmid: string }>).map((r) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mapToTopicPublicationHit(r as any, authorsByPmid.get(r.pmid)),
      ),
      total,
      totalAllTypes,
      totalResearchOnly,
      page,
      pageSize: TOPIC_PUBLICATIONS_PAGE_SIZE,
    };
  }

  // In-process Variant B scoring path (by_impact).
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
  const slicePmids = slice.map((s) => s.row.pmid);
  const [authorsByPmid, totalAllTypes, totalResearchOnly] = await Promise.all([
    fetchWcmAuthorsForPmids(slicePmids),
    prisma.publicationTopic.count({ where: baseWhereAllTypes }),
    prisma.publicationTopic.count({ where: baseWhereResearchOnly }),
  ]);
  return {
    hits: slice.map((s) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mapToTopicPublicationHit(s.row as any, authorsByPmid.get(s.row.pmid)),
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
 */
function mapToTopicPublicationHit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  r: any,
  wcmAuthors?: TopicPublicationHit["authors"],
): TopicPublicationHit {
  return {
    pmid: r.pmid,
    title: r.publication.title ?? "",
    journal: r.publication.journal ?? null,
    year: r.publication.year ?? 0,
    publicationType: r.publication.publicationType ?? null,
    citationCount: r.publication.citationCount ?? null,
    pubmedUrl: r.publication.pubmedUrl ?? null,
    doi: r.publication.doi ?? null,
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
 * authors ordered first → last → middle. Used by the publication search
 * route to render author chips with headshots.
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
