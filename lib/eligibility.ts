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

const HIDDEN_DISPLAY_ROLES: ReadonlySet<RoleCategory> = new Set([
  "doctoral_student",
  "affiliate_alumni",
]);

/**
 * Whether a scholar with this role may be surfaced on a public directed-traffic
 * surface (search/browse/profile/home) and rendered as a clickable profile link.
 *
 * Fail-open for display: a `null`/`undefined`/unknown role is treated as publicly
 * displayed — only the explicit hidden identity classes (`doctoral_student`,
 * `affiliate_alumni`) are suppressed. This mirrors the index/route/link sites all
 * reading the same column.
 */
export function isPubliclyDisplayed(
  role: RoleCategory | string | null | undefined,
): boolean {
  if (role == null) return true;
  // #1026 / docs/student-profile-visibility.md ("Caveat: the role-name carve
  // does not match the live data") — the ED ETL writes SUFFIXED student roles
  // (doctoral_student_md / _phd / _mdphd) which are NOT in HIDDEN_DISPLAY_ROLES,
  // so a bare exact-match check failed OPEN (returned true = linkable) for live
  // students. Treat ANY `doctoral_student*` role as hidden by prefix. This only
  // ever TIGHTENS the carve and incidentally fixes the #847 export profile_url
  // fail-open for suffixed students. `affiliate_alumni` stays exact-match.
  const r = String(role);
  if (r.startsWith("doctoral_student")) return false;
  return !HIDDEN_DISPLAY_ROLES.has(role as RoleCategory);
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
