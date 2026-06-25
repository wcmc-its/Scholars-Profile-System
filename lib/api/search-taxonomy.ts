/**
 * Taxonomy-match callout pipeline for /search.
 *
 * Given a query string, return curated taxonomy entities whose names
 * substring-match the query (case-insensitive, punctuation-stripped).
 * v1 scope is parent topics + subtopics only; departments / divisions /
 * centers are deferred per issue #14 descope.
 *
 * Match rules:
 *   1. Normalize: lowercase + strip non-alphanumeric. Handles
 *      "Cardio-oncology" / "cardio oncology" / "cardiooncology".
 *   2. Substring match: normalized query is a substring of normalized
 *      Topic.label or Subtopic.displayName ?? label. Subtopics match
 *      on the UI-stylized displayName (short, ~3-6 words) for
 *      precision; the autocomplete suggester uses Subtopic.label for
 *      recall, but the callout is a "curated page exists" affordance
 *      where false positives hurt more than misses.
 *   3. Suppress when normalized query is shorter than 3 chars, or when
 *      nothing matches.
 *
 * Ranking (primary + secondary order):
 *   1. Entity type: parentTopic before subtopic.
 *   2. scholarCount descending. Within a tier this favors the umbrella
 *      topic when several siblings substring-match a broad query — for
 *      "cancer" the user wants "Cancer Biology (General)" first, not
 *      the highest-similarity sibling like "Lung Cancer". (Issue #74.)
 *   3. String similarity descending (query length / label length) as
 *      a tiebreaker when scholar counts are equal.
 *   4. Name ascending (locale-aware) as final tiebreaker.
 *
 * The first ranked match is the "primary" — the row that always renders.
 * Subsequent matches are "secondary," surfaced behind the disclosure
 * affordance in the callout. Cap is 4 visible secondary rows + optional
 * overflow row when secondary.length > 4.
 *
 * Counts are computed on demand for matched entities only. To bound
 * cost on common substring queries (e.g. "cancer" → many hits), the
 * candidate set is capped at MATCH_HARD_CAP before count enrichment;
 * any extras roll into the overflow count.
 */
import { cache } from "react";
import { prisma } from "@/lib/db";
import {
  matchesAtTokenBoundary,
  normalizeForMatch,
  normalizeWithTokenStarts,
  normalizedWindows,
} from "@/lib/api/normalize";
import { dedupeFirstByKey } from "@/lib/api/search-ranking";
import {
  resolveSearchSuggestMeshConcept,
  resolveMeshResolutionFallbackEnabled,
} from "@/lib/api/search-flags";
import {
  isMethodPagesEnabled,
  isMethodFamilySynonymsEnabled,
} from "@/lib/profile/methods-lens-flags";
import { familySynonymKeys } from "@/lib/methods/family-synonyms";
import {
  loadFamilyOverlayGate,
  isFamilyPubliclyVisible,
  familyOverlayKey,
  type FamilyOverlayGate,
} from "@/lib/api/methods-overlay";
import {
  supercategoryLabel,
  supercategoryDescription,
} from "@/lib/methods/supercategory-labels";
import { methodFamilyPath, methodSupercategoryPath } from "@/lib/method-url";
import { loadPublicationSuppressions, resolveDarkPmids } from "@/lib/api/manual-layer";

const MIN_QUERY_LEN = 3;
const SECONDARY_CAP = 4;
/** Issue #709 — max chips the row will ever show (the inline-expand ceiling,
 *  RA-19). Beyond this, the "+N more" affordance routes to Browse. */
const ROW_AREA_CAP = 12;
/** Cap candidates considered before enrichment. Anything beyond this rolls
 *  into the overflow count without being individually counted/ranked. */
const MATCH_HARD_CAP = 1 + SECONDARY_CAP + 20;

/**
 * Entity types the taxonomy-match callout can surface. `parentTopic` / `subtopic`
 * are the curated Topic taxonomy (chip row, #709); `methodFamily` / `supercategory`
 * are the cross-scholar Method taxonomy (#824 PR-2 / #860 — rendered as a labeled
 * "Methods and Tools" chip row mirroring the Topic "Research Areas" row, and gated
 * behind `isMethodPagesEnabled()`).
 */
export type TaxonomyEntityType =
  | "parentTopic"
  | "subtopic"
  | "methodFamily"
  | "supercategory";

export type TaxonomyMatch = {
  entityType: TaxonomyEntityType;
  id: string;
  name: string;
  parentTopicId: string | null;
  parentTopicLabel: string | null;
  href: string;
  scholarCount: number;
  publicationCount: number;
  /** Length-normalized substring overlap, in [0, 1]. */
  similarity: number;
  /**
   * Issue #709 — one-line area description for the chip hover preview (same
   * text as the topic page). Null when the topic/subtopic has no description.
   * For a Method match (#824), the supercategory's SEO description (family
   * matches carry their supercategory's description as the one-liner).
   */
  description: string | null;
  /**
   * Issue #709 — number of child subtopics (parentTopic only; 0 for a
   * subtopic). Drives the popover "publications · subtopics" stat line.
   */
  subtopicCount: number;
  /**
   * #824 follow-up (match-aware snippet) — the matched method family's STABLE
   * `(supercategory, familyLabel)` identity, populated on `methodFamily` /
   * `supercategory` matches and null on Topic/Subtopic matches. The search page
   * reads these off `methodMatches[0]` to identify the resolved family by
   * (supercategory, familyLabel) and derive the per-scholar method reason from
   * `scholar_family` at query time. `familyLabel` is null on a `supercategory`
   * match (no single family). Threaded straight through from the matching
   * `EntityCandidate`, which already carries them.
   */
  supercategory: string | null;
  familyLabel: string | null;
};

/**
 * MeSH descriptor resolution (issue #259 §1.5). Returned alongside curated
 * taxonomy matches; consumers (§1.6, §1.11) can use this without touching
 * the curated-callout shape.
 */
export type MeshResolution = {
  descriptorUi: string;
  name: string;
  /** The exact surface form (verbatim) that drove the match. */
  matchedForm: string;
  /**
   * `exact`/`entry-term` = the whole query matched a descriptor name / NLM
   * entry-term / curated alias. `partial` = the decompose-and-resolve fallback
   * (`SEARCH_MESH_RESOLUTION_FALLBACK`): the whole query missed, but a contiguous
   * word-window of it matched — an interpretation, ranked beneath every verbatim
   * tier (see `MESH_ADMIT_WEIGHT`). `matchedForm` is then the matched window.
   */
  confidence: "exact" | "entry-term" | "partial";
  scopeNote: string | null;
  entryTerms: string[];
  /**
   * Populated from `mesh_curated_topic_anchor` (spec §1.4); empty when the
   * descriptor has no anchor row. §1.6 / §2.4 fall back to MeSH-only when
   * empty.
   */
  curatedTopicAnchors: string[];
  /**
   * Issue #259 / SPEC §5.4.2. UIs of descriptors whose tree numbers are
   * prefix-subsumed by any of this descriptor's tree numbers. Always non-empty
   * — the resolved descriptor itself is always the first element. Bounded by
   * DESCENDANT_HARD_CAP (200). Consumed by the §5 `concept_expanded` shape in
   * a follow-up PR as the `terms { meshDescriptorUi }` array; today logged on
   * the publications-branch `search_query` line for baseline analysis only.
   */
  descendantUis: string[];
  /**
   * #726 — true when the normalized query matched more than one candidate
   * descriptor (the resolver tiebreaks a winner). A unique match is
   * trustworthy; an ambiguous one is the risky case the sparse-escalation
   * floor guards against. Optional so existing fixtures need not set it;
   * the resolver always populates it.
   */
  ambiguous?: boolean;
};

export type TaxonomyMatchResult =
  | { state: "none"; meshResolution: MeshResolution | null }
  | {
      state: "matches";
      primary: TaxonomyMatch;
      secondary: TaxonomyMatch[];
      /** Count of secondary matches that didn't fit inline (secondary.length > SECONDARY_CAP). */
      overflowCount: number;
      /** Original query, used for the overflow link target. */
      query: string;
      meshResolution: MeshResolution | null;
      /**
       * Issue #709 — the matched research areas ranked for the search-header
       * "Research Areas" chip row, by match relevance (RA-18). Enriched with
       * description + subtopicCount, capped at ROW_AREA_CAP (the inline-expand
       * ceiling). `totalMatched` is the true count of matched areas (drives the
       * "+N more" affordance, N = totalMatched − 4).
       */
      areas: TaxonomyMatch[];
      totalMatched: number;
      /**
       * #824 PR-2 — matched Method taxonomy entities (families + supercategories),
       * ranked, for the method-tinted callout card in `research-areas-row.tsx`.
       * SEPARATE from `areas` (the Topic/Subtopic chip row) so topic rendering is
       * untouched. Empty when `METHODS_LENS_PAGES` is off or nothing matched. Every
       * entry has already passed the §3.4 overlay gate (suppressed/sensitive families
       * never appear). At most ONE supercategory + a small set of families render.
       */
      methodMatches: TaxonomyMatch[];
    };

// `normalizeForMatch` now lives in the dependency-free `@/lib/api/normalize`
// leaf module (#692); re-exported here so existing call sites that import it
// from `@/lib/api/search-taxonomy` keep working unchanged. The #690/#642
// Bucket-A connector-drop (`\band\b`) lives in that module now.
export { normalizeForMatch };

type EntityCandidate = {
  entityType: TaxonomyEntityType;
  id: string;
  /** Visible name. Topics use label; subtopics use displayName ?? label. */
  name: string;
  /** Match haystack — Topic.label or Subtopic.label, normalized. */
  matchKey: string;
  /** #1255 — token start offsets in `matchKey`, so a query must align to a
   *  token boundary instead of matching mid-word ("aging" ⊄ "imaging"). */
  tokenStarts: number[];
  parentTopicId: string | null;
  parentTopicLabel: string | null;
  /** Issue #709 — area description (Topic/Subtopic.description) for the popover. */
  description: string | null;
  /** Issue #709 — child-subtopic count (parentTopic only; 0 for a subtopic). */
  subtopicCount: number;
  /**
   * #824 — Method-candidate routing fields, set ONLY on `methodFamily` /
   * `supercategory` candidates (null on Topic candidates). `supercategory` is the
   * A2 supercategory id; `familyId` / `familyLabel` are the representative family
   * for a `methodFamily` candidate (used to build the `/methods/.../[family]` href
   * and to recompute counts from `scholar_family`).
   */
  supercategory: string | null;
  familyId: string | null;
  familyLabel: string | null;
  /**
   * Curated synonym match-keys (normalized) for a `methodFamily` candidate — the
   * lay-term / brand / acronym forms that should also match this family
   * (`lib/methods/family-synonyms.ts`). Empty/undefined on every other candidate
   * kind and when `METHODS_LENS_FAMILY_SYNONYMS` is off. Matched against the query's
   * whole-word windows in `matchQueryToTaxonomy`, never as a raw substring.
   */
  synonymKeys?: readonly string[];
};

// Request-scoped memo (B6): the generic-strip retry calls `matchQueryToTaxonomy`
// a second time within one request, which re-runs this loader (3 Prisma queries
// + the method-candidate groupBy/overlay read). React `cache()` collapses the
// second call to the first's result so the retry only re-runs the in-memory
// substring filter. Scoped to the request — deliberately NOT a cross-request
// TTL cache, which would freeze #800/#801 method-family visibility (the overlay
// gate is read live inside `loadMethodCandidates`). Mirrors `profile.ts`.
const loadEntityCandidates = cache(async (): Promise<EntityCandidate[]> => {
  const [topics, subtopics, subtopicCounts] = await Promise.all([
    prisma.topic.findMany({ select: { id: true, label: true, description: true } }),
    prisma.subtopic.findMany({
      select: {
        id: true,
        label: true,
        displayName: true,
        description: true,
        parentTopicId: true,
        parentTopic: { select: { label: true } },
      },
    }),
    // Issue #709 — child-subtopic count per parent topic, one groupBy instead of
    // a count query per enriched candidate.
    prisma.subtopic.groupBy({ by: ["parentTopicId"], _count: { _all: true } }),
  ]);
  const subtopicCountByParent = new Map(
    subtopicCounts.map((r) => [r.parentTopicId, r._count._all]),
  );

  const out: EntityCandidate[] = [];
  for (const t of topics) {
    const { matchKey: key, tokenStarts } = normalizeWithTokenStarts(t.label);
    if (!key) continue;
    out.push({
      entityType: "parentTopic",
      id: t.id,
      name: t.label,
      matchKey: key,
      tokenStarts,
      parentTopicId: null,
      parentTopicLabel: null,
      description: t.description ?? null,
      subtopicCount: subtopicCountByParent.get(t.id) ?? 0,
      supercategory: null,
      familyId: null,
      familyLabel: null,
    });
  }
  for (const s of subtopics) {
    const display = s.displayName?.trim() || s.label;
    const { matchKey, tokenStarts } = normalizeWithTokenStarts(display);
    if (!matchKey) continue;
    out.push({
      entityType: "subtopic",
      id: s.id,
      name: display,
      matchKey,
      tokenStarts,
      parentTopicId: s.parentTopicId,
      parentTopicLabel: s.parentTopic?.label ?? null,
      description: s.description ?? null,
      subtopicCount: 0,
      supercategory: null,
      familyId: null,
      familyLabel: null,
    });
  }

  // #824 PR-2 — Method taxonomy candidates (families + supercategories), gated
  // behind METHODS_LENS_PAGES. Off ⇒ add NOTHING (no candidates), so search is
  // byte-identical to pre-#824 when the flag is off. Every candidate passes the
  // §3.4 overlay gate so #800-suppressed / #801-sensitive families never surface.
  if (isMethodPagesEnabled()) {
    out.push(...(await loadMethodCandidates()));
  }
  return out;
});

/**
 * #824 PR-2 — Method-taxonomy candidates from `scholar_family`, overlay-gated.
 *
 * Two candidate kinds:
 *   - `methodFamily`: one per DISTINCT publicly-visible `(supercategory, familyLabel)`.
 *     `matchKey`/`name` = the family label; `familyId` = a representative id (the
 *     min) for the `/methods/[sc]/[family]` href. A family that fails
 *     {@link isFamilyPubliclyVisible} is dropped.
 *   - `supercategory`: one per DISTINCT supercategory that has ≥1 publicly-visible
 *     family. `matchKey`/`name` = `supercategoryLabel(id)`; `description` =
 *     `supercategoryDescription(id)`.
 *
 * The overlay gate is loaded ONCE here and applied to both kinds.
 */
async function loadMethodCandidates(): Promise<EntityCandidate[]> {
  // Curated synonyms only participate when the flag is on; off ⇒ never attach,
  // so the candidate set is byte-identical to the pre-synonym behavior.
  const synonymsOn = isMethodFamilySynonymsEnabled();
  const [rows, gate] = await Promise.all([
    // Distinct (supercategory, familyLabel) with a representative familyId. `_min`
    // gives a stable representative id within a load (familyId re-mints per
    // rebuild, but the page resolves by (sc,label) and uses the suffix only to
    // disambiguate — any live id under the pair routes correctly).
    prisma.scholarFamily.groupBy({
      by: ["supercategory", "familyLabel"],
      _min: { familyId: true },
    }),
    loadFamilyOverlayGate(),
  ]);

  const out: EntityCandidate[] = [];
  // Track which supercategories have ≥1 visible family, so a supercategory becomes
  // a candidate ONLY if it survives the gate via at least one family.
  const visibleSupercategories = new Set<string>();

  for (const r of rows) {
    if (!isFamilyPubliclyVisible(r.supercategory, r.familyLabel, gate)) continue;
    visibleSupercategories.add(r.supercategory);

    const { matchKey, tokenStarts } = normalizeWithTokenStarts(r.familyLabel);
    if (!matchKey) continue;
    const familyId = r._min.familyId ?? "";
    out.push({
      entityType: "methodFamily",
      // Stable composite identity for the chip key + dedupe; not a DB id.
      id: `family:${familyOverlayKey(r.supercategory, r.familyLabel)}`,
      name: r.familyLabel,
      matchKey,
      tokenStarts,
      parentTopicId: null,
      parentTopicLabel: null,
      // The family's supercategory description doubles as the one-line descriptor.
      description: supercategoryDescription(r.supercategory),
      subtopicCount: 0,
      supercategory: r.supercategory,
      familyId,
      familyLabel: r.familyLabel,
      synonymKeys: synonymsOn
        ? familySynonymKeys(r.supercategory, r.familyLabel)
        : undefined,
    });
  }

  for (const sc of visibleSupercategories) {
    const label = supercategoryLabel(sc);
    const { matchKey, tokenStarts } = normalizeWithTokenStarts(label);
    if (!matchKey) continue;
    out.push({
      entityType: "supercategory",
      id: `supercategory:${sc}`,
      name: label,
      matchKey,
      tokenStarts,
      parentTopicId: null,
      parentTopicLabel: null,
      description: supercategoryDescription(sc),
      subtopicCount: 0,
      supercategory: sc,
      familyId: null,
      familyLabel: null,
    });
  }

  return out;
}

async function getCounts(
  candidate: EntityCandidate,
  methodGate: FamilyOverlayGate | null,
): Promise<{ scholarCount: number; publicationCount: number }> {
  if (candidate.entityType === "methodFamily" || candidate.entityType === "supercategory") {
    // The candidate already passed the overlay gate in loadMethodCandidates, but
    // the supercategory rollup still needs the gate to exclude suppressed/sensitive
    // families when counting. `methodGate` is always non-null for a method candidate.
    const gate = methodGate ?? (await loadFamilyOverlayGate());
    return candidate.entityType === "methodFamily"
      ? getFamilyCandidateCounts(candidate, gate)
      : getSupercategoryCandidateCounts(candidate, gate);
  }
  if (candidate.entityType === "parentTopic") {
    const [scholars, pubs] = await Promise.all([
      prisma.publicationTopic.groupBy({
        by: ["cwid"],
        where: {
          parentTopicId: candidate.id,
          scholar: { deletedAt: null, status: "active" },
        },
      }),
      prisma.publicationTopic.groupBy({
        by: ["pmid"],
        where: { parentTopicId: candidate.id },
      }),
    ]);
    return { scholarCount: scholars.length, publicationCount: pubs.length };
  }
  const [scholars, pubs] = await Promise.all([
    prisma.publicationTopic.groupBy({
      by: ["cwid"],
      where: {
        primarySubtopicId: candidate.id,
        scholar: { deletedAt: null, status: "active" },
      },
    }),
    prisma.publicationTopic.groupBy({
      by: ["pmid"],
      where: { primarySubtopicId: candidate.id },
    }),
  ]);
  return { scholarCount: scholars.length, publicationCount: pubs.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// #824 PR-2 — Method-candidate counts (consistent with the /methods page loaders)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a deduped, dark-filtered PMID set from a list of `scholar_family.pmids`
 * JSON arrays (the same union the page loaders perform). `#356` whole-pub
 * takedowns / derived-dark PMIDs are removed. Empty when no rows carry pmids
 * (pre-#175 rollup — counts then report 0 publications, no crash).
 */
async function collectDistinctPmids(
  rows: Array<{ pmids: unknown }>,
): Promise<string[]> {
  const set = new Set<string>();
  for (const r of rows) {
    if (Array.isArray(r.pmids)) {
      for (const p of r.pmids as unknown[]) set.add(String(p));
    }
  }
  const pmids = [...set];
  if (pmids.length === 0) return [];
  const suppressions = await loadPublicationSuppressions(pmids, prisma);
  const dark = await resolveDarkPmids(pmids, suppressions, prisma);
  return pmids.filter((p) => !dark.has(p));
}

/**
 * Family candidate counts: distinct ACTIVE scholars in `(supercategory, familyLabel)`
 * (one row per `(cwid, family)` via the unique, so distinct-cwid groupBy length IS
 * the scholar count) + the distinct, dark-filtered publication count (union of the
 * member `pmids`). Mirrors `getDistinctScholarCountForFamily` + the page pub feed.
 */
async function getFamilyCandidateCounts(
  candidate: EntityCandidate,
  gate: FamilyOverlayGate,
): Promise<{ scholarCount: number; publicationCount: number }> {
  const supercategory = candidate.supercategory!;
  const familyLabel = candidate.familyLabel!;
  // Defense-in-depth: the candidate already passed the gate, but never count a
  // suppressed/sensitive family even if reached.
  if (!isFamilyPubliclyVisible(supercategory, familyLabel, gate)) {
    return { scholarCount: 0, publicationCount: 0 };
  }
  const rows = await prisma.scholarFamily.findMany({
    where: {
      supercategory,
      familyLabel,
      scholar: { deletedAt: null, status: "active" },
    },
    select: { cwid: true, pmids: true },
  });
  const scholarCount = new Set(rows.map((r) => r.cwid)).size;
  const pmids = await collectDistinctPmids(rows);
  return { scholarCount, publicationCount: pmids.length };
}

/**
 * Supercategory candidate counts: rolled up across the supercategory's
 * PUBLICLY-VISIBLE families. `scholarCount` = distinct active scholars across those
 * families (the safe additive number — a scholar in two families counts once);
 * `publicationCount` = distinct, dark-filtered union of member `pmids` across the
 * visible families. Suppressed/sensitive families never contribute.
 */
async function getSupercategoryCandidateCounts(
  candidate: EntityCandidate,
  gate: FamilyOverlayGate,
): Promise<{ scholarCount: number; publicationCount: number }> {
  const supercategory = candidate.supercategory!;
  const rows = await prisma.scholarFamily.findMany({
    where: {
      supercategory,
      scholar: { deletedAt: null, status: "active" },
    },
    select: { cwid: true, familyLabel: true, pmids: true },
  });
  const visible = rows.filter((r) =>
    isFamilyPubliclyVisible(supercategory, r.familyLabel, gate),
  );
  const scholarCount = new Set(visible.map((r) => r.cwid)).size;
  const pmids = await collectDistinctPmids(visible);
  return { scholarCount, publicationCount: pmids.length };
}

function buildHref(candidate: EntityCandidate): string {
  if (candidate.entityType === "methodFamily") {
    return methodFamilyPath(
      candidate.supercategory!,
      candidate.familyId ?? "",
      candidate.familyLabel ?? candidate.name,
    );
  }
  if (candidate.entityType === "supercategory") {
    return methodSupercategoryPath(candidate.supercategory!);
  }
  if (candidate.entityType === "parentTopic") {
    return `/topics/${candidate.id}`;
  }
  const params = new URLSearchParams({ subtopic: candidate.id });
  return `/topics/${candidate.parentTopicId}?${params.toString()}`;
}

/**
 * Type priority for ranking taxonomy matches. parentTopic first, then subtopic,
 * then the Method taxonomy (#824 — supercategory before methodFamily, mirroring
 * parent-before-child). Methods land AFTER topics/subtopics so a topic match always
 * leads the callout when both kinds match the same query.
 */
function typePriorityFor(t: TaxonomyEntityType): number {
  switch (t) {
    case "parentTopic":
      return 0;
    case "subtopic":
      return 1;
    case "supercategory":
      return 2;
    case "methodFamily":
      return 3;
  }
}

function rank(matches: TaxonomyMatch[]): TaxonomyMatch[] {
  const typePriority = typePriorityFor;
  return matches.slice().sort((a, b) => {
    const t = typePriority(a.entityType) - typePriority(b.entityType);
    if (t !== 0) return t;
    // Issue #74 — within a tier, prefer the broader topic when several
    // sibling labels substring-match a broad query. scholarCount is the
    // best available proxy for "umbrella vs. specific subtype": for
    // "cancer", "Cancer Biology (General)" carries more scholars than
    // "Lung Cancer" or "Breast Cancer" and lands first. Narrow queries
    // ("lung cancer") only substring-match a single parent so the
    // tie-break never fires.
    const c = b.scholarCount - a.scholarCount;
    if (c !== 0) return c;
    const sim = b.similarity - a.similarity;
    if (sim !== 0) return sim;
    return a.name.localeCompare(b.name);
  });
}

export async function matchQueryToTaxonomy(
  query: string,
): Promise<TaxonomyMatchResult> {
  const trimmed = query.trim();
  const normalized = normalizeForMatch(trimmed);
  if (normalized.length < MIN_QUERY_LEN) {
    return { state: "none", meshResolution: null };
  }

  const [all, meshResolution] = await Promise.all([
    loadEntityCandidates(),
    resolveMeshDescriptor(trimmed),
  ]);
  // Curated method-family synonyms (flag-gated; only methodFamily candidates carry
  // `synonymKeys`). Match a synonym only when it equals a whole-word WINDOW of the
  // query — window-exact, never raw substring — so a short acronym like "ML" matches
  // the query "ML" but never the token "html". Windows are computed once, and only
  // when some candidate actually carries synonyms.
  const queryWindows =
    all.some((c) => c.synonymKeys && c.synonymKeys.length > 0)
      ? normalizedWindows(trimmed)
      : null;

  const matchedAll = all
    .map((c) => {
      // #1255 — token-boundary match, not a raw substring: a short common query
      // like "aging" must not match mid-word inside "Medical Imaging", while
      // prefix ("cardio" -> "Cardiovascular Disease") and whole-word or
      // multi-token matches still hold.
      const canonical = matchesAtTokenBoundary(c.matchKey, c.tokenStarts, normalized);
      const synonym =
        !canonical &&
        queryWindows !== null &&
        c.synonymKeys !== undefined &&
        c.synonymKeys.some((k) => queryWindows.has(k));
      if (!canonical && !synonym) return null;
      // Canonical hits keep length-normalized similarity; a curated synonym hit is
      // an explicit editorial mapping, so it scores as a strong (1.0) match.
      const similarity = canonical ? normalized.length / c.matchKey.length : 1;
      return { ...c, similarity };
    })
    .filter((c): c is EntityCandidate & { similarity: number } => c !== null);
  if (matchedAll.length === 0) return { state: "none", meshResolution };

  // #824 PR-2 — partition Topic-taxonomy matches (the #709 chip row + the existing
  // primary/secondary/overflow affordances) from Method-taxonomy matches (the new
  // method-tinted callout card). They are surfaced through DIFFERENT result fields,
  // so the Topic chip-row counts (`totalMatched`/`overflowCount`) never change shape
  // when the Method flag is off (no method candidates), and never include methods
  // when it's on.
  const isMethodKind = (t: TaxonomyEntityType) =>
    t === "methodFamily" || t === "supercategory";
  const matched = matchedAll.filter((c) => !isMethodKind(c.entityType));
  const matchedMethods = matchedAll.filter((c) => isMethodKind(c.entityType));

  // The overlay gate is loaded ONCE per request inside loadEntityCandidates; load
  // it again here only when there are method matches to enrich (the supercategory
  // rollup count needs it). Off-flag / no-method-match ⇒ never loaded.
  const methodGate: FamilyOverlayGate | null =
    matchedMethods.length > 0 ? await loadFamilyOverlayGate() : null;

  // Pre-rank by [type priority, similarity desc] before the hard cap so the
  // best candidates make it through to count enrichment regardless of how
  // many low-similarity matches the query produced.
  matched.sort((a, b) => {
    const t = typePriorityFor(a.entityType) - typePriorityFor(b.entityType);
    if (t !== 0) return t;
    return b.similarity - a.similarity;
  });

  // Cap candidates before count enrichment. Excess rolls into overflow so
  // we don't pay for N count queries on common substring matches.
  const considered = matched.slice(0, MATCH_HARD_CAP);
  const cappedExtra = matched.length - considered.length;

  const enrich = async (c: (typeof matchedAll)[number]): Promise<TaxonomyMatch> => {
    const counts = await getCounts(c, methodGate);
    return {
      entityType: c.entityType,
      id: c.id,
      name: c.name,
      parentTopicId: c.parentTopicId,
      parentTopicLabel: c.parentTopicLabel,
      href: buildHref(c),
      scholarCount: counts.scholarCount,
      publicationCount: counts.publicationCount,
      similarity: c.similarity,
      description: c.description,
      subtopicCount: c.subtopicCount,
      // #824 follow-up — carry the method family's stable identity through to the
      // public match. Null on Topic/Subtopic candidates (set null there); on a
      // supercategory candidate `familyLabel` is null (no single family).
      supercategory: c.supercategory,
      familyLabel: c.familyLabel,
    };
  };

  const enriched = await Promise.all(considered.map(enrich));

  // #824 — enrich + rank the Method matches independently. Supercategory before
  // family (typePriorityFor), then scholarCount desc, then similarity, then name —
  // so the broadest, densest method lands first in the callout. Capped at
  // SECONDARY_CAP+1 so an over-broad family-label substring never floods the card.
  const enrichedMethods = (
    await Promise.all(matchedMethods.map(enrich))
  ).sort(
    (a, b) =>
      typePriorityFor(a.entityType) - typePriorityFor(b.entityType) ||
      b.scholarCount - a.scholarCount ||
      b.similarity - a.similarity ||
      a.name.localeCompare(b.name),
  );
  // #1257 — collapse method/tool chips that share a display label, keeping the
  // best-ranked representative per name (same rationale as the area chips).
  const methodMatches = dedupeFirstByKey(
    enrichedMethods,
    (m) => m.name.toLowerCase(),
  ).slice(0, SECONDARY_CAP + 1);

  const ranked = rank(enriched);
  // When ONLY Method matches exist (no Topic/Subtopic), there is no topic primary —
  // fall back to the top method as `primary` to satisfy the `matches`-state contract
  // (it does NOT render in the Topic chip row: `areas` is topic-only and empty, so
  // ResearchAreasRow renders nothing; the method renders via `methodMatches`).
  const primary = ranked[0] ?? methodMatches[0];
  const rest = ranked.slice(1);
  const visibleSecondary = rest.slice(0, SECONDARY_CAP);
  const overflowCount =
    Math.max(0, rest.length - SECONDARY_CAP) + cappedExtra;

  // Issue #709 — chip row, ordered by match relevance (RA-18): similarity desc,
  // then scholarCount desc, then name. Distinct from the card's `primary`
  // (scholarCount-first, #74). Capped at the inline-expand ceiling; totalMatched
  // is the full substring-match count for the "+N more" affordance. Topic-kind only.
  const areas = dedupeFirstByKey(
    enriched
      .slice()
      .sort(
        (a, b) =>
          b.similarity - a.similarity ||
          b.scholarCount - a.scholarCount ||
          a.name.localeCompare(b.name),
      ),
    // #1257 — distinct subtopic matches can share a display name (same label
    // under different parents); keep the best-ranked representative per name so
    // the chip row stops showing one subarea 3×.
    (a) => a.name.toLowerCase(),
  ).slice(0, ROW_AREA_CAP);
  const totalMatched = matched.length;

  return {
    state: "matches",
    primary,
    secondary: visibleSecondary,
    overflowCount,
    query: trimmed,
    meshResolution,
    areas,
    totalMatched,
    methodMatches,
  };
}

/**
 * #824 follow-up (match-aware snippet) — the resolved-match context the People
 * search consumes to derive the per-scholar method/topic reason at query time.
 * Built off an already-resolved {@link TaxonomyMatchResult} so there is no second
 * taxonomy round-trip:
 *
 *   - `methodFamily` — the top method match's stable `(supercategory, familyLabel)`
 *     identity. Null when no method matched (or the top method match is a bare
 *     supercategory with no single family).
 *   - `topics` — the matched research-area topics as `{ slug, label }`, where
 *     `slug` is the PARENT-topic id (`areasOfInterest` is a space-join of
 *     parent-topic ids, so a subtopic match keys on its `parentTopicId`) and
 *     `label` is the clean parent-topic label.
 *
 * Returns `undefined` on a non-"matches" result (nothing to surface). Pure: no
 * DB/OpenSearch — safe in both the SSR page and the route handler.
 */
export type PeopleMatchAwareContext = {
  methodFamily: { supercategory: string; familyLabel: string } | null;
  topics: { slug: string; label: string }[];
};

export function buildMatchAwareContext(
  result: TaxonomyMatchResult,
): PeopleMatchAwareContext | undefined {
  if (result.state !== "matches") return undefined;

  // Top method match → its (supercategory, familyLabel). A bare supercategory
  // match (familyLabel null) carries no single family, so it contributes no
  // method reason.
  const topMethod = result.methodMatches[0];
  const methodFamily =
    topMethod && topMethod.supercategory && topMethod.familyLabel
      ? { supercategory: topMethod.supercategory, familyLabel: topMethod.familyLabel }
      : null;

  // Matched topic areas → { parent-topic slug, parent-topic label }, deduped by
  // slug (multiple matched subtopics under one parent collapse to one reason).
  const seen = new Set<string>();
  const topics: { slug: string; label: string }[] = [];
  for (const a of result.areas) {
    const slug = a.entityType === "subtopic" ? a.parentTopicId : a.id;
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const label =
      a.entityType === "subtopic" ? a.parentTopicLabel ?? a.name : a.name;
    topics.push({ slug, label });
  }

  return { methodFamily, topics };
}

// ─────────────────────────────────────────────────────────────────────────────
// MeSH descriptor resolution (§1.5)
// ─────────────────────────────────────────────────────────────────────────────

type DescriptorRow = {
  descriptorUi: string;
  name: string;
  entryTerms: string[];
  scopeNote: string | null;
  dateRevised: Date | null;
  /** §1.7 — fraction of indexed pubs tagged with this descriptor.
   *  NULL when the coverage ETL hasn't populated yet (e.g., immediately
   *  after a MeSH-descriptor full-replace). Treated as lowest priority
   *  in the resolver tiebreaker so a fully-NULL column degrades to the
   *  pre-§1.7 ordering. */
  localPubCoverage: number | null;
  /** Issue #259 / §5.4.2. JSON string array from `mesh_descriptor.tree_numbers`
   *  (e.g. ["N03.219", "N03.706"]). Used by the eager descendant precompute
   *  below; never surfaced to callers directly. Empty array if the column was
   *  empty/null in the source — surfaced as a data-anomaly aggregate warn. */
  treeNumbers: string[];
};

type MeshMap = {
  /** normalized surface form → descriptorUi[] (array because of collisions across descriptors) */
  byForm: Map<string, string[]>;
  /** descriptorUi → row */
  byUi: Map<string, DescriptorRow>;
  /**
   * descriptorUi → parentTopicId[] (any confidence). Empty array entries
   * are not stored — `.get(ui)` returns undefined when no anchor exists.
   * Loaded from `mesh_curated_topic_anchor` (spec §1.4).
   */
  anchorsByUi: Map<string, string[]>;
  /**
   * Issue #259 / §5.4.2. descriptorUi → [self, ...descendants in tn-walk order],
   * bounded by DESCENDANT_HARD_CAP. Populated eagerly at map-load time for every
   * descriptor in `byUi`; `getOrComputeDescendants` is the single read-path
   * helper. Populated lazily as a defensive fallback if a miss is ever
   * observed (test-only transient under normal operation).
   */
  descendantsByUi: Map<string, string[]>;
  /**
   * Issue #259 / §5.4.2. Parallel-array sorted index over (treeNumber,
   * descriptorUi). Built once at map-load time; consulted by
   * `computeDescendants` for both the eager precompute pass and any
   * subsequent lazy miss. `tns[i]` and `uis[i]` describe the i-th tree-number
   * occurrence in sort order; `tns` is sorted lex ascending.
   *
   * Retained on the map (rather than scoped to the load IIFE) so the lazy
   * fallback in `getOrComputeDescendants` has it available without rebuilding.
   * Memory budget: ~5 MB for the current MeSH corpus.
   */
  treePrefixIndex: { tns: string[]; uis: string[] };
  /** EtlRun.manifestSha256 captured at load time, used for invalidation. */
  manifestSha256: string | null;
  loadedAt: number;
};

/** Soft refresh interval. The real invalidation signal is the EtlRun sha256
 *  diff below — this only bounds how often the freshness probe runs. */
const MESH_MAP_REFRESH_MS = 60 * 60 * 1000; // 1h

/** Issue #259 / SPEC §5.6. Cap on the number of UIs returned in
 *  `MeshResolution.descendantUis`. Bounds the future `terms { meshDescriptorUi }`
 *  array in the `concept_expanded` shape; ranking saturates well before
 *  this size, so the cap costs little recall. Inline literal, not externalized. */
const DESCENDANT_HARD_CAP = 200;

let meshMapCache: MeshMap | null = null;
let meshMapInFlight: Promise<MeshMap> | null = null;

/** Latest successful MeSH ETL manifest sha — single indexed lookup. */
async function latestMeshManifest(): Promise<string | null> {
  const row = await prisma.etlRun.findFirst({
    where: { source: "MeSH", status: "success" },
    orderBy: { completedAt: "desc" },
    select: { manifestSha256: true },
  });
  return row?.manifestSha256 ?? null;
}

/**
 * Issue #259 / §5.4.2. Return the descendant UI array for `ui`, computing
 * it on miss and caching the result on the map.
 *
 * Steady-state (post-eager-precompute): `map.descendantsByUi.get(ui)` is a
 * hit on every call. Cost: one Map lookup.
 *
 * Cold-load / test transient (descendantsByUi not yet fully populated for
 * `ui`): compute synchronously by binary-searching the parallel-array tree
 * prefix index and walking contiguous prefix-matching entries up to
 * DESCENDANT_HARD_CAP. Worst-case ~5ms for a broad descriptor against the
 * 30k-row MeSH corpus.
 *
 * Thunder-herd note: if N concurrent reads on a fresh map all miss for the
 * same `ui`, each computes independently and the last `Map.set` wins.
 * Output is deterministic for a fixed input snapshot (same `byUi`, same
 * `treePrefixIndex`), so the duplicate-write race is benign — every writer
 * stores the same array contents.
 */
function getOrComputeDescendants(
  map: Pick<MeshMap, "byUi" | "descendantsByUi" | "treePrefixIndex">,
  ui: string,
): string[] {
  const cached = map.descendantsByUi.get(ui);
  if (cached) return cached;
  const computed = computeDescendants(ui, map);
  map.descendantsByUi.set(ui, computed);
  return computed;
}

/**
 * Issue #259 / §5.4.2. Synchronously compute `[self, ...descendants]` from
 * the prefix index. This is the DOWNWARD tree-number walk (descriptors whose
 * tree numbers are prefixed BY this concept's). Its UPWARD counterpart — a
 * descriptor's ANCESTOR concepts (whose tree numbers PREFIX it) — lives in the
 * dependency-free `@/lib/mesh-tree-ancestors`, shared with the people-doc ETL
 * builder. The two directions use distinct index shapes (this one's sorted
 * parallel-array prefix scan vs. the ancestor module's tree-number→UI map), so
 * they are deliberately NOT merged; the shared contract is the dot-segment
 * prefix semantics (`startsWith(`${tn}.`)`), kept identical in both.
 *
 * Result invariants:
 *   - First element is always `ui`.
 *   - Subsequent elements are descendant UIs in tree-number-walk order,
 *     deduped (a descendant reachable via two of `ui`'s tree numbers
 *     appears once).
 *   - Length ≤ DESCENDANT_HARD_CAP.
 *   - If `byUi.get(ui)` returns undefined (caller bug) or has empty
 *     `treeNumbers`, returns `[ui]`.
 */
function computeDescendants(
  ui: string,
  map: Pick<MeshMap, "byUi" | "treePrefixIndex">,
): string[] {
  const row = map.byUi.get(ui);
  if (!row) return [ui];
  const result: string[] = [ui];
  const seen = new Set<string>([ui]);
  const { tns, uis } = map.treePrefixIndex;
  for (const tn of row.treeNumbers) {
    if (typeof tn !== "string" || tn.length === 0) continue;
    const tnDot = `${tn}.`;
    // Lower-bound binary search: first index i where tns[i] >= tn.
    let lo = 0;
    let hi = tns.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tns[mid] < tn) lo = mid + 1;
      else hi = mid;
    }
    // Walk contiguous entries while the prefix holds:
    //   entry === tn (self, or another descriptor sharing this tn — rare)
    //   entry.startsWith(`${tn}.`) (proper descendant)
    for (let i = lo; i < tns.length; i++) {
      const cand = tns[i];
      if (cand !== tn && !cand.startsWith(tnDot)) break;
      const candUi = uis[i];
      if (seen.has(candUi)) continue;
      seen.add(candUi);
      result.push(candUi);
      if (result.length >= DESCENDANT_HARD_CAP) return result;
    }
    if (result.length >= DESCENDANT_HARD_CAP) return result;
  }
  return result;
}

async function getMeshMap(): Promise<MeshMap> {
  if (meshMapCache) {
    const age = Date.now() - meshMapCache.loadedAt;
    if (age < MESH_MAP_REFRESH_MS) return meshMapCache;
    // Past the refresh interval: see whether the ETL has shipped a new
    // manifest. Sha match → reuse and bump loadedAt. Sha differs → reload.
    try {
      const latest = await latestMeshManifest();
      if (latest === meshMapCache.manifestSha256) {
        meshMapCache.loadedAt = Date.now();
        return meshMapCache;
      }
    } catch {
      // Freshness probe failed — serve stale instead of thrashing.
      meshMapCache.loadedAt = Date.now();
      return meshMapCache;
    }
  }
  if (meshMapInFlight) return meshMapInFlight;
  meshMapInFlight = (async () => {
    const [rows, manifestSha256, anchors, aliases] = await Promise.all([
      prisma.meshDescriptor.findMany({
        select: {
          descriptorUi: true,
          name: true,
          entryTerms: true,
          scopeNote: true,
          dateRevised: true,
          localPubCoverage: true,
          // §5.4.2 — JSON array of tree numbers. Already populated by the
          // existing MeSH ETL; widening the select is the only DB-side change.
          treeNumbers: true,
        },
      }),
      latestMeshManifest().catch(() => null),
      // §1.4 — anchor rows. Loaded alongside descriptors so the resolver
      // can populate `curatedTopicAnchors` and apply the anchor-exists
      // tiebreaker without a second round-trip. Invalidation piggybacks
      // on the existing MeSH-manifest sha refresh tick; up to 1h staleness
      // for anchor edits is acceptable while §1.6 has no consumer.
      prisma.meshCuratedTopicAnchor.findMany({
        select: { descriptorUi: true, parentTopicId: true },
      }),
      // #642 — curated query→descriptor aliases for surface forms NLM itself
      // lacks (e.g. "Cardiothoracic Surgery" → D013903). Merged into `byForm`
      // below, after descriptor names + entry terms. Invalidation piggybacks
      // on the same MeSH-manifest sha refresh tick as the anchor rows.
      prisma.meshCuratedAlias.findMany({
        select: { alias: true, descriptorUi: true },
      }),
    ]);
    const anchorsByUi = new Map<string, string[]>();
    for (const a of anchors) {
      const arr = anchorsByUi.get(a.descriptorUi);
      if (arr) arr.push(a.parentTopicId);
      else anchorsByUi.set(a.descriptorUi, [a.parentTopicId]);
    }
    const byForm = new Map<string, string[]>();
    const byUi = new Map<string, DescriptorRow>();
    let droppedEntries = 0;
    for (const r of rows) {
      let entryTerms: string[] = [];
      if (Array.isArray(r.entryTerms)) {
        const raw = r.entryTerms as unknown[];
        entryTerms = raw.filter((x): x is string => typeof x === "string");
        droppedEntries += raw.length - entryTerms.length;
      }
      // §5.4.2 — defensive parse for tree numbers, mirroring entryTerms. JSON
      // column contract is `string[]`; non-string members would surface as a
      // data anomaly. Empty array (column absent / [] in source) is captured
      // separately by `emptyTreeNumberCount` below.
      let treeNumbers: string[] = [];
      if (Array.isArray(r.treeNumbers)) {
        const raw = r.treeNumbers as unknown[];
        treeNumbers = raw.filter((x): x is string => typeof x === "string" && x.length > 0);
      }
      byUi.set(r.descriptorUi, {
        descriptorUi: r.descriptorUi,
        name: r.name,
        entryTerms,
        scopeNote: r.scopeNote,
        dateRevised: r.dateRevised,
        localPubCoverage: r.localPubCoverage,
        treeNumbers,
      });
      const forms = [r.name, ...entryTerms];
      for (const f of forms) {
        const key = normalizeForMatch(f);
        if (!key) continue;
        const arr = byForm.get(key);
        if (arr) {
          if (!arr.includes(r.descriptorUi)) arr.push(r.descriptorUi);
        } else {
          byForm.set(key, [r.descriptorUi]);
        }
      }
    }
    if (droppedEntries > 0) {
      // ETL contract violation: entry_terms JSON contained non-string members.
      // Surface loudly so silent data loss is observable.
      console.warn(
        JSON.stringify({
          event: "mesh_map_load_warning",
          reason: "non_string_entry_terms",
          droppedEntries,
        }),
      );
    }

    // ── #642 curated-alias merge ──────────────────────────────────────────
    // Merge aliases AFTER descriptors so a real NLM surface form always wins
    // — an alias only fills a gap, it never overrides a name/entry-term. An
    // alias whose descriptor was dropped by a MeSH full-replace is skipped
    // (inert), mirroring the anchor table's stale-UI behavior. A resolved
    // alias surfaces as confidence "entry-term" (its key != the descriptor
    // name), exactly as issue #642 specifies — no change to the resolve path.
    let aliasStaleUi = 0;
    for (const a of aliases) {
      const key = normalizeForMatch(a.alias);
      if (!key || byForm.has(key)) continue;
      if (!byUi.has(a.descriptorUi)) {
        aliasStaleUi += 1;
        continue;
      }
      byForm.set(key, [a.descriptorUi]);
    }
    if (aliasStaleUi > 0) {
      console.warn(
        JSON.stringify({
          event: "mesh_map_load_warning",
          reason: "alias_stale_ui",
          aliasStaleUi,
        }),
      );
    }

    // ── §5.4.2 prefix-index build ─────────────────────────────────────────
    // Flatten (tn, ui) pairs across every descriptor, sort lex ascending by tn.
    // Parallel arrays (not array-of-objects) to keep the index compact.
    const flat: Array<{ tn: string; ui: string }> = [];
    let emptyTreeNumberCount = 0;
    for (const r of byUi.values()) {
      if (r.treeNumbers.length === 0) {
        emptyTreeNumberCount += 1;
        continue;
      }
      for (const tn of r.treeNumbers) {
        flat.push({ tn, ui: r.descriptorUi });
      }
    }
    flat.sort((a, b) => {
      if (a.tn < b.tn) return -1;
      if (a.tn > b.tn) return 1;
      // Secondary tiebreak by ui for deterministic order across reloads,
      // independent of any sort-stability assumption.
      return a.ui.localeCompare(b.ui);
    });
    const tns: string[] = new Array(flat.length);
    const uis: string[] = new Array(flat.length);
    for (let i = 0; i < flat.length; i++) {
      tns[i] = flat[i].tn;
      uis[i] = flat[i].ui;
    }
    const treePrefixIndex = { tns, uis };

    // ── §5.4.2 descendant precompute pass ────────────────────────────────
    // One pass over every descriptor; populates descendantsByUi by calling
    // the unified read-path helper (which inserts on miss). Same code path
    // the lazy fallback uses.
    const descendantsByUi = new Map<string, string[]>();
    const mapInProgress: Pick<
      MeshMap,
      "byUi" | "descendantsByUi" | "treePrefixIndex"
    > = { byUi, descendantsByUi, treePrefixIndex };
    for (const ui of byUi.keys()) {
      getOrComputeDescendants(mapInProgress, ui);
    }

    if (emptyTreeNumberCount > 0) {
      // Data anomaly — every descriptor SHOULD have ≥ 1 tree number per the
      // NLM contract. One aggregate line per cache load, not per-descriptor,
      // to keep log volume bounded; mirrors the `droppedEntries` warn pattern.
      console.warn(
        JSON.stringify({
          event: "mesh_map_load_warning",
          reason: "empty_tree_numbers",
          descriptorsAffected: emptyTreeNumberCount,
        }),
      );
    }

    const map: MeshMap = {
      byForm,
      byUi,
      anchorsByUi,
      descendantsByUi,
      treePrefixIndex,
      manifestSha256,
      loadedAt: Date.now(),
    };
    meshMapCache = map;
    meshMapInFlight = null;
    return map;
  })();
  return meshMapInFlight;
}

type RankedDescriptorCandidate = {
  row: DescriptorRow;
  confidence: "exact" | "entry-term";
  matchedForm: string;
};

/**
 * #259 / #878 — rank the descriptor candidates for an already-normalized query
 * key against the in-memory MeSH map. Shared by `resolveMeshDescriptor` (which
 * takes the winner) and `suggestMeshConcepts` (which lists them), so the two
 * never drift on the §1.5 tiebreak.
 *
 * matchedForm note: when multiple entry terms on the same descriptor normalize
 * to the same key, array order wins — both point to the same descriptor; only
 * the display string differs. The `?? r.name` fallback is unreachable under the
 * ETL contract.
 *
 * Tiebreak: exact-name > entry-term, then anchor-exists > none (§1.4), then
 * higher `localPubCoverage` (NULL last, §1.7), then `dateRevised` desc, then
 * descriptorUi asc. Returns `[]` when the key resolves to nothing.
 */
function rankedDescriptorCandidates(
  map: MeshMap,
  normalized: string,
): RankedDescriptorCandidate[] {
  const hits = map.byForm.get(normalized);
  if (!hits || hits.length === 0) return [];

  const candidates: RankedDescriptorCandidate[] = hits
    .map((ui) => map.byUi.get(ui))
    .filter((r): r is DescriptorRow => r !== undefined)
    .map((r) => {
      const isExactName = normalizeForMatch(r.name) === normalized;
      return {
        row: r,
        confidence: isExactName ? ("exact" as const) : ("entry-term" as const),
        matchedForm: isExactName
          ? r.name
          : r.entryTerms.find((t) => normalizeForMatch(t) === normalized) ?? r.name,
      };
    });

  candidates.sort((a, b) => {
    if (a.confidence !== b.confidence) {
      return a.confidence === "exact" ? -1 : 1;
    }
    // §1.4 — anchor exists wins over no anchor. When both sides agree on
    // the boolean (both have, or both don't), this returns 0 and we fall
    // through to the dateRevised tiebreaker.
    const aHasAnchor = (map.anchorsByUi.get(a.row.descriptorUi)?.length ?? 0) > 0;
    const bHasAnchor = (map.anchorsByUi.get(b.row.descriptorUi)?.length ?? 0) > 0;
    if (aHasAnchor !== bHasAnchor) return aHasAnchor ? -1 : 1;
    // §1.7 — higher localPubCoverage wins. Coverage is in [0, 1]; NULL is
    // mapped to -1 so any populated value beats a not-yet-computed row.
    // Fully-NULL column (post-MeSH-refresh, pre-coverage-ETL) falls through
    // to dateRevised, preserving pre-§1.7 ordering.
    const aCov = a.row.localPubCoverage ?? -1;
    const bCov = b.row.localPubCoverage ?? -1;
    if (aCov !== bCov) return bCov - aCov;
    const ad = a.row.dateRevised?.getTime() ?? 0;
    const bd = b.row.dateRevised?.getTime() ?? 0;
    if (ad !== bd) return bd - ad;
    return a.row.descriptorUi.localeCompare(b.row.descriptorUi);
  });

  return candidates;
}

/**
 * Resolve a free-text query to a single MeSH descriptor, or null.
 *
 * Algorithm (§1.5):
 *   1. Normalize query (lowercase, strip non-alphanumeric) — same as
 *      curated-callout matching above so "Cardio-Oncology" ↔ "cardio oncology"
 *      ↔ "cardiooncology" all collapse.
 *   2. Lookup against an in-memory map of (normalized name | normalized
 *      entry-term) → descriptorUi[].
 *   3. Per candidate: exact-name confidence iff query == normalized(name);
 *      otherwise entry-term.
 *   4. Tiebreak: exact > entry-term, then anchor-exists > no-anchor (§1.4),
 *      then higher localPubCoverage (§1.7; NULL sorts last), then
 *      dateRevised desc, then descriptorUi asc.
 *
 * Fails closed: any prisma error from the cache load is logged and `null` is
 * returned, so the curated-callout path keeps working.
 */
export async function resolveMeshDescriptor(
  query: string,
): Promise<MeshResolution | null> {
  const normalized = normalizeForMatch(query);
  if (normalized.length < MIN_QUERY_LEN) return null;
  let map: MeshMap;
  try {
    map = await getMeshMap();
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "mesh_map_load_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
  const candidates = rankedDescriptorCandidates(map, normalized);
  if (candidates.length === 0) {
    // The whole query matched nothing. When the fallback flag is on, retry against
    // the query's contiguous word-windows (decompose-and-resolve). Off ⇒ null, exactly
    // as before.
    return resolveMeshResolutionFallbackEnabled()
      ? resolveByWindowFallback(map, query)
      : null;
  }

  const winner = candidates[0];
  return buildMeshResolution(map, winner, {
    matchedForm: winner.matchedForm,
    confidence: winner.confidence,
    // #726 — more than one candidate descriptor normalized to this query key.
    ambiguous: candidates.length > 1,
  });
}

/** Assemble a `MeshResolution` from a ranked candidate, with overridable
 *  confidence/matchedForm/ambiguous (the fallback stamps `partial`). */
function buildMeshResolution(
  map: MeshMap,
  cand: { row: DescriptorRow },
  o: { matchedForm: string; confidence: MeshResolution["confidence"]; ambiguous: boolean },
): MeshResolution {
  return {
    descriptorUi: cand.row.descriptorUi,
    name: cand.row.name,
    matchedForm: o.matchedForm,
    confidence: o.confidence,
    scopeNote: cand.row.scopeNote,
    entryTerms: cand.row.entryTerms,
    curatedTopicAnchors: map.anchorsByUi.get(cand.row.descriptorUi) ?? [],
    // §5.4.2 — Invariant: descendantUis[0] === descriptorUi.
    descendantUis: getOrComputeDescendants(map, cand.row.descriptorUi),
    ambiguous: o.ambiguous,
  };
}

/**
 * Decompose-and-resolve fallback (`SEARCH_MESH_RESOLUTION_FALLBACK`). Tokenize the
 * query and try its contiguous word-windows against the SAME `byForm` index,
 * LONGEST window first (most specific), left-to-right within a length. The first
 * qualifying window wins; its descriptor is returned at `partial` confidence.
 *
 * Guardrails make a guess safe:
 *   - A SINGLE-token window resolves ONLY on an exact descriptor-NAME match and ≥5
 *     chars — so a short/common word can't latch onto a homonym or generic
 *     descriptor (the measured "Seahorse → Smegmamorpha", "Patient → Patients",
 *     "Calcium → Calcium" traps). Multi-token windows accept name OR entry-term.
 *   - `ambiguous` is set when ≥2 windows of the winning length resolve to DIFFERENT
 *     descriptors (the #726 floor then treats the admission conservatively).
 */
function resolveByWindowFallback(map: MeshMap, query: string): MeshResolution | null {
  const tokens = query
    .toLowerCase()
    .replace(/\band\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.length < 2) return null; // a 1-token query already went through the exact path

  for (let size = tokens.length; size >= 1; size--) {
    // All resolving windows at this length, left-to-right.
    const hits: Array<{ row: DescriptorRow; matchedForm: string }> = [];
    for (let i = 0; i + size <= tokens.length; i++) {
      const surface = tokens.slice(i, i + size).join(" ");
      const key = normalizeForMatch(surface);
      if (key.length < (size === 1 ? 5 : 3)) continue;
      const cands = rankedDescriptorCandidates(map, key);
      if (cands.length === 0) continue;
      const top = cands[0];
      // Single-token windows: exact descriptor-NAME match only.
      if (size === 1 && top.confidence !== "exact") continue;
      hits.push({ row: top.row, matchedForm: surface });
    }
    if (hits.length === 0) continue;
    const distinctUis = new Set(hits.map((h) => h.row.descriptorUi));
    const winner = hits[0]; // leftmost at the longest matching length
    return buildMeshResolution(
      map,
      { row: winner.row },
      { matchedForm: winner.matchedForm, confidence: "partial", ambiguous: distinctUis.size > 1 },
    );
  }
  return null;
}

/**
 * #878 — a resolved MeSH-concept autocomplete candidate. Carries the descriptor
 * UI + canonical name plus how the typed query matched (`exact` name vs an
 * `entry-term`/alias synonym, and the verbatim `matchedForm` for the subtitle).
 */
export type MeshConceptCandidate = {
  descriptorUi: string;
  name: string;
  confidence: "exact" | "entry-term";
  matchedForm: string;
};

/**
 * #878 — MeSH-concept autocomplete candidates. Returns `[]` UNLESS
 * `SEARCH_SUGGEST_MESH_CONCEPT=on`, so when off this contributes NOTHING — no
 * candidates, no `"concept"` plausibility hit, no badge.
 *
 * Exact-form resolution: the trimmed query, normalized, is looked up against
 * the SAME `byForm` index `resolveMeshDescriptor` uses (descriptor names + NLM
 * entry terms + #642 curated aliases), so `flow cytometry` and the acronym
 * `FACS` both resolve to D005434. Reuses the module-cached MeSH map, so the
 * warm path is an O(1) map lookup with no extra DB work; fails closed (`[]`) on
 * a cold/failed load so the `allSettled` dropdown contributes zero rows rather
 * than blocking or 500-ing. Candidates ride the shared §1.5 tiebreak and are
 * deduped by descriptorUi (a normalized key usually resolves to a single
 * concept; collisions are capped at `fetchN`).
 */
export async function suggestMeshConcepts(
  trimmed: string,
  fetchN: number,
): Promise<MeshConceptCandidate[]> {
  if (!resolveSearchSuggestMeshConcept()) return [];
  const normalized = normalizeForMatch(trimmed);
  if (normalized.length < MIN_QUERY_LEN) return [];
  let map: MeshMap;
  try {
    map = await getMeshMap();
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "mesh_map_load_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return [];
  }

  const seen = new Set<string>();
  const out: MeshConceptCandidate[] = [];
  for (const c of rankedDescriptorCandidates(map, normalized)) {
    if (seen.has(c.row.descriptorUi)) continue;
    seen.add(c.row.descriptorUi);
    out.push({
      descriptorUi: c.row.descriptorUi,
      name: c.row.name,
      confidence: c.confidence,
      matchedForm: c.matchedForm,
    });
    if (out.length >= fetchN) break;
  }
  return out;
}

/**
 * Issue #688 — resolve descriptor UIs to their display names via the in-memory
 * MeSH map. Used by the People-search match-provenance path to turn a scholar's
 * matched descendant UIs into human-readable narrower terms. Returns a Map
 * keyed only by the UIs that resolved (unknown UIs omitted). Fails closed (empty
 * map) on a map-load error, mirroring `resolveMeshDescriptor`.
 */
export async function descriptorLabelsForUis(
  uis: string[],
): Promise<Map<string, string>> {
  if (uis.length === 0) return new Map();
  let map: MeshMap;
  try {
    map = await getMeshMap();
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "mesh_map_load_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return new Map();
  }
  const out = new Map<string, string>();
  for (const ui of uis) {
    const row = map.byUi.get(ui);
    if (row) out.set(ui, row.name);
  }
  return out;
}

/** @internal — test-only hook. Resets the module-level MeSH cache. */
export function _resetMeshMapForTests(): void {
  meshMapCache = null;
  meshMapInFlight = null;
}

/** @internal — test-only hook for the §5.4.2 lazy-compute path. Removes
 *  either a single descriptor's descendant entry, or all entries when called
 *  without an argument. Not used in production code paths. */
export function _clearDescendantsForTests(ui?: string): void {
  if (!meshMapCache) return;
  if (ui) meshMapCache.descendantsByUi.delete(ui);
  else meshMapCache.descendantsByUi.clear();
}
