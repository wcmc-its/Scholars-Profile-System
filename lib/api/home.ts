/**
 * Home-page data assembly. Reads scholars, publications, and topic taxonomy and
 * computes Variant B rankings from `lib/ranking.ts`.
 *
 * Exported read surfaces:
 *   - getSpotlights():          SpotlightCard[]     | null    (Phase 9 SPOTLIGHT-03)
 *   - getBrowseAllResearchAreas(): ParentTopic[]              (HOME-03; never null)
 *
 * Sparse-state hide returns null + emits a structured log line per
 * 02-CONTEXT.md D-12. Log lines never include scholar names or CWIDs (privacy
 * boundary; see threat T-02-07-01).
 *
 * Schema shape: candidate (e) per 02-SCHEMA-DECISION.md.
 *   - `topic` table holds ALL parents, one row each (no parentId column). Its
 *     row count tracks the ReciterAI taxonomy and is not a constant.
 *   - `publication_topic` holds (pmid, cwid, parent_topic_id) triples with
 *     subtopic data embedded (`primary_subtopic_id`, `subtopic_ids`).
 *   - Subtopics ARE first-class entities (Phase 8 / HIERARCHY-05): the
 *     `Subtopic` catalog is sole-written by `etl/hierarchy/index.ts` from the
 *     S3 hierarchy artifact.
 *   - publication_topic.pmid FK-relates to publication.pmid (both VARCHAR(32))
 *     so card-rendering joins use Prisma `include: { publication }` directly.
 */

import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import {
  isAuthorHidden,
  loadPublicationSuppressions,
  resolveDarkPmids,
} from "@/lib/api/manual-layer";
import { NEVER_DISPLAY_TYPES } from "@/lib/publication-types";
import { publicRoleWhere, isPubliclyDisplayed } from "@/lib/eligibility";
import { resolveHiddenStudentCoauthorChips } from "@/lib/api/search-flags";
import { sampleSpotlightPapers } from "@/lib/spotlight-sampling";
import { getSupercategoryHubEntries } from "@/lib/api/methods";
import { isMethodPagesEnabled } from "@/lib/profile/methods-lens-flags";

// ---------------------------------------------------------------------------
// Per-surface floors per UI-SPEC §States and CONTEXT.md D-12
// ---------------------------------------------------------------------------
// Phase 9 SPOTLIGHT-03 — the producer ships one spotlight per parent topic.
// Since the ReciterAI 25-card bump it publishes every cleared candidate, up to
// SPOTLIGHT_TARGET cards (was a pre-truncated 10); the actual count varies per
// publish. SPOTLIGHT_FLOOR is an absolute defensive minimum — NOT half of the
// (now variable) producer count: hide the section only if a publish degrades to
// fewer than this many surviving cards.
const SPOTLIGHT_TARGET = 25;
const SPOTLIGHT_FLOOR = 6;

// ReCiterAI scoring data floor (D-15) — publication_score / publication_topic
// rows only cover 2020+ publications.
const RECITERAI_YEAR_FLOOR = 2020;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
//   keep only rows where the authorship `isConfirmed` (#2220) AND
//   `cwid IS NOT NULL` AND the joined Scholar is non-deleted + active, sort by
//   byline `position`, render with no upper bound at this layer (the component
//   caps display + adds an ellipsis for the surplus). Papers with zero
//   WCM-resolved authors are dropped from the spotlight; spotlights with zero
//   surviving papers are dropped from the carousel.
export type SpotlightAuthor = {
  cwid: string;
  displayName: string;
  identityImageEndpoint: string;
  profileSlug: string;
  /** #536 — author chip renders as plain text for hidden roles. */
  roleCategory: string | null;
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
  //
  // #2218 — `null` means NO aggregate row exists for this (parent, subtopic)
  // pair, which is NOT the same as a count of zero: the subtopic may have been
  // retired from the taxonomy underneath a still-published artifact. Render the
  // count line as absent, never as "0" — and never link "browse all 0
  // publications" at a subtopic that may no longer exist.
  publicationCount: number | null;
  scholarCount: number | null;
  // Up to 3 representative WCM publications, seeded-sampled per publish cycle
  // from the artifact pool by `sampleSpotlightPapers` (#286).
  papers: SpotlightPaperCard[];
  // Publish-cycle ID (the artifact version that also seeds the #286 sample).
  // Surfaced to the client so Spotlight paper-click telemetry can attribute
  // CTR per cycle — the #286 success metric depends on it (#343).
  artifactVersion: string;
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

export type HomeMethodCategory = {
  /** /methods/<slug> path segment (SupercategoryHubEntry.slug). */
  slug: string;
  /** Display label (SupercategoryHubEntry.label). */
  label: string;
  /** Count of publicly-visible families in this category. */
  familyCount: number;
  /** Up to 3 representative family labels (top by scholarCount, "General*" excluded). */
  representativeFamilies: string[];
};

export type HomeMethodCategories = {
  categories: HomeMethodCategory[]; // alphabetical by label
  categoryCount: number; // categories.length
  totalFamilyCount: number; // sum of familyCount
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
// Home-surface read cache
// ---------------------------------------------------------------------------
//
// The home page is public, viewer-independent, and only changes after the
// nightly ETL — it was designed as 6h ISR (`app/page.tsx` `revalidate = 21600`).
// But under Next 15 a DB-backed route silently deopts to dynamic and that
// `revalidate` is a no-op, so these loaders ran on EVERY request (~5.7s warm
// origin time). `force-static` can't fix the home page specifically: it's a
// STATIC route, so it would prerender at build time — and the Docker image
// builds with no `DATABASE_URL`, so the `.catch` fallbacks would bake an empty
// home into the image until revalidation (strictly worse, and per-task in
// multi-task prod). Instead cache the DATA in-process: the route stays dynamic
// (always real data, never empty). Stale-while-revalidate, so a busy home
// effectively never waits:
//   - fresh (< HOME_CACHE_TTL_MS): serve the cached data, no work;
//   - stale but < HOME_CACHE_MAX_STALE_MS: serve the stale data IMMEDIATELY and
//     refresh in the background (deduped) — no request blocks;
//   - cold (nothing cached) or past the staleness ceiling: block on the load.
// So the only blocking ~5.7s render is a genuinely cold task (deploy / scale-
// out / restart) or the first hit after > MAX_STALE without a successful load.
//
// Throw-preserving (NOT degrade-to-empty) on the BLOCKING path: a failed load
// is neither cached nor swallowed — it propagates to the per-surface `.catch`
// in `app/page.tsx` (which hides that one surface) and the next request
// retries. A failed BACKGROUND refresh is swallowed: the stale entry is kept
// and retried on the next request. Mirrors the {data, ts} + inflight idiom in
// `lib/api/people-classifier-sets.ts`. Per-task, like every cache in this app.
//
// `getHomeMethodCategories` is deliberately NOT cached here — it reads the
// #800/#801 family-overlay visibility gate, where cross-request caching would
// freeze method-family visibility changes (the B6 lesson) — and it is the
// cheapest of the four loaders.
//
// Bypassed under vitest: the module-level state would otherwise leak across
// test cases (`home-api.test.ts` statically imports these loaders, calls some
// twice in one case, and does not `vi.resetModules()`).
const HOME_CACHE_TTL_MS = 15 * 60 * 1000; // 15 min fresh window — far fresher than the 6h ISR intent; bounds #356 suppression lag
const HOME_CACHE_MAX_STALE_MS = 60 * 60 * 1000; // 1h serve-stale ceiling — past this, block rather than serve very stale data
const HOME_CACHE_BYPASS =
  Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";

type HomeCacheEntry<T> = { data: T; ts: number };
const homeCache = new Map<string, HomeCacheEntry<unknown>>();
const homeInflight = new Map<string, Promise<unknown>>();

// Refresh `key` once, deduped via homeInflight. Caches on success; on failure
// caches nothing and the returned promise REJECTS, so a blocking caller's
// `.catch` in app/page.tsx sees it. A background caller must swallow the
// rejection (see the stale-serve branch in cachedHomeRead).
function refreshHome<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = homeInflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = load()
    .then((data) => {
      homeCache.set(key, { data, ts: Date.now() });
      return data;
    })
    .finally(() => {
      homeInflight.delete(key);
    });
  homeInflight.set(key, p);
  return p;
}

function cachedHomeRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (HOME_CACHE_BYPASS) return load();
  const hit = homeCache.get(key) as HomeCacheEntry<T> | undefined;
  const age = hit ? Date.now() - hit.ts : Number.POSITIVE_INFINITY;

  // Fresh — serve cached, no refresh.
  if (hit && age < HOME_CACHE_TTL_MS) return Promise.resolve(hit.data);

  // Stale but within the ceiling — serve stale now, refresh in the background
  // (deduped). No request blocks; a failed refresh is swallowed and retried.
  if (hit && age < HOME_CACHE_MAX_STALE_MS) {
    void refreshHome(key, load).catch(() => {});
    return Promise.resolve(hit.data);
  }

  // Cold (nothing cached) or past the staleness ceiling — block on the load.
  // Throw-preserving: a failure propagates to the caller and is not cached.
  return refreshHome(key, load);
}

// ---------------------------------------------------------------------------
// getSpotlights — Phase 9 SPOTLIGHT-03
// ---------------------------------------------------------------------------

/**
 * Up to 25 editorial spotlights from the ReciterAI rotation pipeline
 * (`Spotlight` table, sole-written by `etl/spotlight/index.ts`), one per parent
 * topic. Each card pairs a 25-35 word lede with up to 3 representative WCM
 * publications — seeded-sampled per publish cycle from the artifact pool (#286)
 * — with author photos resolved against the existing Scholar table.
 *
 * Returns every surviving card with no row cap; the home component
 * random-samples DISPLAY_LIMIT_SPOTLIGHTS (8) of them per page load and de-dups
 * paper-level near-identical cards there (`lib/spotlight-sampling.ts`). The
 * producer used to pre-truncate to ~10 before the ReciterAI 25-card bump; this
 * DAL never capped, so passing the larger set through needs no change here.
 *
 * Sparse-state hide: returns null if fewer than `SPOTLIGHT_FLOOR` rows survive
 * (publish degraded; section hides rather than render a half-empty layout). The
 * floor is an absolute defensive minimum, independent of the (now variable, up
 * to 25) producer card count.
 *
 * The artifact is a SNAPSHOT of a taxonomy that keeps moving under it (#2218),
 * so every card is validated against the live catalog before it renders: a card
 * whose parent topic no longer resolves is dropped, and a (parent, subtopic)
 * pair with no aggregate row reports `null` counts rather than a confident zero.
 * Papers are additionally dropped for suppression (#356) and for
 * `NEVER_DISPLAY_TYPES` (#2219) — the artifact is not trusted to be pre-clean.
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
export function getSpotlights(): Promise<SpotlightCard[] | null> {
  return cachedHomeRead("home:spotlights", getSpotlightsUncached);
}

async function getSpotlightsUncached(): Promise<SpotlightCard[] | null> {
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
  // #356 — publication suppression for the home Spotlight papers.
  const suppressions = await loadPublicationSuppressions(pmids, prisma);
  const darkPmids = await resolveDarkPmids(pmids, suppressions, prisma);
  // #2219 — defense-in-depth against a STALE artifact. The read path used to
  // trust the producer to ship a pre-clean pool, but the artifact is republished
  // on the producer's cadence (51 days stale at #576 QA time) while the nightly
  // `PubMedRetractions` ETL keeps stamping `Retraction`/`Erratum` onto rows
  // underneath it — so any paper retracted AFTER the publish would render in the
  // spotlight indefinitely. Resolved as an explicit pmid set, mirroring
  // `darkPmids`, rather than a nested relation filter: a paper must be dropped
  // for a NAMED reason, not by the side effect of losing its authors.
  const neverDisplayPmids = new Set(
    pmids.length > 0
      ? (
          await prisma.publication.findMany({
            where: {
              pmid: { in: pmids },
              publicationType: { in: [...NEVER_DISPLAY_TYPES] },
            },
            select: { pmid: true },
          })
        ).map((p) => p.pmid)
      : [],
  );
  // #2223 — the kill switch actually governs this surface now. OFF means a
  // hidden-class student is ABSENT from the chip row (what the QA runbook has
  // always claimed), not merely "not additionally hydrated": on prod the 690
  // doctoral students are NOT soft-deleted, so the deletedAt/status filter below
  // admits them unconditionally and flipping the flag off changed nothing here.
  const includeHiddenStudents = resolveHiddenStudentCoauthorChips();
  const authorRows =
    pmids.length > 0
      ? await prisma.publicationAuthor.findMany({
          where: {
            pmid: { in: pmids },
            // #2220 — every other publication read path in lib/api filters
            // confirmed authorships (profile, centers, divisions, dept-lists,
            // publication-detail, …), and `resolveDarkPmids` — called above on
            // these very pmids — derives darkness over `isConfirmed: true`
            // authors only. Without this the two halves of THIS function
            // disagreed about who counts as an author, and a ReCiter-unconfirmed
            // authorship could put a wrong name on the home page.
            isConfirmed: true,
            cwid: { not: null },
            scholar: { deletedAt: null, status: "active" },
          },
          include: {
            scholar: { select: { cwid: true, slug: true, preferredName: true, roleCategory: true } },
          },
          orderBy: { position: "asc" },
        })
      : [];
  const authorsByPmid = new Map<string, SpotlightAuthor[]>();
  for (const row of authorRows) {
    // #356 — a per-author hide drops the scholar from the Spotlight paper.
    if (!row.scholar || isAuthorHidden(suppressions, row.pmid, row.scholar.cwid))
      continue;
    // #2223 — flag OFF ⇒ no hidden-class student in the hydration at all.
    // (Flag ON keeps today's behavior exactly: they render as a NON-LINKED chip,
    // enforced at render by isPubliclyDisplayed in components/home/spotlight-section.)
    if (!includeHiddenStudents && !isPubliclyDisplayed(row.scholar.roleCategory))
      continue;
    const list = authorsByPmid.get(row.pmid) ?? [];
    list.push({
      cwid: row.scholar.cwid,
      displayName: row.scholar.preferredName,
      identityImageEndpoint: identityImageEndpoint(row.scholar.cwid),
      profileSlug: row.scholar.slug,
      roleCategory: row.scholar.roleCategory,
    });
    authorsByPmid.set(row.pmid, list);
  }

  // Step 4: Aggregate publication + scholar counts per (parent, subtopic).
  //
  // Prisma groupBy can't express
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
    // #2218 — the artifact outlives the taxonomy it was published against. On
    // 2026-08-01 the producer split `neuroscience_neurology` into
    // `basic_neuroscience` + `clinical_neurology` WITHOUT moving
    // `taxonomy_version`, and the spotlight artifact has not been republished
    // since 2026-06-15 — so one card still names a parent topic that the SPS
    // taxonomy no longer has. Every ETL step behaved correctly; the defect was
    // that this read path rendered the survivor anyway, with `?? row.parentTopicId`
    // printing the raw machine slug as the kicker and all four hrefs pointing at
    // a `/topics/<slug>` that 404s. Drop the card: `lib/api/spotlight.ts` nulls
    // the kicker href in the same situation, and here there is nothing left to
    // link to at all.
    const parentTopicLabel = parentLabelById.get(row.parentTopicId);
    if (parentTopicLabel === undefined) {
      logSparseHide("home_spotlight_dropped_unresolved_topic", 0, 1, {
        subtopicId: row.subtopicId,
        parentTopicId: row.parentTopicId,
        artifactVersion: row.artifactVersion,
      });
      continue;
    }
    const artifactPapers = row.papers as unknown as ArtifactPaper[];
    const papers: SpotlightPaperCard[] = [];
    for (const p of artifactPapers) {
      const authors = authorsByPmid.get(p.pmid) ?? [];
      // #356 — drop a paper taken down whole, or with zero displayed authors.
      // #2219 — and never a Retraction / Erratum, however clean the artifact
      // looked when it was published.
      if (
        authors.length === 0 ||
        darkPmids.has(p.pmid) ||
        neverDisplayPmids.has(p.pmid)
      )
        continue;
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
    // #2218 — a MISSING count row is not a count of zero. The aggregate above
    // returns no row both when the subtopic no longer exists in the local
    // taxonomy (its `publication_topic` rows were cascade-deleted with the
    // retired parent) and when it exists but has no 2020+ publications from
    // active scholars. Neither case licenses "0 publications · 0 scholars" —
    // that is a confident false statement next to three representative papers.
    // Surface it as unknown and let the component omit the line.
    const counts = countByPair.get(`${row.parentTopicId}::${row.subtopicId}`) ?? null;
    // Issue #286 — seeded 3-of-N sample of the artifact pool, stable per
    // publish cycle (keyed on artifactVersion + subtopicId) and rotating
    // across cycles. Deterministic, so it is SSR-safe; the component no
    // longer shuffles papers itself.
    const sampledPapers = sampleSpotlightPapers(
      papers,
      `${row.artifactVersion}:${row.subtopicId}`,
    );
    cards.push({
      subtopicId: row.subtopicId,
      parentTopicSlug: row.parentTopicId,
      parentTopicLabel,
      displayName: row.displayName,
      shortDescription: row.shortDescription,
      lede: row.lede,
      publicationCount: counts?.pubs ?? null,
      scholarCount: counts?.scholars ?? null,
      papers: sampledPapers,
      artifactVersion: row.artifactVersion,
    });
  }

  if (cards.length < SPOTLIGHT_FLOOR) {
    logSparseHide("home_spotlights", cards.length, SPOTLIGHT_FLOOR);
    return null;
  }
  return cards;
}

void SPOTLIGHT_TARGET; // producer ceiling (max cards per publish); documented, not asserted

// ---------------------------------------------------------------------------
// getBrowseAllResearchAreas — HOME-03
// ---------------------------------------------------------------------------

/**
 * Every parent topic with active-scholar counts (D-03). Never hidden — the
 * Browse grid renders the whole `topic` catalog at whatever size it currently
 * is (67 under taxonomy_v2; the count moves whenever ReciterAI adds or retires
 * a parent, so do NOT hard-code it). Only an EMPTY catalog is a data-layer bug
 * rather than a sparse-state condition (D-12); we return [] in that case and
 * the UI renders the "Research areas temporarily unavailable" error state.
 *
 * Under candidate (e) every Topic row IS a parent — no `parentId IS NULL`
 * filter needed. Active-scholar count is computed on demand via raw SQL
 * (Prisma groupBy can't express COUNT(DISTINCT cwid)).
 */
export function getBrowseAllResearchAreas(): Promise<ParentTopic[]> {
  return cachedHomeRead("home:browse-research-areas", getBrowseAllResearchAreasUncached);
}

async function getBrowseAllResearchAreasUncached(): Promise<ParentTopic[]> {
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

export function getHomeStats(): Promise<HomeStats> {
  return cachedHomeRead("home:stats", getHomeStatsUncached);
}

async function getHomeStatsUncached(): Promise<HomeStats> {
  // Apply NEVER_DISPLAY_TYPES so the homepage publication stat matches the
  // /search publications index (built with the same exclusion in
  // etl/search-index/index.ts:412). Issue #216 — without this filter the
  // hero stat over-counts by ~1.1k (Retractions + Errata that are never
  // surfaced anywhere else).
  //
  // #2222 — same class of defect on the scholar stat: a `deletedAt`-only gate
  // advertised 9,412 scholars while the people index `/search` queries held
  // 8,722. The gap was exactly the #536 hidden-role cohort — 690 prod doctoral
  // students carrying the BARE `doctoral_student` with `deleted_at IS NULL`, so
  // the soft-delete gate never touched them and 7.3% of the advertised
  // population was unreachable. The hero now counts the SAME predicate the
  // people index is built from (`PEOPLE_INDEX_WHERE` spreads this identical
  // fragment; `tests/unit/home-api.test.ts` pins the two together), so
  // "advertised" and "findable" cannot drift again. NULL role_category is
  // admitted explicitly — see publicRoleWhere() for the three-valued-logic
  // trap that makes a bare `notIn` hide every un-backfilled scholar.
  const [scholarCount, publicationCount, researchAreaCount] = await Promise.all([
    prisma.scholar.count({
      where: { deletedAt: null, status: "active", ...publicRoleWhere() },
    }),
    prisma.publication.count({
      where: { publicationType: { notIn: [...NEVER_DISPLAY_TYPES] } },
    }),
    prisma.topic.count(),
  ]);
  return { scholarCount, publicationCount, researchAreaCount };
}

// ---------------------------------------------------------------------------
// getHomeMethodCategories — home "Browse by research method" section + stat
// ---------------------------------------------------------------------------

const HOME_METHOD_REPRESENTATIVE_LIMIT = 3;

/**
 * Home-page "Browse by research method" data. Reuses the SAME taxonomy source
 * `/methods` consumes (getSupercategoryHubEntries) — no heavier query.
 *
 * Gated on METHODS_LENS_PAGES (isMethodPagesEnabled) so the home section + the
 * "N methods" stat share the page-surface gate already governing /methods.
 * Returns null when the flag is off OR the taxonomy returns nothing, so the
 * caller hides BOTH the section and the stat (spec §7 empty state, §11).
 */
export async function getHomeMethodCategories(): Promise<HomeMethodCategories | null> {
  if (!isMethodPagesEnabled()) return null;

  const entries = await getSupercategoryHubEntries();
  if (entries.length === 0) return null;

  const categories: HomeMethodCategory[] = entries
    .map((sc) => {
      const representativeFamilies = [...sc.families]
        .filter((f) => !f.familyLabel.startsWith("General"))
        .sort((a, b) => b.scholarCount - a.scholarCount)
        .slice(0, HOME_METHOD_REPRESENTATIVE_LIMIT)
        .map((f) => f.familyLabel);
      return {
        slug: sc.slug,
        label: sc.label,
        familyCount: sc.familyCount,
        representativeFamilies,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    categories,
    categoryCount: categories.length,
    totalFamilyCount: categories.reduce((sum, c) => sum + c.familyCount, 0),
  };
}
