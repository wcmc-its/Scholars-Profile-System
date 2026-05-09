import { cn } from "@/lib/utils";

/**
 * Author-position badge for publication rows on the profile (issue #72).
 *
 * Five role surfaces from the role-derivation logic in
 * `components/profile/publication-row.tsx`:
 *
 * - "First and senior author" → senior color family (blue), single-author and
 *   two-author papers where the profile owner is at both ends
 * - "Senior author"            → senior (blue)
 * - "Co-senior author"         → senior (blue), renamed from "Co-last author"
 * - "First author"             → first  color family (green)
 * - "Co-first author"          → first  (green)
 *
 * Same sizing + typography as the autocomplete `EntityBadge` family
 * (`.entity-badge` in `app/globals.css`); class definitions live alongside.
 *
 * Returns null for the no-role case (middle-author publications) so the
 * caller can render `<AuthorPositionBadge role={role} />` unconditionally
 * without a wrapper guard.
 */
export type AuthorPositionRole =
  | "First and senior author"
  | "Senior author"
  | "Co-senior author"
  | "First author"
  | "Co-first author";

const SENIOR_VARIANT = new Set<AuthorPositionRole>([
  "First and senior author",
  "Senior author",
  "Co-senior author",
]);

/**
 * Single source of truth for the role string a publication row displays.
 * Issue #18 introduced the co-first / co-last detection (counts of `isFirst`
 * / `isLast` flags across the WCM author list); issue #72 reuses the same
 * derivation for both the badge and the position filter so the two surfaces
 * never diverge. Returns null for middle-author publications.
 */
export function deriveAuthorPositionRole(
  authorship: { isFirst: boolean; isLast: boolean },
  wcmAuthors: ReadonlyArray<{ isFirst: boolean; isLast: boolean }>,
): AuthorPositionRole | null {
  const firstCount = wcmAuthors.filter((a) => a.isFirst).length;
  const lastCount = wcmAuthors.filter((a) => a.isLast).length;
  if (authorship.isFirst && authorship.isLast) return "First and senior author";
  if (authorship.isLast) return lastCount > 1 ? "Co-senior author" : "Senior author";
  if (authorship.isFirst) return firstCount > 1 ? "Co-first author" : "First author";
  return null;
}

/** Position filter buckets exposed in the UI (issue #72). */
export type PositionFilter = "all" | "first" | "senior" | "co_author";

/** Maps a derived role to the position-filter bucket it belongs to. Co-first
 *  matches `first`; co-senior matches `senior`. Middle-author publications
 *  (role === null) match `co_author`. */
export function positionBucketForRole(role: AuthorPositionRole | null): Exclude<PositionFilter, "all"> {
  if (role === null) return "co_author";
  if (role === "First author" || role === "Co-first author") return "first";
  if (role === "Senior author" || role === "Co-senior author") return "senior";
  // "First and senior author" — matches both first and senior; we put it under
  // senior here because the filter dropdown is single-select and PIs (the
  // typical owners of such two-author papers) browse by senior. The filter
  // logic special-cases this role to match both buckets — see
  // matchesPositionFilter below.
  return "senior";
}

/** Test whether a derived role matches a chosen position filter value. */
export function matchesPositionFilter(
  role: AuthorPositionRole | null,
  filter: PositionFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "co_author") return role === null;
  if (role === "First and senior author") return filter === "first" || filter === "senior";
  return positionBucketForRole(role) === filter;
}

/** Multi-select position bucket — non-"all" filters only. Empty array = no
 *  filter (match-all). Issue #77 makes the profile Position dropdown
 *  multi-select; the URL serializes this as a comma-separated list. */
export type SelectedPositions = ReadonlyArray<Exclude<PositionFilter, "all">>;

/** Test whether a derived role matches *any* of the selected position
 *  filters. Empty selection means no filter is applied. */
export function matchesAnyPosition(
  role: AuthorPositionRole | null,
  filters: SelectedPositions,
): boolean {
  if (filters.length === 0) return true;
  for (const f of filters) {
    if (matchesPositionFilter(role, f)) return true;
  }
  return false;
}

export function AuthorPositionBadge({
  role,
  className,
}: {
  role: AuthorPositionRole | null | undefined;
  className?: string;
}) {
  if (!role) return null;
  const variant = SENIOR_VARIANT.has(role) ? "senior" : "first";
  return (
    <span
      className={cn(
        "author-position-badge",
        `author-position-badge--${variant}`,
        className,
      )}
    >
      {role}
    </span>
  );
}
