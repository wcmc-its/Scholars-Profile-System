/**
 * Role-category eligibility carve for algorithmic surfaces.
 *
 * Sources of truth:
 *   - design-spec-v1.7.1.md:352-356 — derivation rule (in ED ETL, see etl/ed/index.ts)
 *   - design-spec-v1.7.1.md:377-385 — general eligibility carve (Recent contributions, Selected research, Recent highlights)
 *   - 02-CONTEXT.md D-14 — Top scholars chip row narrowed override (Phase 2)
 */

/** All role categories derivable from ED ETL. Stored in scholar.role_category. */
export type RoleCategory =
  | "full_time_faculty"
  | "affiliated_faculty"
  | "postdoc"
  | "fellow"
  | "non_faculty_academic"
  | "non_academic"
  | "doctoral_student"
  | "instructor"
  | "lecturer"
  | "emeritus";

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
  "doctoral_student",
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
