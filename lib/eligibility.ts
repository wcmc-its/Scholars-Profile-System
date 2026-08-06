/**
 * Role-category eligibility carve for algorithmic surfaces.
 *
 * Sources of truth:
 *   - design-spec-v1.7.1.md:352-356 — derivation rule (in ED ETL, see etl/ed/index.ts)
 *   - design-spec-v1.7.1.md:377-385 — general eligibility carve (Recent contributions, Selected research, Recent highlights)
 *   - 02-CONTEXT.md D-14 — Top scholars chip row narrowed override (Phase 2)
 *   - issue #536 — public-display carve (hide doctoral students from directed-traffic
 *     surfaces: search, browse, profile route, algorithmic home; relational mentions
 *     keep the name as plain text). See PUBLICLY_DISPLAYED_ROLES / isPubliclyDisplayed.
 */

/** All role categories derivable from ED ETL. Stored in scholar.role_category. */
export type RoleCategory =
  | "full_time_faculty"
  | "affiliated_faculty"
  // A WCM alumnus (ED person-type `affiliate-alumni`). A hidden identity class
  // like `doctoral_student` — not surfaced or faceted — but their publications
  // are retained (see buildPublicationDoc / #718). Distinct from
  // `affiliated_faculty`, which they were previously (wrongly) bucketed into.
  | "affiliate_alumni"
  | "postdoc"
  | "fellow"
  | "non_faculty_academic"
  | "non_academic"
  | "doctoral_student"
  | "instructor"
  | "lecturer"
  | "emeritus";

/**
 * Public-display carve (issue #536).
 *
 * Doctoral students and alumni (`affiliate_alumni`) are not surfaced on any
 * directed-traffic surface — people search + autocomplete, /browse, the
 * `/scholars/[slug]` profile route, and the algorithmic home surfaces. They
 * remain only as *relational* mentions (PhD-mentee names on a PI's profile,
 * co-authorship chips), where the name renders as plain text rather than a link.
 * Alumni are additionally soft-deleted in the ED ETL, so every `deletedAt`-keyed
 * hide site drops them; their publications are retained via the #718 alumni
 * keep-rule in `buildPublicationDoc`.
 *
 * This is an identity-class display rule, distinct from ELIGIBLE_ROLES (algorithmic
 * relevance) and TOP_SCHOLARS_ELIGIBLE_ROLES (PI-only chip row): a hidden role is
 * removed everywhere a profile link would be generated, not just from ranked surfaces.
 *
 * Every RoleCategory *except* `doctoral_student` and `affiliate_alumni` is publicly displayed.
 */
export const PUBLICLY_DISPLAYED_ROLES: ReadonlyArray<RoleCategory> = [
  "full_time_faculty",
  "affiliated_faculty",
  "postdoc",
  "fellow",
  "non_faculty_academic",
  "non_academic",
  "instructor",
  "lecturer",
  "emeritus",
] as const;

/**
 * The concrete `scholar.role_category` values the #536 carve hides, spelled out
 * for use in a Prisma where-clause (`PEOPLE_INDEX_WHERE`). Prisma cannot express
 * the `doctoral_student*` prefix that `isPubliclyDisplayed` matches, so the
 * suffixed variants are enumerated. `tests/unit/eligibility.test.ts` asserts every
 * entry here fails `isPubliclyDisplayed`, so the two halves cannot drift apart.
 */
export const HIDDEN_ROLE_CATEGORIES: ReadonlyArray<string> = [
  "doctoral_student",
  "doctoral_student_md",
  "doctoral_student_phd",
  "doctoral_student_mdphd",
  "affiliate_alumni",
] as const;

/**
 * Legacy `role_category` values the current ED ETL can no longer emit —
 * `deriveRoleCategory` (etl/ed/index.ts) folds voluntary / adjunct / courtesy /
 * emeritus into `affiliated_faculty` and has no `research_staff` branch — but which
 * pre-rewrite or out-of-band rows may still carry. The suffixed `doctoral_student_*`
 * values are proof that out-of-band writes happen: 1,875 staging rows carry them and
 * no version of this repo ever emitted them. Listed so the fail-closed check below
 * cannot hide a legitimately-visible historical row.
 *
 * ponytail: drop once a prod census of `SELECT role_category, COUNT(*) FROM scholar`
 * shows zero rows carrying these.
 */
const LEGACY_VISIBLE_ROLES = [
  "voluntary_faculty",
  "adjunct_faculty",
  "courtesy_faculty",
  "faculty_emeritus",
  "research_staff",
] as const;

const VISIBLE_ROLE_KEYS: ReadonlySet<string> = new Set<string>([
  ...PUBLICLY_DISPLAYED_ROLES,
  ...LEGACY_VISIBLE_ROLES,
]);

/**
 * Whether a scholar with this role may be surfaced on a public directed-traffic
 * surface (search/browse/profile/home) and rendered as a clickable profile link.
 *
 * **Fails CLOSED on an unrecognized role (#2202).** It used to fail open, which is
 * how a humanized display label (`"Doctoral student"`, `"MD student"` — produced by
 * `formatRoleCategory`) sailed through where the raw enum (`doctoral_student`) was
 * caught, publishing 684 doctoral students by name on public unit rosters. Anything
 * that is not a known visible role is now hidden, so a label/enum mixup de-links a
 * row instead of leaking one.
 *
 * `null`/`undefined` still returns true. That is absence of data (an un-backfilled
 * scholar), not an unrecognized token, and 21 of the 22 call sites read the raw
 * nullable column — failing closed on null would drop those scholars from the
 * profile route, the A–Z browse, the people index and the CSV export.
 */
export function isPubliclyDisplayed(
  role: RoleCategory | string | null | undefined,
): boolean {
  if (role == null) return true;
  // #1026 — the DB carries SUFFIXED student roles (doctoral_student_md / _phd /
  // _mdphd) that an exact-match check missed. Prefix-match covers every variant.
  // Case-folded because ROLE_DISPLAY carries an UPPER_SNAKE_CASE half and some
  // fixtures/legacy rows use it.
  const r = String(role).trim().toLowerCase();
  if (r.startsWith("doctoral_student")) return false;
  return VISIBLE_ROLE_KEYS.has(r);
}

/**
 * General eligibility carve — applies to scholar-attributed algorithmic surfaces:
 * Recent contributions (RANKING-01), Selected research carousel filtering (HOME-02),
 * Recent highlights (RANKING-02).
 *
 * NOT used by Top scholars chip row — that surface uses TOP_SCHOLARS_ELIGIBLE_ROLES below.
 * NOT used by Browse all research areas — D-03 explicitly suspends the eligibility filter
 * (enumerative surface).
 *
 * Source: design-spec-v1.7.1.md:377-385
 */
export const ELIGIBLE_ROLES: ReadonlyArray<RoleCategory> = [
  "full_time_faculty",
  "postdoc",
  "fellow",
] as const;

/**
 * Top scholars chip row override — Phase 2 narrows the carve to PIs only.
 * The chip row is for principal investigators specifically; postdocs / fellows /
 * doctoral students continue to appear on Recent contributions and elsewhere.
 *
 * Source: 02-CONTEXT.md D-14 (Phase 2 spec resolution, 2026-04-30).
 */
export const TOP_SCHOLARS_ELIGIBLE_ROLES: ReadonlyArray<RoleCategory> = [
  "full_time_faculty",
] as const;

/**
 * People-search Research-Area concentration boost (#1363) — the roles eligible to
 * RECEIVE the on-topic concentration lift in People search. Deliberately broader than
 * TOP_SCHOLARS_ELIGIBLE_ROLES (the FT-only chip row): search must be able to rank every
 * research role that can appear in results, or a concentrated affiliated expert (e.g. a
 * cross-appointed PI) gets structurally buried under boosted FT faculty regardless of
 * on-topic output. Mirrors the concept-axis path (getConceptScholarConcentration), which
 * filters no role. Search-only — does NOT touch the topic-page chip row.
 */
export const SEARCH_BOOST_ELIGIBLE_ROLES: ReadonlyArray<RoleCategory> = [
  "full_time_faculty",
  "affiliated_faculty",
  // #2211 — emeritus faculty were indistinguishable from `affiliated_faculty`
  // until the ED derivation stopped folding them in, so they have always been
  // boost-eligible. Listing them keeps the ranking IDENTICAL across that split;
  // omitting it would silently drop ~hundreds of senior scholars out of the
  // #1363 concentration lift as a side effect of a segmentation fix.
  "emeritus",
  "postdoc",
  "fellow",
] as const;
