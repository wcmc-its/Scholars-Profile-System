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

import { isFundingActive } from "@/lib/api/search-funding";
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

/**
 * Extract NLM MeSH descriptor UIs from `Publication.meshTerms`.
 *
 * The JSON column shape verified at the time of this PR (2026-05): 100% of
 * rows with non-empty `mesh_terms` are arrays of `{ ui, label }` objects.
 * No bare-string rows remain in production. The bare-string branch in
 * `extractMeshLabels` is dead code in the current corpus but is preserved
 * there for defense-in-depth; here we only emit UIs from the object shape.
 *
 * Returns deduped UIs in source order. Drops rows missing a valid string
 * `ui` (defensive — should be unreachable under the ETL contract per #278).
 *
 * Exported for unit tests.
 */
export function extractMeshDescriptorUis(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || !("ui" in item)) continue;
    const ui = (item as { ui: unknown }).ui;
    if (typeof ui !== "string" || ui.length === 0) continue;
    if (seen.has(ui)) continue;
    seen.add(ui);
    out.push(ui);
  }
  return out;
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

/**
 * Extract the surname token from a "Given Last" preferredName. Strips
 * trailing generational suffixes ("Jr", "II", etc.) so "Smith Jr" yields
 * "Smith". Returns "" for empty input. Used to populate the keyword
 * `lastNameSort` field on each people doc — see issue #82.
 */
export function extractLastNameSort(name: string): string {
  if (!name) return "";
  const raw = name.trim().split(/\s+/).filter(Boolean);
  if (raw.length === 0) return "";
  const SUFFIXES = /^(Jr|Sr|I{1,3}|IV|V|VI{0,3}|Esq)\.?,?$/i;
  let end = raw.length;
  while (end > 1 && SUFFIXES.test(raw[end - 1])) end -= 1;
  return raw[end - 1].toLowerCase();
}

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
  grants: true,
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
 * Build the OpenSearch publication `_source` for `p`. Pure — given the row,
 * the output is deterministic. The caller wraps as
 * `{ pmid: p.pmid, doc: buildPublicationDoc(p) }` for the bulk-index action;
 * `_id` is set by the caller.
 *
 * C2 — pure relocation of the inline body from `indexPublications`. No
 * suppression filtering; C3 will add `loadAllPublicationSuppressions` plus
 * `isAuthorHidden` / `isPublicationDark` integration here.
 */
export function buildPublicationDoc(p: PublicationForIndex): Record<string, unknown> {
  const authorNames = p.authors
    .map((a) => a.externalName ?? a.scholar?.preferredName ?? "")
    .filter(Boolean)
    .join(", ");

  const wcmAuthorRows = p.authors.filter(
    (a) => a.scholar && !a.scholar.deletedAt && a.scholar.status === "active",
  );
  const wcmAuthors = wcmAuthorRows.map((a) => ({
    cwid: a.scholar!.cwid,
    slug: a.scholar!.slug,
    preferredName: a.scholar!.preferredName,
    position: a.position,
  }));

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
 * Build the OpenSearch people `_source` for `s`. Carries a per-scholar
 * `mostRecentPubDate` query (issue: an inline N+1 in the build loop —
 * see plan §2.2 for why it is not consolidated into the `s.authorships`
 * join: the two queries have different `publicationType` filters), hence
 * the `client` parameter and the non-purity. The suppression-application
 * that C4 adds is itself pure and unit-testable with a mocked client.
 *
 * `centerCodes` is the scholar's center memberships, pre-loaded by the
 * caller (the batch indexer loads a `centerCodesByCwid` map once before
 * the scholar loop; the C5 fast-path queries the single scholar's
 * memberships).
 *
 * C2 — pure relocation of the inline body from `indexPeople`. No
 * suppression filtering yet.
 */
export async function buildPeopleDoc(
  s: ScholarForIndex,
  centerCodes: readonly string[],
  client: Pick<PrismaClient, "publicationAuthor">,
): Promise<Record<string, unknown>> {
  // Title-field repetition by authorship position.
  const titleParts: string[] = [];
  // Per-term aggregation for the min-evidence threshold.
  const termAgg = new Map<
    string,
    { distinctPubs: number; hasFirstOrLast: boolean; weightedCount: number }
  >();
  // Issue #21 — collect each scholar's abstract texts (one copy per pmid;
  // duplicates can occur if the same publication shows up twice in a
  // listing, so dedupe).
  const abstractParts: string[] = [];
  const seenAbstractPmids = new Set<string>();

  for (const a of s.authorships) {
    const kind = classifyAuthorship(a);
    const weight = AUTHORSHIP_WEIGHTS[kind];

    // Repeat the title `weight` times.
    for (let i = 0; i < weight; i++) titleParts.push(a.publication.title);

    // Issue #21 — abstract: one copy per distinct pmid, no weight repetition.
    if (a.publication.abstract && !seenAbstractPmids.has(a.pmid)) {
      seenAbstractPmids.add(a.pmid);
      abstractParts.push(a.publication.abstract);
    }

    const mesh = extractMeshLabels(a.publication.meshTerms);
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
  }

  // Apply min-evidence threshold and emit term repetitions.
  const meshParts: string[] = [];
  for (const [term, agg] of termAgg.entries()) {
    if (agg.distinctPubs < 2 && !agg.hasFirstOrLast) continue;
    for (let i = 0; i < agg.weightedCount; i++) meshParts.push(term);
  }

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
  const isComplete =
    !!s.overview && s.authorships.length >= 3 && hasActiveGrants ? true : false;
  // Phase 2 — sourced from ED ETL derivation (lib/eligibility.ts RoleCategory).
  // "unknown" only fires for scholars whose ED ETL has not yet backfilled
  // role_category (transitional state during the first refresh after migration).
  const personType = s.roleCategory ?? "unknown";

  const aoi = s.topicAssignments.map((t) => t.topic).join(" ");

  // Most recent publication date for the "Most recent publication" sort
  // option (spec line 194). Pull from authorships; null-safe.
  const pubDates = await client.publicationAuthor.findMany({
    where: { cwid: s.cwid, isConfirmed: true },
    select: { publication: { select: { dateAddedToEntrez: true } } },
  });
  const mostRecentPubDate =
    pubDates
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
  for (const code of centerCodes) {
    deptDivKeys.push(`center:${code}`);
  }
  void divisionName; // retained for potential future enrichment

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
    deptDivKey: deptDivKeys,
    nameSuggest: nameSuggestInputs,
    areasOfInterest: aoi,
    overview: s.overview,
    publicationTitles: titleParts.join(" "),
    publicationMesh: meshParts.join(" "),
    publicationAbstracts: abstractParts.join(" "),
    hasActiveGrants,
    piRoleEver,
    activePiGrantCount,
    isComplete,
    personType,
    publicationCount: s.authorships.length,
    grantCount: s.grants.length,
    mostRecentPubDate,
  };
}
