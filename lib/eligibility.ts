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

/** The `OR` arm shape {@link publicRoleWhere} produces. */
export type PublicRoleWhere = {
  OR: Array<{ roleCategory: null } | { roleCategory: { notIn: string[] } }>;
};

/**
 * Prisma where-FRAGMENT admitting only publicly-displayable scholars — the
 * loader-level half of the #536 carve (#2202). Spread into a `scholar` where
 * clause (or into a `scholar: { … }` relation filter) so a hidden identity class
 * is never LOADED, rather than being loaded and then de-linked at render time.
 *
 * The `OR` is load-bearing, not stylistic. A bare
 * `{ roleCategory: { notIn: HIDDEN_ROLE_CATEGORIES } }` compiles to SQL
 * `role_category NOT IN (…)`, and in three-valued logic `NULL NOT IN (…)` is
 * NULL — not TRUE — so it silently DROPS every un-backfilled scholar. Admitting
 * NULL explicitly keeps `isPubliclyDisplayed(null) === true` and the where-clause
 * saying the same thing.
 *
 * Returns a FRESH object each call: it carries an `OR` key, so spreading it into
 * a where that already has its own `OR` would clobber that arm. Every call site
 * in `lib/api/{departments,divisions,centers,unit-members}.ts` was checked to
 * have no competing `OR` at the level it is spread into.
 *
 * Deliberately NOT applied to publication / grant / topic queries scoped to a
 * unit's members: #718 retains a hidden scholar's PUBLICATIONS, so carving the
 * member set that feeds those aggregates would silently delete real research
 * output from unit totals. Only surfaces that name or count PEOPLE carve.
 *
 * NOT SUFFICIENT ON ITS OWN. This is a DENYLIST and cannot fail closed: it
 * enumerates `HIDDEN_ROLE_CATEGORIES` because Prisma cannot express the
 * `doctoral_student*` prefix that `isPubliclyDisplayed` matches, so an
 * out-of-band suffixed value slips through it. (Those demonstrably exist — 1,875
 * staging rows carry suffixes no version of this repo ever wrote.) Any surface
 * that renders a per-row link or publishes a URL must ALSO run the raw
 * `role_category` through `isPubliclyDisplayed`, which prefix-matches and fails
 * closed. This fragment is the population gate; that predicate is the link gate.
 * On an anonymous, unauthenticated endpoint the pair IS the access control.
 *
 * Deliberately NOT typed as `Prisma.ScholarWhereInput`: this module is imported
 * by client components (e.g. `components/department/person-row.tsx`), and it must
 * stay free of generated-Prisma imports so nothing drags the mariadb driver into
 * the client bundle and breaks `next build` on `fs`/`net`.
 */
export function publicRoleWhere(): PublicRoleWhere {
  return {
    OR: [{ roleCategory: null }, { roleCategory: { notIn: [...HIDDEN_ROLE_CATEGORIES] } }],
  };
}

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
 * Every `role_category` token this repo RECOGNIZES — the visible roles plus the
 * hidden identity classes (`HIDDEN_ROLE_CATEGORIES`, which carries the suffixed
 * `doctoral_student_*` variants and `affiliate_alumni`). Membership here is the
 * only way to distinguish "a known role that is not a student" from "a token no
 * version of this enum ever emitted", which is what lets
 * {@link isEnrolledDoctoralStudent} fail closed without stripping a credential
 * off every legitimate role.
 */
const KNOWN_ROLE_KEYS: ReadonlySet<string> = new Set<string>([
  ...VISIBLE_ROLE_KEYS,
  ...HIDDEN_ROLE_CATEGORIES,
]);

/**
 * Whether this role is an ENROLLED doctoral student — i.e. someone still reading
 * for the degree, not someone who holds it.
 *
 * The `doctoral_student` PREFIX (not an exact match) is the whole point (#1026):
 * the DB carries suffixed variants `doctoral_student_md` / `_phd` / `_mdphd` that
 * an exact-match check missed. Case-folded because `ROLE_DISPLAY` carries an
 * UPPER_SNAKE_CASE half and some fixtures/legacy rows use it.
 *
 * **Fails CLOSED on an unrecognized token — same defence as {@link isPubliclyDisplayed},
 * for the same reason (#2202).** `formatRoleCategory` (`lib/role-display.ts`) turns
 * these very enum values into humanized labels — `doctoral_student` → `"Doctoral
 * student"`, `doctoral_student_md` → `"MD student"` — and BOTH queue loaders call it
 * on the line immediately after `formatPublishedName`. A prefix-only check answers
 * `false` for `"Doctoral student"`, so a two-line-apart label/enum mixup would republish
 * an enrolled student as "<name>, PhD" with no type error to catch it. That is exactly
 * the #2202 shape, where a humanized label sailing through a raw-enum check published
 * 684 students by name. Anything `KNOWN_ROLE_KEYS` does not contain is therefore treated
 * as enrolled.
 *
 * The asymmetry that justifies erring this way: suppressing a postnominal on an unknown
 * role costs a degree suffix on a name that still renders in full, while ADMITTING one
 * asserts a credential the person may not hold — which is the harm #2599 exists to stop.
 * Cheap miss, expensive false claim, so the unknown branch takes the cheap one.
 *
 * Returns FALSE for null/undefined — deliberately the opposite default from
 * {@link isPubliclyDisplayed}, and NOT the same case as an unrecognized token.
 * Absence of a role is not evidence of enrolment, so an un-backfilled scholar keeps
 * whatever credential ED recorded for them rather than having it silently stripped.
 *
 * Two consumers, one prefix: this gate (a) hides the enrollee from directed-traffic
 * surfaces via `isPubliclyDisplayed`, and (b) suppresses the degree postnominal in
 * `formatPublishedName` (#2599). Extracted so the prefix lives in exactly one place.
 */
export function isEnrolledDoctoralStudent(
  role: RoleCategory | string | null | undefined,
): boolean {
  if (role == null) return false;
  const key = String(role).trim().toLowerCase();
  if (key.startsWith("doctoral_student")) return true;
  return !KNOWN_ROLE_KEYS.has(key);
}

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
 *
 * BEHAVIOUR IS UNCHANGED by `isEnrolledDoctoralStudent` widening to fail closed
 * (#2599). The two branches partition the input: a token the widened predicate newly
 * answers `true` for is by construction absent from `KNOWN_ROLE_KEYS` ⊇
 * `VISIBLE_ROLE_KEYS`, so the final line would have returned `false` for it anyway.
 * Only the branch that produces the `false` moved. `tests/unit/eligibility.test.ts`
 * pins that equivalence directly.
 */
export function isPubliclyDisplayed(
  role: RoleCategory | string | null | undefined,
): boolean {
  if (role == null) return true;
  // #1026 — the SUFFIXED student roles are caught by the shared prefix predicate,
  // which also absorbs the unrecognized-token case this function used to reject on
  // its own final line (see the equivalence argument above).
  if (isEnrolledDoctoralStudent(role)) return false;
  return VISIBLE_ROLE_KEYS.has(String(role).trim().toLowerCase());
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
