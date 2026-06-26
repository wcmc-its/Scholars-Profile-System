/**
 * Self-edit v1 #356 Phase 4b — single-doc builders for the OpenSearch index.
 *
 * Owns the People + Publications document shapes and the Prisma `where` /
 * `select` / `include` constants those shapes depend on. Both the batch
 * indexer (`etl/search-index/index.ts`) and the fast-path
 * (`lib/edit/search-suppression.ts`, arriving in C5) consume these — so a
 * one-doc fast-path re-index is byte-identical to a nightly rebuild of that
 * doc.
 *
 * - The Prisma fetch shape MUST come from the exported constants. A bespoke
 *   `include` / `select` in either caller silently diverges the produced
 *   doc; the builders accept only `Prisma.*GetPayload<{ ... typeof <const> }>`
 *   rows, so include-drift fails to typecheck rather than running.
 * - This module has no `main()` and no module-init side effect — safe to
 *   import from `lib/` and exercise under vitest without hitting the
 *   `if (!process.env.VITEST)` guard in the indexer.
 *
 * Phase 4b C2 (this commit) is **pure relocation** — every helper, weight,
 * constant, and builder is moved verbatim from `etl/search-index/index.ts`.
 * No suppression filtering yet (added in C3 / C4).
 */
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";

import {
  isAuthorHidden,
  isPublicationDark,
  type PublicationSuppressions,
} from "@/lib/api/manual-layer";
// Issue #824 §4c — the public method-family rollup is gated through the SAME
// #800/#801 overlay every public Method surface uses. `isFamilyPubliclyVisible`
// is a pure predicate (no DB / no module side effect), and `methods-overlay`
// only imports `lib/db` + `methods-lens-flags` — neither imports this module —
// so the value import introduces no import cycle. `FamilyOverlayGate` is a
// type-only import.
import { isFamilyPubliclyVisible } from "@/lib/api/methods-overlay";
import type { FamilyOverlayGate } from "@/lib/api/methods-overlay";
import { isFundingActive } from "@/lib/api/search-funding";
import { extractMeshDescriptorUis } from "@/lib/mesh-descriptor-uis";
import {
  buildMeshAncestorIndex,
  ancestorUisFor,
  type MeshAncestorIndex,
} from "@/lib/mesh-tree-ancestors";
import { extractLastNameSort } from "@/lib/name-sort";
import { isCenterMembershipActive } from "@/lib/api/centers";
import { isTrainingOnlyGrant } from "@/lib/grants/training-exclusions";
import { NEVER_DISPLAY_TYPES } from "@/lib/publication-types";

// ---------------------------------------------------------------------------
// Authorship weights — publications-doc index-time term repetition.
// ---------------------------------------------------------------------------

export const AUTHORSHIP_WEIGHTS = {
  firstOrLast: 10,
  secondOrPenultimate: 4,
  middle: 1,
} as const;

export type AuthorshipKind = keyof typeof AUTHORSHIP_WEIGHTS;

export function classifyAuthorship(a: {
  isFirst: boolean;
  isLast: boolean;
  isPenultimate: boolean;
}): AuthorshipKind {
  if (a.isFirst || a.isLast) return "firstOrLast";
  if (a.isPenultimate) return "secondOrPenultimate";
  return "middle";
}

// ---------------------------------------------------------------------------
// Pure helpers — MeSH extraction.
// ---------------------------------------------------------------------------

/**
 * Normalize the `Publication.meshTerms` JSON column into a flat list of
 * descriptor labels suitable for indexing.
 *
 * The column has historically held two shapes: bare strings (older rows)
 * and `{ ui, label }` objects emitted by the current MeSH descriptor ETL.
 * Earlier indexer code filtered to `typeof x === "string"`, which silently
 * dropped every object-shaped term — leaving every doc with an empty
 * `meshTerms` field in OpenSearch and breaking the #259 §1.6 OR-of-evidence
 * concept query (every `match_phrase: meshTerms` returned 0).
 *
 * Accepts both shapes so a partial migration on the source side doesn't
 * silently lose terms. Non-string `label` values, empty strings, and
 * malformed rows are dropped.
 */
export function extractMeshLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.length > 0) out.push(item);
    } else if (item && typeof item === "object" && "label" in item) {
      const label = (item as { label: unknown }).label;
      if (typeof label === "string" && label.length > 0) out.push(label);
    }
  }
  return out;
}

// `extractMeshDescriptorUis` — the shared MeSH-UI choke point — now lives in
// its own dependency-free module (`@/lib/mesh-descriptor-uis`) so the funding
// ETL projection can reuse it without importing this file (which pulls in
// search-runtime deps). Re-exported here so existing `@/lib/search-index-docs`
// importers and the snapshot test keep resolving it unchanged.
export { extractMeshDescriptorUis };

/**
 * Like {@link extractMeshLabels} but keeps the descriptor `ui` paired with each
 * label, for the people-doc `topMeshTerms` rollup whose chips deep-link to a
 * scholar's pubs pre-filtered by `?mesh=<ui>`. Selects labels by the SAME rule
 * as `extractMeshLabels` (so `.map(p => p.label)` is identical), and carries the
 * `{ ui, label }` object shape from `lib/api/profile.ts`'s `normalizeMeshTerms`.
 * `ui` is null for a bare-string row or an object missing a valid `ui`.
 */
export function extractMeshTermPairs(raw: unknown): Array<{ ui: string | null; label: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ ui: string | null; label: string }> = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.length > 0) out.push({ ui: null, label: item });
    } else if (item && typeof item === "object" && "label" in item) {
      const label = (item as { label: unknown }).label;
      if (typeof label === "string" && label.length > 0) {
        const uiRaw = (item as { ui?: unknown }).ui;
        const ui = typeof uiRaw === "string" && uiRaw.length > 0 ? uiRaw : null;
        out.push({ ui, label });
      }
    }
  }
  return out;
}

/** Cap on the people-doc `topMeshTerms` rollup (CONTRACT A — top 8 descriptors). */
export const TOP_MESH_TERMS_LIMIT = 8;

/**
 * D-exact (search reason-from-doc) — the MeSH ancestor context `buildPeopleDoc`
 * needs to precompute `meshSubtreeCounts`. Carries the tree-number→UI ancestor
 * index PLUS each descriptor's own tree numbers (so a pub's tagged descriptor can
 * be expanded to its ancestor concepts). Loaded ONCE per index build by the ETL
 * (mirroring the `gate` load) and passed to every `buildPeopleDoc`. When OMITTED,
 * the builder never touches it and emits no `meshSubtreeCounts` field — so the
 * produced doc is byte-identical to today for any caller that doesn't pass it.
 */
export type MeshAncestorContext = {
  index: MeshAncestorIndex;
  treeNumbersByUi: Map<string, string[]>;
};

/**
 * Load the {@link MeshAncestorContext} from `mesh_descriptor.tree_numbers` — the
 * SAME column `lib/api/search-taxonomy.ts` reads for the downward descendant walk.
 * One whole-table read per index build; the people index has ~9k docs but only
 * ~30k descriptors, so this is loaded once and shared across every `buildPeopleDoc`.
 */
export async function loadMeshAncestorContext(
  client: Pick<PrismaClient, "meshDescriptor">,
): Promise<MeshAncestorContext> {
  const rows = await client.meshDescriptor.findMany({
    select: { descriptorUi: true, treeNumbers: true },
  });
  const treeNumbersByUi = new Map<string, string[]>();
  const indexRows: Array<{ ui: string; treeNumbers: string[] }> = [];
  for (const r of rows) {
    // `treeNumbers` is a JSON `string[]` column; defensively filter to strings
    // (same contract the resolver applies in search-taxonomy.ts).
    const tns = Array.isArray(r.treeNumbers)
      ? (r.treeNumbers as unknown[]).filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        )
      : [];
    treeNumbersByUi.set(r.descriptorUi, tns);
    indexRows.push({ ui: r.descriptorUi, treeNumbers: tns });
  }
  return { index: buildMeshAncestorIndex(indexRows), treeNumbersByUi };
}

/**
 * Reduce a per-label aggregate ({ count, ui }) map into the ordered
 * `topMeshTerms` array carried on the people doc: the scholar's most frequent
 * MeSH descriptors (each with its `ui`, for deep-linking) across their
 * accepted/visible publications.
 *
 * Counting semantics match `lib/api/profile.ts`'s `aggregateKeywords` rollup —
 * each label is counted once per distinct publication it appears on (the caller
 * dedupes within a pub before incrementing). Ordering is count DESC then label
 * ASC (locale-aware, same tiebreak as `aggregateKeywords`); the result is
 * truncated to `TOP_MESH_TERMS_LIMIT`. An empty map yields `[]`, which the
 * builder spreads as an OMIT (no field) — mirroring `publicationMeshUi`.
 *
 * Pure: same map → same array. Exported for unit testing without a DB.
 */
export function topMeshTermsFromCounts(
  counts: ReadonlyMap<string, { count: number; ui: string | null }>,
): Array<{ ui: string | null; label: string }> {
  return Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1].count !== a[1].count) return b[1].count - a[1].count;
      return a[0].localeCompare(b[0]);
    })
    .slice(0, TOP_MESH_TERMS_LIMIT)
    .map(([label, agg]) => ({ ui: agg.ui, label }));
}

// ---------------------------------------------------------------------------
// Pure helpers — name slices for the OpenSearch completion suggester.
// ---------------------------------------------------------------------------

/**
 * Build trailing-token slices of a name so the OpenSearch completion
 * suggester resolves arbitrary middle-token prefixes. For "M. Cary Reid"
 * returns ["Cary Reid", "Reid"] — these get added as suggestion inputs
 * alongside the canonical full name, so typing "Cary" or "Reid" matches.
 *
 * Drops trailing generational suffixes ("Jr", "Sr", "II", "III", "IV") so
 * "Smith Jr" still surfaces a "Smith" slice. Empty for single-token names.
 */
export function trailingNameSlices(name: string): string[] {
  if (!name) return [];
  const raw = name.trim().split(/\s+/).filter(Boolean);
  if (raw.length <= 1) return [];
  const SUFFIXES = /^(Jr|Sr|I{1,3}|IV|V|VI{0,3}|Esq)\.?,?$/i;
  // Drop trailing suffix tokens so the "last name" slice anchors on the
  // surname, not "Jr".
  let end = raw.length;
  while (end > 1 && SUFFIXES.test(raw[end - 1])) end -= 1;
  const tokens = raw.slice(0, end);
  const slices: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    slices.push(tokens.slice(i).join(" "));
  }
  return slices;
}

// `extractLastNameSort` now lives in `@/lib/name-sort` (single source of truth,
// shared with the center roster sort); imported above and re-exported here so
// existing `from "@/lib/search-index-docs"` consumers keep working.
export { extractLastNameSort };

/**
 * Build a "first + last" slice that drops middle tokens, so users typing
 * "Ronald Crystal" find "Ronald G. Crystal". Returns null for names that
 * don't have at least one middle token, and for names whose first/last is
 * already the full name (avoid duplicating the canonical input).
 */
export function firstLastSlice(name: string): string | null {
  if (!name) return null;
  const raw = name.trim().split(/\s+/).filter(Boolean);
  if (raw.length < 3) return null;
  const SUFFIXES = /^(Jr|Sr|I{1,3}|IV|V|VI{0,3}|Esq)\.?,?$/i;
  let end = raw.length;
  while (end > 1 && SUFFIXES.test(raw[end - 1])) end -= 1;
  const tokens = raw.slice(0, end);
  if (tokens.length < 3) return null;
  return `${tokens[0]} ${tokens[tokens.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Pure helpers — publication-doc enrichment (#259 topic IDs, #316 impact).
// ---------------------------------------------------------------------------

/**
 * Issue #259 §1.6 — derive the deduped `reciterParentTopicId` array for one
 * publication doc from its joined `publicationTopics` rows. The Prisma
 * `distinct: ["parentTopicId"]` clause is the primary dedupe at the query
 * layer; this is a belt-and-braces against any future relaxation. Returns
 * either `{ reciterParentTopicId: [...] }` to be spread into the doc, or
 * `{}` for pubs with zero topic rows so the field is omitted (not stored
 * as `[]`) — see the call site for the `_source`-distinguishability
 * rationale.
 *
 * Exported solely for unit testing.
 */
export function buildReciterParentTopicIdField(
  publicationTopics: ReadonlyArray<{ parentTopicId: string }>,
): { reciterParentTopicId: string[] } | Record<string, never> {
  const ids = Array.from(new Set(publicationTopics.map((pt) => pt.parentTopicId)));
  return ids.length > 0 ? { reciterParentTopicId: ids } : {};
}

/**
 * Issue #259 §1.8 (migrated through #316 PR-B-finalize) — derive the
 * `impactScore` (doc-level, sortable float) and `topicImpacts` (one entry
 * per parent topic, used by the API to compute the "Concept impact" badge
 * value when a MeSH descriptor resolves to anchored curated topics).
 *
 * Both fields source `Publication.impactScore` after the mirror retirement.
 * The previous per-topic MAX-over-cwids derivation operated on the
 * `publication_topic.impact_score` mirror that has since been dropped;
 * every per-topic value was already equal to the global, so `topicImpacts[]`
 * is now `parentTopicIds.map(id => ({ parentTopicId: id, impactScore: <global> }))`
 * — uniform by construction. Kept for OS index schema backwards-compat and
 * the existing conceptImpactScore consumer in lib/api/search.ts:1272 that
 * MAX-over-anchor-matched-entries (with uniform values, MAX equals the
 * single value when anchor set is non-empty).
 *
 * OMIT-on-empty: doc-level `impactScore` is omitted when
 * `publicationImpactScore` is null; `topicImpacts` is omitted when either
 * the publication has no impact score or it has zero parent topics. An
 * all-empty result is `{}`, matching the previous contract for spread-into-doc.
 *
 * `impactScore` is a `number` (JSON float, not Prisma Decimal) so the
 * OpenSearch float mapping accepts it directly. Decimal(8,4) fits well
 * within float precision.
 *
 * Exported solely for unit testing.
 */
export function buildPubImpactFields(
  publicationImpactScore: { toNumber(): number } | number | null,
  publicationTopics: ReadonlyArray<{ parentTopicId: string }>,
): {
  impactScore?: number;
  topicImpacts?: Array<{ parentTopicId: string; impactScore: number }>;
} {
  const result: {
    impactScore?: number;
    topicImpacts?: Array<{ parentTopicId: string; impactScore: number }>;
  } = {};

  // Doc-level: canonical Publication.impactScore. Skip non-finite values
  // defensively in case a schema migration ever introduces NaN-tainted rows.
  if (publicationImpactScore !== null && publicationImpactScore !== undefined) {
    const n =
      typeof publicationImpactScore === "number"
        ? publicationImpactScore
        : publicationImpactScore.toNumber();
    if (Number.isFinite(n)) result.impactScore = n;
  }

  // Per-topic: one entry per distinct parentTopicId, value mirrors doc-level.
  if (result.impactScore !== undefined) {
    const uniqueParents = new Set(publicationTopics.map((pt) => pt.parentTopicId));
    if (uniqueParents.size > 0) {
      const score = result.impactScore;
      result.topicImpacts = Array.from(uniqueParents, (parentTopicId) => ({
        parentTopicId,
        impactScore: score,
      }));
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Prisma fetch shapes — the constants both callers MUST use.
// ---------------------------------------------------------------------------

export const PUBLICATION_INDEX_WHERE = {
  // Issue #63 — never index Retraction notices or Errata. Filtering at the
  // query layer keeps `_id`-by-pmid lookups from a retracted paper from ever
  // resolving in the index.
  publicationType: { notIn: [...NEVER_DISPLAY_TYPES] },
} satisfies Prisma.PublicationWhereInput;

export const PUBLICATION_INDEX_INCLUDE = {
  authors: {
    orderBy: { position: "asc" },
    include: {
      scholar: {
        select: {
          cwid: true,
          slug: true,
          preferredName: true,
          deletedAt: true,
          status: true,
          // #718 — needed by the alumni keep-rule: a pub authored by an
          // `affiliate_alumni` is retained even though that author is hidden
          // (soft-deleted) and so contributes no displayable chip.
          roleCategory: true,
          // #837 — per-author department, used to build the publications-tab
          // Department facet (`wcmAuthorDepartments`). The FK `deptCode` is the
          // stable facet key (same convention as the People-tab bare-dept key);
          // `department.name` is the long-tail free-text fallback for scholars
          // without an FK-resolved code (`name:<deptName>`), mirroring
          // `buildPeopleDoc`'s `deptDivKeys`. Only consumed under
          // `SEARCH_PUB_DEPARTMENT_FILTER`; emitted unconditionally (omit-on-
          // empty), so a reindex populates the field for the eventual flip.
          deptCode: true,
          primaryDepartment: true,
          department: { select: { name: true } },
        },
      },
    },
  },
  // Issue #259 §1.6 — ReciterAI parent-topic IDs feed both the OR-of-evidence
  // pub filter and the post-#316 PR-B-finalize `topicImpacts[]` derivation
  // (impactScore comes from Publication directly, see buildPubImpactFields).
  // `buildReciterParentTopicIdField` does its own Set-based dedup;
  // `buildPubImpactFields` dedups by parentTopicId too, so the query doesn't
  // need `distinct`.
  publicationTopics: { select: { parentTopicId: true } },
} satisfies Prisma.PublicationInclude;

export type PublicationForIndex = Prisma.PublicationGetPayload<{
  include: typeof PUBLICATION_INDEX_INCLUDE;
}>;

export const PEOPLE_INDEX_WHERE = {
  // Suppressed scholars (status !== 'active') are excluded at the query layer
  // — Phase 4b's build-time half is publication-suppression only (the spike's
  // reassuring scoping finding); scholar suppression is already correct here.
  deletedAt: null,
  status: "active",
} satisfies Prisma.ScholarWhereInput;

export const PEOPLE_INDEX_SELECT = {
  cwid: true,
  slug: true,
  preferredName: true,
  fullName: true,
  postnominal: true,
  primaryTitle: true,
  primaryDepartment: true,
  overview: true,
  // Phase 2 — replaces the Phase-1 hard-coded "Faculty" placeholder.
  // Sourced from ED ETL deriveRoleCategory (see etl/ed/index.ts).
  roleCategory: true,
  // Issue #8 item 4 — combined "Department / division" facet:
  // pull the FK-resolved names so we can render "Cardiology — Medicine"
  // bucket labels and "Cardiology · Department of Medicine" person rows
  // without an extra DB hit at query time.
  deptCode: true,
  divCode: true,
  department: { select: { name: true } },
  division: { select: { name: true } },
  topicAssignments: { orderBy: { score: "desc" } },
  // Exclude source='RePORTER' — the person-doc grantCount + active-grant signals
  // count WCM-administered awards only, not individual prior-institution history.
  grants: { where: { source: { not: "RePORTER" } } },
  authorships: {
    // Issue #63 — drop Retraction / Erratum so retracted-paper titles
    // and MeSH don't pull a person into search results for unrelated
    // queries. Filtering on the related publication keeps the rollup
    // shape unchanged for everything else.
    where: {
      isConfirmed: true,
      publication: { publicationType: { notIn: [...NEVER_DISPLAY_TYPES] } },
    },
    include: {
      publication: {
        // Issue #21 — `abstract` joins via the existing publication FK;
        // we de-dup at the field level (one copy per pmid) rather than
        // repeating by authorship position the way titles/mesh do.
        select: { title: true, meshTerms: true, abstract: true },
      },
    },
  },
} satisfies Prisma.ScholarSelect;

export type ScholarForIndex = Prisma.ScholarGetPayload<{
  select: typeof PEOPLE_INDEX_SELECT;
}>;

// ---------------------------------------------------------------------------
// Document builders.
// ---------------------------------------------------------------------------

/**
 * #718 — when enabled, the publications index excludes any publication whose
 * displayable WCM author set is empty: its only WCM author(s) are soft-deleted
 * hidden identity classes (overwhelmingly doctoral students under #536) or are
 * fully suppressed. Such a row renders with no attributable WCM author, and for
 * trainees it often reflects pre-WCM work that was never WCM output. Default
 * OFF, so merging is inert — an operator sets `SEARCH_REQUIRE_DISPLAYABLE_AUTHOR`
 * in the search-index ETL env (and the app env, for the live suppression
 * reconciler) and reindexes (the reindex-then-flip pattern). Reversible by
 * clearing the flag and reindexing.
 */
export function isRequireDisplayableAuthorEnabled(): boolean {
  return process.env.SEARCH_REQUIRE_DISPLAYABLE_AUTHOR === "on";
}

/**
 * Build the OpenSearch publication `_source` for `p`. Pure — given the row
 * and the loaded suppression set, the output is deterministic.
 *
 * Returns `null` when the publication is dark — an explicit whole-pub
 * takedown OR derived-dark (every confirmed, site-visible WCM author has
 * a per-author hide), per ADR-005 / `self-edit-spec.md` audit query B. The
 * caller skips emitting a `null` doc; on a from-scratch rebuild
 * (`ensureIndex` drops + recreates) the dark pmid simply never enters the
 * index. The caller wraps non-null as
 * `{ pmid: p.pmid, doc: buildPublicationDoc(p, sup) }` for the bulk action;
 * `_id` is set by the caller.
 *
 * Phase 4b C3 — the publication-suppression integration is here:
 *   - drops per-author-hidden cwids from `wcmAuthorRows` (chips / facets);
 *   - returns `null` for dark pmids (whole-pub or derived-dark).
 */
export function buildPublicationDoc(
  p: PublicationForIndex,
  sup: PublicationSuppressions,
  opts: { requireDisplayableAuthor?: boolean } = {},
): Record<string, unknown> | null {
  // Derived-dark gate (ADR-005 / self-edit-spec.md audit query B).
  //
  // `confirmedWcmCwids` is the publication's confirmed, site-visible WCM
  // author set — `isConfirmed`-filtered. It is DELIBERATELY different from
  // `wcmAuthorRows` below, which keeps its existing non-`isConfirmed`
  // membership: the rendered chips / facets have always carried WCM authors
  // regardless of authorship-confirmation state, and 4b is additive (the
  // spike §4 Additivity principle — existing filters stay; suppression is
  // layered on). The dark-gate contract is over CONFIRMED-WCM authors only;
  // the chip contract is broader. The two sets are not the same set.
  const confirmedWcmCwids = p.authors
    .filter(
      (a) =>
        a.isConfirmed &&
        a.scholar &&
        !a.scholar.deletedAt &&
        a.scholar.status === "active",
    )
    .map((a) => a.scholar!.cwid);
  if (isPublicationDark(sup, p.pmid, confirmedWcmCwids)) return null;

  const authorNames = p.authors
    .map((a) => a.externalName ?? a.scholar?.preferredName ?? "")
    .filter(Boolean)
    .join(", ");

  const wcmAuthorRows = p.authors.filter(
    (a) =>
      a.scholar &&
      !a.scholar.deletedAt &&
      a.scholar.status === "active" &&
      !isAuthorHidden(sup, p.pmid, a.scholar.cwid),
  );
  const wcmAuthors = wcmAuthorRows.map((a) => ({
    cwid: a.scholar!.cwid,
    slug: a.scholar!.slug,
    preferredName: a.scholar!.preferredName,
    position: a.position,
  }));

  // #718 — exclude the publication when no WCM author is publicly displayable
  // (every WCM author is soft-deleted/hidden — e.g. a doctoral student under
  // #536 — or suppressed). `wcmAuthorRows`/`wcmAuthors` is exactly the rendered
  // chip set, so an empty list is precisely the "author-less row" condition.
  // The derived-dark gate above (isPublicationDark) only fires when the
  // CONFIRMED set is fully hidden; it returns false for an EMPTY confirmed set,
  // so this is the distinct zero-displayable-author case. Flag-gated, default off.
  //
  // Alumni exception: an `affiliate_alumni` author is a legitimate (former) WCM
  // person whose work is real WCM output, unlike a current trainee. Alumni are a
  // hidden class (soft-deleted, no chip), so they never appear in `wcmAuthors`;
  // keep the pub anyway when one authored it — it renders via the unstructured
  // byline fallback (#775), name as plain text, no link.
  if (opts.requireDisplayableAuthor && wcmAuthors.length === 0) {
    const hasAlumniAuthor = p.authors.some(
      (a) => a.scholar?.roleCategory === "affiliate_alumni",
    );
    if (!hasAlumniAuthor) return null;
  }

  // WCM author position roles (issue #8 follow-up). For each WCM author
  // on the paper, classify their position into {first, senior, middle}
  // and union the results so a paper with one WCM first-author and one
  // WCM middle-author shows up under both filters. Single-author papers
  // count as both first AND senior — matches CV / promotion-committee
  // convention (sole authorship = highest possible authorship signal).
  const wcmAuthorPositions = new Set<string>();
  for (const a of wcmAuthorRows) {
    if (a.totalAuthors === 1) {
      wcmAuthorPositions.add("first");
      wcmAuthorPositions.add("senior");
      continue;
    }
    if (a.isFirst) wcmAuthorPositions.add("first");
    if (a.isLast) wcmAuthorPositions.add("senior");
    if (!a.isFirst && !a.isLast) wcmAuthorPositions.add("middle");
  }

  // #837 — union of the departments of this pub's displayable WCM authors.
  // A paper appears under EVERY department any of its WCM authors belongs to
  // (multiple co-authors in different departments → multiple keys), so a
  // single `terms` aggregation/filter on this keyword array OR's within the
  // axis cleanly — the same denormalized-keyword pattern as
  // `wcmAuthorCwids` / `wcmAuthorPositions`. Keys mirror `buildPeopleDoc`'s
  // dept facet: the FK `deptCode` when present, else a `name:<deptName>`
  // long-tail key for scholars without an FK-resolved code, so the existing
  // `resolveDeptDivLabels()` map renders bucket labels with no new lookup.
  // Derived from `wcmAuthorRows` (the rendered chip set), so a suppressed /
  // hidden author never contributes a department. Default empty → field
  // omitted (omit-on-empty), so `_source` consumers distinguish "no signal"
  // from "[]" and the index size is unchanged for pubs with no WCM dept.
  const wcmAuthorDepartments = new Set<string>();
  for (const a of wcmAuthorRows) {
    if (a.scholar!.deptCode) {
      wcmAuthorDepartments.add(a.scholar!.deptCode);
    } else {
      const deptName = a.scholar!.department?.name ?? a.scholar!.primaryDepartment;
      if (deptName) wcmAuthorDepartments.add(`name:${deptName}`);
    }
  }

  const mesh = extractMeshLabels(p.meshTerms);
  const meshUis = extractMeshDescriptorUis(p.meshTerms);

  // Issue #259 §1.6 — ReciterAI parent-topic IDs. `parentTopicId` is
  // non-nullable on PublicationTopic (it's part of the composite PK
  // `[pmid, cwid, parentTopicId]` per prisma/schema.prisma:744), so no
  // null filter is needed. The helper handles dedup + omit-on-empty.
  const reciterParentTopicIdField = buildReciterParentTopicIdField(
    p.publicationTopics,
  );

  // Issue #259 §1.8 (consumer-migrated in #316 PR-B) — doc-level
  // `impactScore` from `Publication.impactScore` and per-topic MAX
  // `topicImpacts` from publication_topic. OMIT-on-empty per field
  // independently; fully empty pubs write neither.
  const pubImpactFields = buildPubImpactFields(p.impactScore, p.publicationTopics);

  return {
    pmid: p.pmid,
    title: p.title,
    journal: p.journal,
    year: p.year,
    publicationType: p.publicationType,
    citationCount: p.citationCount,
    dateAddedToEntrez: p.dateAddedToEntrez,
    doi: p.doi,
    pmcid: p.pmcid,
    pubmedUrl: p.pubmedUrl,
    meshTerms: mesh.join(" "),
    // Issue #259 — OMIT-on-empty: pubs whose mesh_terms yielded no UIs
    // write nothing for this field, mirroring reciterParentTopicId.
    ...(meshUis.length > 0 ? { meshDescriptorUi: meshUis } : {}),
    // Issue #32 — index abstract text on the publications doc so thematic
    // queries (e.g. "psychiatric comorbidities") can match the paper itself,
    // not just the scholar. Empty/missing abstracts are stored as "".
    abstract: p.abstract ?? "",
    authorNames,
    wcmAuthors,
    wcmAuthorPositions: Array.from(wcmAuthorPositions),
    // Issue #88 — flat CWID array for the Author facet aggregation.
    wcmAuthorCwids: wcmAuthors.map((a) => a.cwid),
    // #837 — OMIT-on-empty keyword array of the displayable WCM authors'
    // department keys for the Publications-tab Department facet. Pubs whose
    // WCM authors carry no department write nothing for this field.
    ...(wcmAuthorDepartments.size > 0
      ? { wcmAuthorDepartments: Array.from(wcmAuthorDepartments) }
      : {}),
    // Issue #259 §1.6 — OMIT-on-empty: pubs with zero publication_topic
    // rows write nothing for this field, not an empty array. Lets `_source`
    // consumers distinguish "no signal" from "[]".
    ...reciterParentTopicIdField,
    // Issue #259 §1.8 — same OMIT-on-empty contract for the doc-level
    // impact aggregates.
    ...pubImpactFields,
    // Issue #316 PR-C follow-up — GPT-generated impact justification.
    // OMIT-on-empty: null/blank justifications write nothing.
    ...(typeof p.impactJustification === "string" && p.impactJustification.length > 0
      ? { impactJustification: p.impactJustification }
      : {}),
  };
}

/**
 * Build the OpenSearch people `_source` for `s`. Applies the
 * publication-suppression delta to the scholar's authorship rollup —
 * self-hidden authorships (`isAuthorHidden(sup, pmid, s.cwid)`) and dark
 * pmids (`sup.darkPmids`) are skipped from `publicationTitles` /
 * `publicationMesh` / `publicationAbstracts` (the search-matched content
 * fields), from `publicationCount` and `isComplete` (one filtered count
 * shared between the two), and from `mostRecentPubDate`.
 *
 * No derived-dark check is needed here (people side): if the scholar is a
 * displayed author the pub isn't derived-dark from their authorship; if
 * they hid it the per-author rule already skips. Same reasoning as the
 * 4a plan §4 profile.ts own-list.
 *
 * Four sidecar queries are issued via the same `client` (the complete
 * extra-data surface — `PEOPLE_INDEX_SELECT` alone is not sufficient):
 *
 *   - **`mostRecentPubDate`** (`index.ts:406`-style query) — an inline
 *     N+1; plan §2.2 records why it is NOT consolidated into the
 *     `s.authorships` join (the two queries have different
 *     `publicationType` filters; consolidating would change behavior for
 *     scholars whose latest pub is a retraction).
 *   - **`centerCodes`** — the scholar's `centerMembership` rows
 *     (`index.ts:486`-style fold into `deptDivKey`). The batch indexer
 *     accepts N per-scholar queries here in exchange for the fast-path
 *     getting the one-cwid variant naturally; the prior whole-table
 *     `centerCodesByCwid` preload is dropped.
 *   - **`chairedDepartments`** (issue #532) — `Department` rows where
 *     `chairCwid = s.cwid`. The DB column already reflects ADR-002 chair
 *     detection AND the Path C manual override, so reading it here surfaces
 *     the authoritative chair set with no new ingestion. Usually 0 rows;
 *     occasionally 1; rarely >1 (cross-dept chairs do exist at WCM).
 *   - **`chieffedDivisions`** (issue #532) — same shape for
 *     `Division.chiefCwid`. ADR-002 Path B (`detectDivisionChief`) + Path C
 *     overrides have already settled the value the column carries.
 *
 * Returns `null` when the scholar is not indexable (forward-compat: with
 * current callers the scholar row is always `PEOPLE_INDEX_WHERE`-filtered,
 * so the path is never hit at runtime — but the return type lets a future
 * caller centralize the delete-vs-reindex decision in the builder).
 *
 * Phase 4b C4 — publication-suppression integration on the people side.
 */
export async function buildPeopleDoc(
  s: ScholarForIndex,
  client: Pick<
    PrismaClient,
    | "centerMembership"
    | "divisionMembership"
    | "publicationAuthor"
    | "department"
    | "division"
    | "scholarFamily"
  >,
  sup: PublicationSuppressions,
  // Issue #824 §4c — OPTIONAL public method-family overlay gate. When provided
  // (the ETL + the live reconciler pass it, loaded with `forceSensitive: true`),
  // the builder emits a `methodFamily` rollup of the scholar's overlay-VISIBLE
  // families. When OMITTED — every existing test, and any caller that doesn't
  // want the rollup — the builder NEVER touches `client.scholarFamily` and never
  // emits the field, so the produced doc is byte-identical to today.
  gate?: FamilyOverlayGate,
  // D-exact (search reason-from-doc) — OPTIONAL MeSH ancestor context. When
  // provided (the ETL + live reconciler load it once via `loadMeshAncestorContext`
  // and pass it), the builder emits `meshSubtreeCounts`: per-concept distinct-pub
  // counts the People reason line reads with an O(1) lookup (no publications-index
  // agg). When OMITTED — every existing test, any caller that doesn't want it —
  // the field is never emitted and the doc is byte-identical to today.
  meshAncestors?: MeshAncestorContext,
): Promise<Record<string, unknown> | null> {
  // Title-field repetition by authorship position.
  const titleParts: string[] = [];
  // D-exact — per-concept distinct-publication counter. Keyed by ANCESTOR concept
  // descriptor UI; each scholar pub increments a concept AT MOST ONCE (the
  // per-pub union below), so a pub carrying two in-subtree descriptors counts once
  // for their shared ancestor. Only populated when `meshAncestors` was passed.
  const subtreeAgg = meshAncestors ? new Map<string, number>() : null;
  // Per-term aggregation for the min-evidence threshold.
  const termAgg = new Map<
    string,
    { distinctPubs: number; hasFirstOrLast: boolean; weightedCount: number }
  >();
  // Issue #310 / SPEC §6.1.3 — per-descriptor-UI aggregation, parallel to
  // `termAgg`. Feeds the `publicationMeshUi` keyword rollup the v3 topic-shape
  // attribution boost filters on (`terms { publicationMeshUi: descendantUis }`).
  // The people index's `publicationMesh` holds analyzed *label text*, so it
  // cannot be matched against MeSH descriptor UIs — this dedicated keyword set
  // is what makes the descendant-UI subsumption filter possible. The set is
  // dedup-only (no weight repetition): the attribution filter is binary
  // membership, not BM25 scoring. The SAME min-evidence threshold as the label
  // field is applied below, so drive-by single-mention descriptors don't fire
  // the boost.
  const uiAgg = new Map<string, { distinctPubs: number; hasFirstOrLast: boolean }>();
  // CONTRACT A — per-label distinct-publication frequency for the `topMeshTerms`
  // rollup (the People-tab "TOPICS" identity hint). Counts each MeSH descriptor
  // LABEL once per distinct publication it appears on (deduped within a pub),
  // matching `lib/api/profile.ts`'s `aggregateKeywords` semantics. Built over the
  // SAME suppression-filtered authorship set as `publicationMesh` below, so a
  // hidden / dark pub never contributes a label.
  const topMeshAgg = new Map<string, { count: number; ui: string | null }>();
  // Issue #21 — collect each scholar's abstract texts (one copy per pmid;
  // duplicates can occur if the same publication shows up twice in a
  // listing, so dedupe).
  const abstractParts: string[] = [];
  const seenAbstractPmids = new Set<string>();

  let kept = 0;
  for (const a of s.authorships) {
    // Phase 4b C4 — skip pubs the scholar hid + dark pmids. Both keep this
    // authorship out of every content rollup (publicationTitles / Mesh /
    // Abstracts) AND out of publicationCount / isComplete / mostRecentPubDate.
    // No derived-dark check is needed on the people side: if the scholar is
    // a displayed author the pub isn't derived-dark from their authorship;
    // if they hid it the per-author rule already skips. Same reasoning as
    // the 4a plan §4 profile.ts own-list.
    if (isAuthorHidden(sup, a.pmid, s.cwid) || sup.darkPmids.has(a.pmid)) continue;
    kept += 1;

    const kind = classifyAuthorship(a);
    const weight = AUTHORSHIP_WEIGHTS[kind];

    // Repeat the title `weight` times.
    for (let i = 0; i < weight; i++) titleParts.push(a.publication.title);

    // Issue #21 — abstract: one copy per distinct pmid, no weight repetition.
    if (a.publication.abstract && !seenAbstractPmids.has(a.pmid)) {
      seenAbstractPmids.add(a.pmid);
      abstractParts.push(a.publication.abstract);
    }

    // {ui,label} pairs — `.map(p => p.label)` is byte-identical to the former
    // `extractMeshLabels(...)`, so `termAgg`/`mesh` behavior is unchanged; the
    // pairs additionally carry the descriptor `ui` for the `topMeshTerms` rollup.
    const meshPairs = extractMeshTermPairs(a.publication.meshTerms);
    const mesh = meshPairs.map((p) => p.label);
    // CONTRACT A — count each LABEL at most once per pub for `topMeshTerms`
    // frequency (deduped within a pub, like `aggregateKeywords`), carrying the
    // first non-null `ui` seen for that label. `termAgg` below intentionally
    // keeps its existing per-occurrence accumulation over the labels.
    const seenTopMeshThisPub = new Set<string>();
    for (const { label, ui } of meshPairs) {
      if (seenTopMeshThisPub.has(label)) continue;
      seenTopMeshThisPub.add(label);
      const agg = topMeshAgg.get(label) ?? { count: 0, ui: null };
      agg.count += 1;
      if (agg.ui === null && ui !== null) agg.ui = ui;
      topMeshAgg.set(label, agg);
    }
    for (const term of mesh) {
      const cur = termAgg.get(term) ?? {
        distinctPubs: 0,
        hasFirstOrLast: false,
        weightedCount: 0,
      };
      cur.distinctPubs += 1;
      if (kind === "firstOrLast") cur.hasFirstOrLast = true;
      cur.weightedCount += weight;
      termAgg.set(term, cur);
    }

    // Issue #310 — accumulate descriptor UIs in lock-step with the labels.
    // `extractMeshDescriptorUis` dedupes within a pub, so each UI counts once
    // per distinct pub here — the same distinct-pub semantics the threshold below uses.
    const pubMeshUis = extractMeshDescriptorUis(a.publication.meshTerms);
    for (const ui of pubMeshUis) {
      const cur = uiAgg.get(ui) ?? { distinctPubs: 0, hasFirstOrLast: false };
      cur.distinctPubs += 1;
      if (kind === "firstOrLast") cur.hasFirstOrLast = true;
      uiAgg.set(ui, cur);
    }

    // D-exact — fold this pub's descriptors up to their ANCESTOR concepts and
    // count each concept ONCE for this pub (the union below is the correctness
    // crux: a pub tagged by two descriptors in the same subtree must count 1, not
    // 2). Only runs when the ETL passed the ancestor context.
    if (subtreeAgg && meshAncestors) {
      const conceptsThisPub = new Set<string>();
      for (const ui of pubMeshUis) {
        const tns = meshAncestors.treeNumbersByUi.get(ui) ?? [];
        for (const concept of ancestorUisFor(meshAncestors.index, ui, tns)) {
          conceptsThisPub.add(concept);
        }
      }
      for (const concept of conceptsThisPub) {
        subtreeAgg.set(concept, (subtreeAgg.get(concept) ?? 0) + 1);
      }
    }
  }

  // Apply min-evidence threshold and emit term repetitions.
  const meshParts: string[] = [];
  for (const [term, agg] of termAgg.entries()) {
    if (agg.distinctPubs < 2 && !agg.hasFirstOrLast) continue;
    for (let i = 0; i < agg.weightedCount; i++) meshParts.push(term);
  }

  // Issue #310 — same min-evidence gate as the labels above, emitted once per
  // surviving descriptor (a deduped keyword set). A descriptor counts if it
  // appears on >= 2 of the scholar's pubs OR on any first/last-author pub.
  const publicationMeshUi: string[] = [];
  for (const [ui, agg] of uiAgg.entries()) {
    if (agg.distinctPubs < 2 && !agg.hasFirstOrLast) continue;
    publicationMeshUi.push(ui);
  }

  // CONTRACT A — top-8 MeSH descriptor labels by distinct-pub frequency
  // (count DESC, then label ASC). OMIT-on-empty: scholars with no MeSH on any
  // visible pub write nothing for this field (mirrors `publicationMeshUi`).
  const topMeshTerms = topMeshTermsFromCounts(topMeshAgg);

  // D-exact — materialize the per-concept distinct-pub map for the People reason
  // line. `meshSubtreeCounts[conceptUi]` = the scholar's distinct visible pubs
  // with >= 1 descriptor in that concept's subtree (self-inclusive). The query
  // path looks up the RESOLVED concept's UI in O(1) — no publications-index agg.
  // OMIT-on-empty (and absent entirely when `meshAncestors` wasn't passed).
  const meshSubtreeCounts: Record<string, number> | null =
    subtreeAgg && subtreeAgg.size > 0 ? Object.fromEntries(subtreeAgg) : null;

  // Issue #233 — `hasActiveGrants` realigned onto NCE 12-month grace
  // semantics so the People-tab Activity facet, the PI facet, and the
  // Funding tab all share one definition of "currently active." Small
  // behavior delta: grants in their NCE window flip from "inactive" to
  // "active" here.
  const now = new Date();
  const PI_ROLES = new Set(["PI", "PI-Subaward"]);
  const hasActiveGrants = s.grants.some((g) => isFundingActive(g.endDate, now));
  const piRoleEver = s.grants.some((g) => PI_ROLES.has(g.role));
  const activePiGrantCount = s.grants.reduce((n, g) => {
    if (!PI_ROLES.has(g.role)) return n;
    if (!isFundingActive(g.endDate, now)) return n;
    if (isTrainingOnlyGrant(g)) return n;
    return n + 1;
  }, 0);
  const isComplete = !!s.overview && kept >= 3 && hasActiveGrants ? true : false;
  // Phase 2 — sourced from ED ETL derivation (lib/eligibility.ts RoleCategory).
  // "unknown" only fires for scholars whose ED ETL has not yet backfilled
  // role_category (transitional state during the first refresh after migration).
  const personType = s.roleCategory ?? "unknown";

  const aoi = s.topicAssignments.map((t) => t.topic).join(" ");

  // Most recent publication date for the "Most recent publication" sort
  // option (spec line 194). Pull from authorships; null-safe. Phase 4b C4
  // filters hidden/dark pmids out of the candidate set with the same
  // predicate as the loop above — `pmid` is added to the `select` to make
  // the filter possible.
  const pubDates = await client.publicationAuthor.findMany({
    where: { cwid: s.cwid, isConfirmed: true },
    select: { pmid: true, publication: { select: { dateAddedToEntrez: true } } },
  });
  const mostRecentPubDate =
    pubDates
      .filter(
        (p) => !isAuthorHidden(sup, p.pmid, s.cwid) && !sup.darkPmids.has(p.pmid),
      )
      .map((p) => p.publication.dateAddedToEntrez)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  // OpenSearch's `completion` suggester matches a PREFIX of the input
  // string (not tokens within it), so feeding only `preferredName` ("M.
  // Cary Reid") means queries like "Cary" or "Reid" never resolve. Add a
  // suggestion input for every trailing-token slice ("Cary Reid", "Reid")
  // plus a "Last, First" variant so middle-name and last-name search both
  // work without changing the mapping. The suggest API resolves matched
  // docs back to preferredName via mget, so the dropdown still shows the
  // canonical full name regardless of which slice matched.
  const displayName = s.postnominal
    ? `${s.preferredName}, ${s.postnominal}`
    : s.preferredName;
  const nameSuggestInputs: Array<{ input: string; weight: number }> = [
    { input: displayName, weight: 100 },
    // CWID is the canonical scholar identifier; a prefix match resolves
    // back to the canonical preferredName via mget in suggestNames(),
    // so a paste of "pja2002" surfaces the same row a name lookup would.
    { input: s.cwid, weight: 99 },
  ];
  const slices = trailingNameSlices(s.preferredName);
  for (const slice of slices) {
    nameSuggestInputs.push({ input: slice, weight: 95 });
  }
  // "First Last" with middle tokens dropped — so "Ronald Crystal" matches
  // "Ronald G. Crystal". Apply to both preferredName and fullName since the
  // two can differ (e.g. fullName carries an unabridged middle name).
  const firstLastFromPreferred = firstLastSlice(s.preferredName);
  if (firstLastFromPreferred) {
    nameSuggestInputs.push({ input: firstLastFromPreferred, weight: 92 });
  }
  const firstLastFromFull = firstLastSlice(s.fullName);
  if (firstLastFromFull && firstLastFromFull !== firstLastFromPreferred) {
    nameSuggestInputs.push({ input: firstLastFromFull, weight: 92 });
  }
  const lastName = slices[slices.length - 1];
  if (lastName) {
    nameSuggestInputs.push({
      input: `${lastName}, ${s.preferredName}`,
      weight: 90,
    });
  }
  if (s.primaryTitle) {
    nameSuggestInputs.push({
      input: `${displayName} — ${s.primaryTitle}`,
      weight: 80,
    });
  }

  // Combined dept/division/center facet keys. The field is multi-valued
  // so a scholar with a primary appointment AND center memberships
  // contributes one bucket per affiliation. Labels are resolved
  // server-side in the page (see PeopleResults) — the keys here are
  // stable identifiers, the display strings come from Prisma.
  const deptName = s.department?.name ?? s.primaryDepartment ?? null;
  const divisionName = s.division?.name ?? null;
  const deptDivKeys: string[] = [];
  if (s.deptCode) {
    // Always emit the bare department key so the facet rail surfaces a
    // department roll-up bucket (e.g. "Medicine 682") alongside the
    // per-division detail buckets (#154 follow-up). Without this, scholars
    // who have a division (Cardiology, GI, etc.) only contribute to the
    // composite "Cardiology — Medicine" bucket and the umbrella department
    // disappears from the list when other facets narrow the result set.
    deptDivKeys.push(s.deptCode);
    if (s.divCode) {
      deptDivKeys.push(`${s.deptCode}--${s.divCode}`);
    }
  } else if (deptName) {
    // Long-tail: no FK code, free-text dept name. Use the name itself
    // as the key so the facet stays useful during the ED-backfill window.
    deptDivKeys.push(`name:${deptName}`);
  }
  // Per-scholar center memberships — sidecar query (see JSDoc). The batch
  // indexer now issues N of these instead of one whole-table preload; the
  // fast-path gets the one-cwid variant for free.
  //
  // #552 Phase 6 — gate the facet keys on the §3.3 active predicate (the same
  // `isCenterMembershipActive` the public page uses). An inactive (lapsed) or
  // pending membership emits NO facet key, so an expired member drops out of
  // the center's People-tab bucket on the next nightly rebuild — consistent
  // with PR-4's public page. Date-derived status re-evaluates every rebuild
  // automatically; no new step.
  //
  // #1074 — only the `center:<code>` key belongs in the combined
  // dept/division/center facet. Center *programs* are intentionally NOT emitted
  // here: a per-program facet is a center-page concern (#906/#911, sourced
  // directly from Prisma in lib/api/centers.ts), and a raw `centerProgram:<code>`
  // bucket leaked into the global People-tab browse facet with no label
  // resolution. Keeping programs off this field is the fix at the source.
  const centerToday = new Date().toISOString().slice(0, 10);
  const centerRows = await client.centerMembership.findMany({
    where: { cwid: s.cwid },
    select: {
      centerCode: true,
      startDate: true,
      endDate: true,
    },
  });
  for (const row of centerRows) {
    if (!isCenterMembershipActive(row.startDate, row.endDate, centerToday)) {
      continue;
    }
    deptDivKeys.push(`center:${row.centerCode}`);
  }
  // #540 Phase 8 — manual-roster division facet keys. A scholar manually
  // rostered into a `source='manual'` division contributes the division's
  // facet bucket on their search document, so the division is filterable in
  // /people search before LDAP adoption (SPEC line 162; edge 13). When LDAP
  // later adopts the division (edge 15) the LDAP-derived
  // `${deptCode}--${divCode}` key (above) collides with this roster-derived
  // key and dedups naturally — see the `Array.from(new Set(...))` below.
  // `DivisionMembership` is unrelated to `CenterMembership`'s `center:`
  // prefix; division facet keys share the LDAP-side namespace.
  const divRosterRows = await client.divisionMembership.findMany({
    where: { cwid: s.cwid },
    select: { divisionCode: true },
  });
  if (divRosterRows.length > 0) {
    const divs = await client.division.findMany({
      where: {
        code: { in: divRosterRows.map((r) => r.divisionCode) },
        source: "manual",
      },
      select: { code: true, deptCode: true },
    });
    for (const d of divs) {
      deptDivKeys.push(`${d.deptCode}--${d.code}`);
    }
  }
  void divisionName; // retained for potential future enrichment

  // Issue #532 — leadership sidecar queries. `Department.chairCwid` and
  // `Division.chiefCwid` are populated by the ED ETL with override-applied
  // values (ADR-002 Path B prediction + Path C `data/division-chiefs.txt`
  // manual overrides), so reading them here yields the authoritative chair /
  // chief set. Both queries are point lookups on indexed columns; the
  // expected row count for any one scholar is 0 (almost all), 1 (chairs /
  // chiefs), or rarely >1 (cross-dept appointments). Stored lowercased
  // because the dept-template's `function_score` term filter is matched
  // against `query.trim().toLowerCase()` and the classifier's
  // `knownDepartments` set is itself lowercased.
  const [chairedDepartments, chieffedDivisions] = await Promise.all([
    client.department.findMany({
      where: { chairCwid: s.cwid },
      select: { name: true },
    }),
    client.division.findMany({
      where: { chiefCwid: s.cwid },
      select: { name: true },
    }),
  ]);
  const chairOf = chairedDepartments.map((d) => d.name.toLowerCase());
  const chiefOf = chieffedDivisions.map((d) => d.name.toLowerCase());
  const isChair = chairOf.length > 0;
  const isChief = chiefOf.length > 0;
  const leadershipField =
    isChair || isChief
      ? { leadership: { isChair, chairOf, isChief, chiefOf } }
      : {};

  // Issue #824 §4c — public method-family rollup (omit-on-empty). Only built
  // when a `gate` is passed (the ETL + the live reconciler, both with
  // `forceSensitive: true`); a gate-less call skips the query entirely so every
  // existing caller / test is byte-identical. Sidecar query mirrors the
  // `centerMembership` block above. Each family is filtered through the SAME
  // #800/#801 gate (`isFamilyPubliclyVisible`) the public Method pages use, then
  // its label and its exemplar-tool DISPLAY NAMES are collected into one deduped,
  // insertion-ordered set — so a method query matches on either the family name
  // or a representative tool. `exemplarTools` is a `Json` column: guard the
  // array shape, coerce each entry to a trimmed string, drop empties.
  let methodFamilyField: { methodFamily: string } | Record<string, never> = {};
  // #1119 — sibling rollup of the visible families' tool-USAGE snippets, indexed in
  // its own `methodContext` field so usage language is matchable (gated query-side
  // by SEARCH_PEOPLE_METHOD_CONTEXT). Built from the SAME gate + sidecar query.
  let methodContextField: { methodContext: string } | Record<string, never> = {};
  if (gate) {
    const famRows = await client.scholarFamily.findMany({
      where: { cwid: s.cwid },
      select: {
        supercategory: true,
        familyLabel: true,
        exemplarTools: true,
        exemplarContexts: true,
      },
    });
    const methodTerms = new Set<string>();
    const contextSnippets = new Set<string>();
    for (const r of famRows) {
      if (!isFamilyPubliclyVisible(r.supercategory, r.familyLabel, gate)) continue;
      const label = r.familyLabel.trim();
      if (label) methodTerms.add(label);
      if (Array.isArray(r.exemplarTools)) {
        for (const t of r.exemplarTools) {
          const name = String(t).trim();
          if (name) methodTerms.add(name);
        }
      }
      // #1119 — collect the per-exemplar usage snippets (values of the JSON map).
      if (
        r.exemplarContexts &&
        typeof r.exemplarContexts === "object" &&
        !Array.isArray(r.exemplarContexts)
      ) {
        for (const v of Object.values(r.exemplarContexts as Record<string, unknown>)) {
          const snippet = typeof v === "string" ? v.trim() : "";
          if (snippet) contextSnippets.add(snippet);
        }
      }
    }
    if (methodTerms.size > 0) {
      methodFamilyField = { methodFamily: Array.from(methodTerms).join(" ") };
    }
    if (contextSnippets.size > 0) {
      methodContextField = { methodContext: Array.from(contextSnippets).join(" ") };
    }
  }

  return {
    cwid: s.cwid,
    slug: s.slug,
    preferredName: displayName,
    lastNameSort: extractLastNameSort(s.preferredName),
    // Append postnominal to fullName for search recall ("Curtis Cole MD"
    // matching), keep the constructed full form as a fallback.
    fullName: s.postnominal ? `${s.fullName}, ${s.postnominal}` : s.fullName,
    primaryTitle: s.primaryTitle,
    primaryDepartment: s.primaryDepartment,
    deptCode: s.deptCode,
    divCode: s.divCode,
    deptName,
    divisionName: s.division?.name ?? null,
    deptDivKey: Array.from(new Set(deptDivKeys)),
    nameSuggest: nameSuggestInputs,
    areasOfInterest: aoi,
    // CONTRACT A — top MeSH descriptor labels for the People-tab "TOPICS"
    // identity hint (gated query-side by SEARCH_PEOPLE_CONCEPT_HINT). OMIT-on-
    // empty: scholars with no MeSH on any visible pub write nothing for this
    // field, so `_source` consumers distinguish "no signal" from "[]".
    ...(topMeshTerms.length > 0 ? { topMeshTerms } : {}),
    overview: s.overview,
    publicationTitles: titleParts.join(" "),
    publicationMesh: meshParts.join(" "),
    // Issue #310 — descriptor-UI rollup for the v3 topic-shape attribution
    // boost. OMIT-on-empty (mirrors the pub doc's `meshDescriptorUi`): scholars
    // with no surviving descriptor write nothing, so `_source` consumers and the
    // `terms` filter distinguish "no signal" from "[]".
    ...(publicationMeshUi.length > 0 ? { publicationMeshUi } : {}),
    // D-exact (search reason-from-doc) — per-concept distinct-pub counts the
    // People reason line reads at query time (O(1) lookup by resolved concept UI),
    // taking the publications-index reason agg off the search path. OMIT-on-empty
    // and absent unless the ETL passed the ancestor context.
    ...(meshSubtreeCounts ? { meshSubtreeCounts } : {}),
    // Issue #310 / SPEC §6.1.5 — indexed inputs to the topic-shape sparse-profile
    // soft decay (×0.7). The decay's thresholds (overview length > 200, ≥3 AOI
    // terms) aren't expressible against the analyzed `overview` / `areasOfInterest`
    // text at query time, so they're materialized here as integers the
    // function_score range filter reads directly. `aoiTermCount` is the count of
    // topic assignments (the "topic-assignment terms" §6.1.5 names), not a token
    // count of the joined string.
    overviewLength: s.overview?.length ?? 0,
    aoiTermCount: s.topicAssignments.length,
    publicationAbstracts: abstractParts.join(" "),
    hasActiveGrants,
    piRoleEver,
    activePiGrantCount,
    isComplete,
    personType,
    publicationCount: kept,
    grantCount: s.grants.length,
    mostRecentPubDate,
    // Issue #532 — leadership signal (OMIT-on-empty: scholars who are
    // neither chair nor chief write nothing for this field, mirroring
    // `publicationMeshUi` / `topicImpacts`).
    ...leadershipField,
    // Issue #824 §4c — public method-family rollup (OMIT-on-empty, gate-only).
    // Empty `{}` unless a gate was passed AND ≥1 overlay-visible family exists.
    ...methodFamilyField,
    // #1119 — public method-family tool-USAGE snippets (OMIT-on-empty, gate-only).
    ...methodContextField,
  };
}

/**
 * Issue #254 §10 — global output-bucket classifier for the autocomplete §6
 * primary tiebreak. Buckets a scholar's displayed `publicationCount` into
 * `pubCountBucket ∈ {0..4}`:
 *
 *   - 0    — zero displayed publications
 *   - 1..4 — quartiles of the *nonzero* population (4 = most prolific)
 *
 * Quartiling the nonzero population (not the whole corpus) keeps the large
 * mass of zero / low-output scholars from collapsing all four cut points into
 * a single bucket. The value bucketed is the same `publicationCount` already on
 * the people doc (`= kept`, the post-suppression displayed count), so the
 * bucket can never disagree with the count the user sees.
 *
 * `buildPeopleDoc` cannot set this itself — the bucket needs the whole
 * distribution — so the ETL builds every doc, then calls this once and stamps
 * `bucketOf(doc.publicationCount)` on each (`etl/search-index/index.ts`).
 *
 * Pure: same `counts` → same thresholds + classifier. Thresholds are recomputed
 * per index build, so ordering is deterministic per build (all §6 requires).
 */
export function computePubCountBuckets(counts: number[]): {
  /** Q1/Q2/Q3 cut points over the sorted nonzero population. */
  thresholds: [number, number, number];
  bucketOf: (n: number) => 0 | 1 | 2 | 3 | 4;
} {
  const nonzero = counts.filter((c) => c > 0).sort((a, b) => a - b);
  const n = nonzero.length;
  if (n === 0) {
    // No nonzero scholars in the corpus (degenerate / empty index): keep zeros
    // at 0; any positive count tops out rather than throwing.
    return { thresholds: [0, 0, 0], bucketOf: (v) => (v > 0 ? 4 : 0) };
  }
  // Quarter-boundary thresholds: `at(k)` is the count at the end of quarter k
  // of the sorted nonzero population, so `v <= t_k` partitions counts into
  // contiguous, (near-)equal quarters. Equal-value runs that straddle a
  // boundary fall to the lower bucket — you can't split tied counts. Indices
  // are clamped so single-element / tiny populations don't underflow.
  const at = (k: number) =>
    nonzero[Math.min(n - 1, Math.max(0, Math.floor((k * n) / 4) - 1))]!;
  const t1 = at(1);
  const t2 = at(2);
  const t3 = at(3);
  const bucketOf = (v: number): 0 | 1 | 2 | 3 | 4 => {
    if (v <= 0) return 0;
    if (v <= t1) return 1;
    if (v <= t2) return 2;
    if (v <= t3) return 3;
    return 4;
  };
  return { thresholds: [t1, t2, t3], bucketOf };
}
