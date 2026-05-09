/**
 * Home-page data assembly. Reads scholars, publications, and topic taxonomy and
 * computes Variant B rankings from `lib/ranking.ts`.
 *
 * Four surfaces, four exported functions:
 *   - getRecentContributions(): RecentContribution[] | null   (RANKING-01)
 *   - getSelectedResearch():    SubtopicCard[]      | null    (HOME-02; deprecated by getSpotlights, removed in Plan 09-07)
 *   - getSpotlights():          SpotlightCard[]     | null    (Phase 9 SPOTLIGHT-03)
 *   - getBrowseAllResearchAreas(): ParentTopic[]              (HOME-03; never null)
 *
 * Sparse-state hide returns null + emits a structured log line per
 * 02-CONTEXT.md D-12. Log lines never include scholar names or CWIDs (privacy
 * boundary; see threat T-02-07-01).
 *
 * Schema shape: candidate (e) per 02-SCHEMA-DECISION.md.
 *   - `topic` table contains 67 rows — ALL parents (no parentId column).
 *   - `publication_topic` holds (pmid, cwid, parent_topic_id) triples with
 *     subtopic data embedded (`primary_subtopic_id`, `subtopic_ids`).
 *   - Subtopics ARE first-class entities (Phase 8 / HIERARCHY-05): the
 *     `Subtopic` catalog is sole-written by `etl/hierarchy/index.ts` from the
 *     S3 hierarchy artifact. `getSelectedResearch` joins to read display_name
 *     + short_description with a (display_name ?? label ?? slug) D-09 fallback.
 *   - publication_topic.pmid FK-relates to publication.pmid (both VARCHAR(32))
 *     so card-rendering joins use Prisma `include: { publication }` directly.
 */

import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import {
  scorePublication,
  type RankablePublication,
} from "@/lib/ranking";
import { ELIGIBLE_ROLES } from "@/lib/eligibility";
import { FEED_EXCLUDED_TYPES } from "@/lib/publication-types";

// ---------------------------------------------------------------------------
// Per-surface floors per UI-SPEC §States and CONTEXT.md D-12
// ---------------------------------------------------------------------------
const RECENT_CONTRIBUTIONS_TARGET = 6;
const RECENT_CONTRIBUTIONS_FLOOR = 3;
const SELECTED_RESEARCH_TARGET = 8;
const SELECTED_RESEARCH_FLOOR = 4;
// Phase 9 SPOTLIGHT-03 — upstream rotation pipeline targets 10/10 spotlights
// (one per parent area). Floor is generous: hide the section only if the
// publish degraded below half-coverage.
const SPOTLIGHT_TARGET = 10;
const SPOTLIGHT_FLOOR = 6;

// Hard-excluded publication types — see lib/publication-types.ts.
// FEED_EXCLUDED_TYPES adds Retraction (issue #63) on top of the spec v1.7.1
// list so retraction notices stay out of home / topic feeds.

// ReCiterAI scoring data floor (D-15) — publication_score / publication_topic
// rows only cover 2020+ publications.
const RECITERAI_YEAR_FLOOR = 2020;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RecentContribution = {
  cwid: string;
  slug: string;
  preferredName: string;
  primaryTitle: string | null;
  identityImageEndpoint: string;
  authorshipRole: "first author" | "senior author";
  paper: {
    pmid: string;
    title: string;
    journal: string | null;
    year: number | null;
    pubmedUrl: string | null;
    doi: string | null;
  };
  // NO citation-count field — locked by design spec v1.7.1
};

export type SubtopicCard = {
  parentTopicSlug: string;
  parentTopicName: string;
  subtopicSlug: string;
  // (display_name ?? label) — applied at the API boundary per D-09
  subtopicName: string;
  // D-19 / HIERARCHY-05: subtitle source for components/home/subtopic-card.tsx (Plan 05)
  subtopicShortDescription: string | null;
  scholarCount: number;
  publicationCount: number;
  publications: Array<{
    pmid: string;
    title: string;
    journal: string | null;
    year: number | null;
    firstWcmAuthor: { cwid: string; slug: string; preferredName: string } | null;
  }>;
};

// Phase 9 SPOTLIGHT-03 — projection of one row from the `spotlight` table,
// joined to Topic (for the parent-topic display label) and to
// PublicationAuthor + Scholar (for the WCM-only author list per paper).
//
// D-19 LOCKED reminder: `displayName`, `shortDescription`, and `lede` are
// UI-only. Never pass them to an LLM, retrieval, or embedding path.
//
// Author-resolution policy (operator decision 2026-05-07):
//
//   The artifact ships first_author + last_author per paper, both labelled
//   WCM upstream. We DO NOT trust those labels — upstream's WCM-author check
//   (against ReciterAI's analysis_summary_author) sometimes admits non-WCM
//   authors (observed: Tammela T at MSK shipping as the "WCM last author"
//   for PMID 37808711 / 37931288 because cmr2006 / Charles Rudin was a middle
//   author on the same paper).
//
//   SPS-side resolution: read `PublicationAuthor` for each paper's PMID,
//   keep only rows where `cwid IS NOT NULL` AND the joined Scholar is
//   non-deleted + active, sort by byline `position`, render with no upper
//   bound at this layer (the component caps display + adds an ellipsis for
//   the surplus). Papers with zero WCM-resolved authors are dropped from the
//   spotlight; spotlights with zero surviving papers are dropped from the
//   carousel.
export type SpotlightAuthor = {
  cwid: string;
  displayName: string;
  identityImageEndpoint: string;
  profileSlug: string;
};

export type SpotlightPaperCard = {
  pmid: string;
  title: string;
  journal: string;
  year: number;
  // 1+ WCM-resolved authors in byline-position order. Component decides
  // how many to render and where to ellipsize.
  authors: SpotlightAuthor[];
};

export type SpotlightCard = {
  subtopicId: string;
  parentTopicSlug: string;
  parentTopicLabel: string;
  // Artifact's display_name (D-19 UI field). Upstream pipeline guarantees
  // nonempty via `display_name || label` fallback at ETL time.
  displayName: string;
  shortDescription: string;
  // 25-35 word editorial lede; render verbatim per contract §Voice Contract.
  lede: string;
  // Aggregations over PublicationTopic for (parentTopicId, primarySubtopicId)
  // restricted to D-15 floor + active non-deleted scholars. Used by the
  // spotlight count line (`N publications · M scholars`) and by the
  // "Browse all N publications →" link copy. Grants are intentionally
  // omitted in v1 — Grant has no topic linkage in the current schema.
  publicationCount: number;
  scholarCount: number;
  // 2-3 representative WCM publications.
  papers: SpotlightPaperCard[];
};

export type HomeStats = {
  scholarCount: number;
  publicationCount: number;
  researchAreaCount: number;
};

export type ParentTopic = {
  slug: string;
  name: string;
  scholarCount: number;
  publicationCount: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logSparseHide(
  surface: string,
  qualifying: number,
  floor: number,
  context: Record<string, unknown> = {},
): void {
  // Construction guarantee: only `surface`, `qualifying`, `floor`, and a
  // caller-controlled context object. Implementations never pass scholar
  // identifiers — verified by Threat T-02-07-01 mitigation.
  console.warn(
    JSON.stringify({
      event: "sparse_state_hide",
      surface,
      qualifying,
      floor,
      ...context,
    }),
  );
}

// ---------------------------------------------------------------------------
// getRecentContributions — RANKING-01
// ---------------------------------------------------------------------------

/**
 * 6 cards max, scholar-centric, eligibility carve, parent-dedup, hide if <3.
 *
 * Pulls eligible-role first-or-senior author rows from `publication_topic`
 * (candidate (e)). Variant B ranking applied app-side via lib/ranking.ts;
 * dedup keeps the highest-scoring row per parent topic. Publication metadata
 * is included via the `publication` FK relation; hard-excluded pub types are
 * filtered in the same WHERE clause.
 */
export async function getRecentContributions(
  now: Date = new Date(),
): Promise<RecentContribution[] | null> {
  const rows = await prisma.publicationTopic.findMany({
    where: {
      authorPosition: { in: ["first", "last"] },
      year: { gte: RECITERAI_YEAR_FLOOR },
      scholar: {
        deletedAt: null,
        status: "active",
        roleCategory: { in: [...ELIGIBLE_ROLES] },
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
      topic: { select: { id: true, label: true } },
      publication: {
        select: {
          pmid: true,
          title: true,
          journal: true,
          year: true,
          publicationType: true,
          dateAddedToEntrez: true,
          pubmedUrl: true,
          doi: true,
        },
      },
    },
    take: 200, // bounded pull; further sort+filter in JS
  });

  if (rows.length === 0) {
    logSparseHide("home_recent_contributions", 0, RECENT_CONTRIBUTIONS_FLOOR);
    return null;
  }

  type Row = (typeof rows)[number];

  const scored = rows
    .map((r: Row) => {
      const pub = r.publication;
      const isFirst = r.authorPosition === "first";
      const isLast = r.authorPosition === "last";
      const rankable: RankablePublication = {
        pmid: pub.pmid,
        publicationType: pub.publicationType,
        // publication_topic.score IS the per-publication-per-scholar
        // ReCiterAI score under candidate (e). Decimal -> number coercion.
        reciteraiImpact: Number(r.score),
        dateAddedToEntrez: pub.dateAddedToEntrez,
        authorship: {
          isFirst,
          isLast,
          isPenultimate: r.authorPosition === "penultimate",
        },
        isConfirmed: true, // publication_topic rows are confirmed by definition
      };
      const score = scorePublication(rankable, "recent_contributions", true, now);
      return { row: r, pub, score, parentId: r.parentTopicId, isFirst, isLast };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  // Dedup one card per parent research area (one card per parent_topic_id).
  const seenParents = new Set<string>();
  const top: typeof scored = [];
  for (const s of scored) {
    if (seenParents.has(s.parentId)) continue;
    seenParents.add(s.parentId);
    top.push(s);
    if (top.length >= RECENT_CONTRIBUTIONS_TARGET) break;
  }

  if (top.length < RECENT_CONTRIBUTIONS_FLOOR) {
    logSparseHide("home_recent_contributions", top.length, RECENT_CONTRIBUTIONS_FLOOR);
    return null;
  }

  return top.map(({ row, pub, isLast }) => {
    const scholar = row.scholar!;
    return {
      cwid: scholar.cwid,
      slug: scholar.slug,
      preferredName: scholar.preferredName,
      primaryTitle: scholar.primaryTitle,
      identityImageEndpoint: identityImageEndpoint(scholar.cwid),
      authorshipRole: isLast ? "senior author" : "first author",
      paper: {
        pmid: pub.pmid,
        title: pub.title,
        journal: pub.journal,
        year: pub.year,
        pubmedUrl: pub.pubmedUrl ?? null,
        doi: pub.doi ?? null,
      },
    } satisfies RecentContribution;
  });
}

// ---------------------------------------------------------------------------
// getSelectedResearch — HOME-02
// ---------------------------------------------------------------------------

/**
 * 8 subtopic cards max, one per parent, hide if <4.
 *
 * Aggregation under candidate (e): groupBy `(parentTopicId, primarySubtopicId)`
 * with `_sum: { score }` and `_count: { _all }`, filter rows with non-null
 * subtopic, sort by aggregate score, dedup per parent, slice to top 8.
 *
 * Subtopic display labels are slug-derived (DDB has no human label for
 * subtopics — locked finding from probe).
 */
export async function getSelectedResearch(
  _now: Date = new Date(),
): Promise<SubtopicCard[] | null> {
  void _now;
  // Aggregate publication score per (parent, subtopic). Restrict to D-15 floor
  // and drop rows with null primary_subtopic_id. We do NOT join publication
  // here (no FK; would require IN clauses). Hard-excluded pub types are
  // filtered out at the publication-stitch step below.
  const groups = await prisma.publicationTopic.groupBy({
    by: ["parentTopicId", "primarySubtopicId"],
    where: {
      primarySubtopicId: { not: null },
      year: { gte: RECITERAI_YEAR_FLOOR },
    },
    _sum: { score: true },
    _count: { _all: true },
  });

  type Group = {
    parentTopicId: string;
    primarySubtopicId: string | null;
    _sum: { score: number | string | null };
    _count: { _all: number };
  };

  // Sort groups by aggregate score desc.
  const sorted = (groups as unknown as Group[])
    .filter((g) => g.primarySubtopicId !== null)
    .map((g) => ({
      parentTopicId: g.parentTopicId,
      primarySubtopicId: g.primarySubtopicId as string,
      score: Number(g._sum.score ?? 0),
      publicationCount: g._count._all,
    }))
    .filter((g) => g.score > 0)
    .sort((a, b) => b.score - a.score);

  // Dedup so each parent appears at most once.
  const seenParents = new Set<string>();
  const top: typeof sorted = [];
  for (const g of sorted) {
    if (seenParents.has(g.parentTopicId)) continue;
    seenParents.add(g.parentTopicId);
    top.push(g);
    if (top.length >= SELECTED_RESEARCH_TARGET) break;
  }

  if (top.length < SELECTED_RESEARCH_FLOOR) {
    logSparseHide("home_selected_research", top.length, SELECTED_RESEARCH_FLOOR);
    return null;
  }

  // Resolve parent labels.
  const parentIds = top.map((t) => t.parentTopicId);
  const parents =
    parentIds.length > 0
      ? await prisma.topic.findMany({
          where: { id: { in: parentIds } },
          select: { id: true, label: true },
        })
      : [];
  const parentLabelById = new Map(parents.map((p) => [p.id, p.label]));

  // HIERARCHY-05 — fetch display_name and short_description for the chosen
  // subtopic IDs from the Subtopic catalog (now populated by Hierarchy ETL).
  // D-09: apply (display_name ?? label) fallback at the API boundary so the
  // UI in Plan 05 doesn't reimplement the rule per surface.
  const subtopicIds = top
    .map((t) => t.primarySubtopicId)
    .filter((id): id is string => id !== null);
  const subtopicMeta =
    subtopicIds.length > 0
      ? await prisma.subtopic.findMany({
          where: { id: { in: subtopicIds } },
          select: {
            id: true,
            label: true,
            displayName: true,
            shortDescription: true,
          },
        })
      : [];
  const subtopicMetaById = new Map(subtopicMeta.map((s) => [s.id, s]));

  // Resolve scholar count per (parent, subtopic) — distinct cwids. Prisma
  // groupBy can't express COUNT(DISTINCT cwid), so use raw SQL.
  type ScholarCountRow = {
    parent_topic_id: string;
    primary_subtopic_id: string;
    scholar_count: number | bigint;
  };
  const scholarCountRows: ScholarCountRow[] =
    parentIds.length > 0
      ? ((await prisma.$queryRawUnsafe(
          `SELECT pt.parent_topic_id, pt.primary_subtopic_id, COUNT(DISTINCT pt.cwid) AS scholar_count
             FROM publication_topic pt
             JOIN scholar s ON s.cwid = pt.cwid
            WHERE pt.primary_subtopic_id IS NOT NULL
              AND pt.year >= ?
              AND pt.parent_topic_id IN (${parentIds.map(() => "?").join(",")})
              AND s.deleted_at IS NULL
              AND s.status = 'active'
            GROUP BY pt.parent_topic_id, pt.primary_subtopic_id`,
          RECITERAI_YEAR_FLOOR,
          ...parentIds,
        )) as ScholarCountRow[]) ?? []
      : [];
  const scholarCountKey = (parent: string, subtopic: string) => `${parent}::${subtopic}`;
  const scholarCountByPair = new Map<string, number>(
    scholarCountRows.map((r) => [
      scholarCountKey(r.parent_topic_id, r.primary_subtopic_id),
      Number(r.scholar_count),
    ]),
  );

  // Fetch sample publication_topic rows for each (parent, subtopic) pair so
  // the card can show two example publications. Then stitch publication
  // metadata in a second batched query.
  const sampleRows = await prisma.publicationTopic.findMany({
    where: {
      OR: top.map((t) => ({
        parentTopicId: t.parentTopicId,
        primarySubtopicId: t.primarySubtopicId,
      })),
      year: { gte: RECITERAI_YEAR_FLOOR },
      publication: { publicationType: { notIn: [...FEED_EXCLUDED_TYPES] } },
    },
    include: {
      scholar: { select: { cwid: true, slug: true, preferredName: true } },
      publication: { select: { pmid: true, title: true, journal: true, year: true } },
    },
    orderBy: [{ score: "desc" }],
    take: top.length * 8, // generous; we'll bucket and slice 2 per pair
  });

  type SampleRow = (typeof sampleRows)[number];
  const sampleByPair = new Map<string, Array<{ row: SampleRow; pubTitle: string; pubPmid: string; pubJournal: string | null; pubYear: number | null }>>();
  for (const s of sampleRows) {
    const key = scholarCountKey(s.parentTopicId, s.primarySubtopicId ?? "");
    const arr = sampleByPair.get(key) ?? [];
    if (arr.length < 2) {
      arr.push({ row: s, pubTitle: s.publication.title, pubPmid: s.publication.pmid, pubJournal: s.publication.journal, pubYear: s.publication.year });
      sampleByPair.set(key, arr);
    }
  }

  return top.map((t) => {
    const key = scholarCountKey(t.parentTopicId, t.primarySubtopicId);
    const samples = sampleByPair.get(key) ?? [];
    const meta = subtopicMetaById.get(t.primarySubtopicId);
    // D-09: prefer display_name, fall back to label, fall back to slug-derived
    // (the slug-derived path is reached only if Hierarchy ETL hasn't run yet
    // OR the artifact is missing this subtopic id — both transient states).
    const subtopicName =
      (meta?.displayName?.trim() || meta?.label?.trim() || t.primarySubtopicId);
    const subtopicShortDescription = meta?.shortDescription?.trim() || null;
    return {
      parentTopicSlug: t.parentTopicId,
      parentTopicName: parentLabelById.get(t.parentTopicId) ?? t.parentTopicId,
      subtopicSlug: t.primarySubtopicId,
      subtopicName,
      subtopicShortDescription,
      scholarCount: scholarCountByPair.get(key) ?? 0,
      publicationCount: t.publicationCount,
      publications: samples.map((s) => ({
        pmid: s.pubPmid,
        title: s.pubTitle,
        journal: s.pubJournal,
        year: s.pubYear,
        firstWcmAuthor: s.row.scholar
          ? {
              cwid: s.row.scholar.cwid,
              slug: s.row.scholar.slug,
              preferredName: s.row.scholar.preferredName,
            }
          : null,
      })),
    } satisfies SubtopicCard;
  });
}

// ---------------------------------------------------------------------------
// getSpotlights — Phase 9 SPOTLIGHT-03
// ---------------------------------------------------------------------------

/**
 * 10 editorial spotlights from the ReciterAI rotation pipeline (`Spotlight`
 * table, sole-written by `etl/spotlight/index.ts`). Each card pairs a 25-35
 * word lede with 2-3 representative WCM publications, with first + last
 * author photos resolved against the existing Scholar table.
 *
 * Sparse-state hide: returns null if fewer than `SPOTLIGHT_FLOOR` rows exist
 * (publish degraded; section hides rather than render a half-empty layout).
 * The upstream pipeline targets a steady 10/10; the floor is a defensive
 * cushion, not the expected case.
 *
 * Render-order: deterministic alphabetical by `parentTopicId`. The artifact
 * does not ship a position field; if editorial-priority ordering is ever
 * required, add a column in a follow-up phase.
 *
 * D-19 LOCKED: `displayName`, `shortDescription`, and `lede` are UI-only.
 * NEVER pass them to an LLM, retrieval, or embedding path. The
 * synthesis-canonical fields are `label` (artifact-side) and `description`
 * (Subtopic-side), neither of which is exposed in this DAL surface.
 *
 * D-06 (subtopic ID instability across hierarchy recomputes): each ETL run
 * fully replaces the spotlight rows; this DAL never persists subtopic IDs
 * outward.
 */
export async function getSpotlights(): Promise<SpotlightCard[] | null> {
  // Step 1: Read all spotlight rows. Stable alphabetical order by
  // parentTopicId, re-sorted in JS so the ordering invariant is enforced at
  // the DAL boundary regardless of how the underlying driver interprets the
  // orderBy.
  const rowsRaw = await prisma.spotlight.findMany({
    orderBy: { parentTopicId: "asc" },
  });
  const rows = [...rowsRaw].sort((a, b) =>
    a.parentTopicId < b.parentTopicId ? -1 : a.parentTopicId > b.parentTopicId ? 1 : 0,
  );

  if (rows.length === 0) {
    logSparseHide("home_spotlights", 0, SPOTLIGHT_FLOOR);
    return null;
  }

  // Step 2: Resolve parent topic display labels in one batch.
  const parentIds = Array.from(new Set(rows.map((r) => r.parentTopicId)));
  const parents = await prisma.topic.findMany({
    where: { id: { in: parentIds } },
    select: { id: true, label: true },
  });
  const parentLabelById = new Map(parents.map((p) => [p.id, p.label]));

  // Step 3: Collect every PMID across all papers, then batch-resolve WCM
  // authors. Authoritative source is `publication_author` joined to
  // `scholar` — NOT the artifact's first_author / last_author payload.
  type ArtifactPaper = {
    pmid: string;
    title: string;
    journal: string;
    year: number;
  };
  const pmids = Array.from(
    new Set(
      rows.flatMap((r) =>
        (r.papers as unknown as ArtifactPaper[]).map((p) => p.pmid),
      ),
    ),
  );
  const authorRows =
    pmids.length > 0
      ? await prisma.publicationAuthor.findMany({
          where: {
            pmid: { in: pmids },
            cwid: { not: null },
            scholar: { deletedAt: null, status: "active" },
          },
          include: {
            scholar: { select: { cwid: true, slug: true, preferredName: true } },
          },
          orderBy: { position: "asc" },
        })
      : [];
  const authorsByPmid = new Map<string, SpotlightAuthor[]>();
  for (const row of authorRows) {
    if (!row.scholar) continue;
    const list = authorsByPmid.get(row.pmid) ?? [];
    list.push({
      cwid: row.scholar.cwid,
      displayName: row.scholar.preferredName,
      identityImageEndpoint: identityImageEndpoint(row.scholar.cwid),
      profileSlug: row.scholar.slug,
    });
    authorsByPmid.set(row.pmid, list);
  }

  // Step 4: Aggregate publication + scholar counts per (parent, subtopic).
  //
  // Mirrors the pattern in getSelectedResearch — Prisma groupBy can't express
  // COUNT(DISTINCT cwid), so a single raw query covers both counts in one
  // round-trip. Restricted to D-15 floor (publication_topic only carries
  // 2020+ data) and to active non-deleted scholars.
  const subtopicPairs = rows.map((r) => ({
    parent: r.parentTopicId,
    sub: r.subtopicId,
  }));
  type CountRow = {
    parent_topic_id: string;
    primary_subtopic_id: string;
    publication_count: number | bigint;
    scholar_count: number | bigint;
  };
  const countRows: CountRow[] =
    subtopicPairs.length > 0
      ? ((await prisma.$queryRawUnsafe(
          `SELECT pt.parent_topic_id, pt.primary_subtopic_id,
                  COUNT(*) AS publication_count,
                  COUNT(DISTINCT pt.cwid) AS scholar_count
             FROM publication_topic pt
             JOIN scholar s ON s.cwid = pt.cwid
            WHERE pt.year >= ?
              AND s.deleted_at IS NULL
              AND s.status = 'active'
              AND (${subtopicPairs.map(() => "(pt.parent_topic_id = ? AND pt.primary_subtopic_id = ?)").join(" OR ")})
            GROUP BY pt.parent_topic_id, pt.primary_subtopic_id`,
          RECITERAI_YEAR_FLOOR,
          ...subtopicPairs.flatMap((p) => [p.parent, p.sub]),
        )) as CountRow[]) ?? []
      : [];
  const countByPair = new Map<string, { pubs: number; scholars: number }>();
  for (const r of countRows) {
    countByPair.set(`${r.parent_topic_id}::${r.primary_subtopic_id}`, {
      pubs: Number(r.publication_count),
      scholars: Number(r.scholar_count),
    });
  }

  // Step 5: Project + filter. Drop papers with no WCM-resolved authors;
  // drop spotlights whose papers all dropped out.
  const cards: SpotlightCard[] = [];
  for (const row of rows) {
    const artifactPapers = row.papers as unknown as ArtifactPaper[];
    const papers: SpotlightPaperCard[] = [];
    for (const p of artifactPapers) {
      const authors = authorsByPmid.get(p.pmid) ?? [];
      if (authors.length === 0) continue;
      papers.push({
        pmid: p.pmid,
        title: p.title,
        journal: p.journal,
        year: p.year,
        authors,
      });
    }
    if (papers.length === 0) {
      logSparseHide("home_spotlight_dropped_no_wcm_authors", 0, 1, {
        subtopicId: row.subtopicId,
        parentTopicId: row.parentTopicId,
      });
      continue;
    }
    const counts = countByPair.get(`${row.parentTopicId}::${row.subtopicId}`) ?? {
      pubs: 0,
      scholars: 0,
    };
    cards.push({
      subtopicId: row.subtopicId,
      parentTopicSlug: row.parentTopicId,
      parentTopicLabel: parentLabelById.get(row.parentTopicId) ?? row.parentTopicId,
      displayName: row.displayName,
      shortDescription: row.shortDescription,
      lede: row.lede,
      publicationCount: counts.pubs,
      scholarCount: counts.scholars,
      papers,
    });
  }

  if (cards.length < SPOTLIGHT_FLOOR) {
    logSparseHide("home_spotlights", cards.length, SPOTLIGHT_FLOOR);
    return null;
  }
  return cards;
}

void SPOTLIGHT_TARGET; // reserved for upstream consistency assertion in 09-04

// ---------------------------------------------------------------------------
// getBrowseAllResearchAreas — HOME-03
// ---------------------------------------------------------------------------

/**
 * All 67 parents with active-scholar counts (D-03). Never hidden — Browse
 * grid always renders all 67 parents. If <67 rows exist, that's a data-layer
 * bug, not a sparse-state condition (D-12). Returns [] in that case (UI
 * renders the "Research areas temporarily unavailable" error state).
 *
 * Under candidate (e) every Topic row IS a parent — no `parentId IS NULL`
 * filter needed. Active-scholar count is computed on demand via raw SQL
 * (Prisma groupBy can't express COUNT(DISTINCT cwid)).
 */
export async function getBrowseAllResearchAreas(): Promise<ParentTopic[]> {
  const topics = await prisma.topic.findMany({
    select: { id: true, label: true },
    orderBy: { label: "asc" },
  });

  if (topics.length === 0) {
    return [];
  }

  // Distinct active-scholar AND distinct-publication counts per parent —
  // D-03 says "no eligibility filter", so any scholar-attributed publication
  // contributes. Both counts come from the same publication_topic join in a
  // single query so we don't pay two round-trips.
  type CountRow = {
    parent_topic_id: string;
    scholar_count: number | bigint;
    publication_count: number | bigint;
  };
  const countRows = ((await prisma.$queryRawUnsafe(
    `SELECT pt.parent_topic_id,
            COUNT(DISTINCT pt.cwid) AS scholar_count,
            COUNT(DISTINCT pt.pmid) AS publication_count
       FROM publication_topic pt
       JOIN scholar s ON s.cwid = pt.cwid
      WHERE s.deleted_at IS NULL AND s.status = 'active'
      GROUP BY pt.parent_topic_id`,
  )) as CountRow[]) ?? [];
  const scholarByParent = new Map<string, number>(
    countRows.map((r) => [r.parent_topic_id, Number(r.scholar_count)]),
  );
  const pubByParent = new Map<string, number>(
    countRows.map((r) => [r.parent_topic_id, Number(r.publication_count)]),
  );

  return topics.map((t) => ({
    slug: t.id,
    name: t.label,
    scholarCount: scholarByParent.get(t.id) ?? 0,
    publicationCount: pubByParent.get(t.id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// getHomeStats — hero stats strip
// ---------------------------------------------------------------------------

export async function getHomeStats(): Promise<HomeStats> {
  const [scholarCount, publicationCount, researchAreaCount] = await Promise.all([
    prisma.scholar.count({ where: { deletedAt: null, status: "active" } }),
    prisma.publication.count(),
    prisma.topic.count(),
  ]);
  return { scholarCount, publicationCount, researchAreaCount };
}
