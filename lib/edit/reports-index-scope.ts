/**
 * The reports index's scope segments (`components/edit/reports-index.tsx`),
 * in display order. Plain data in its own module so the server page can parse
 * `?scope=` with the same list: a function exported from a "use client" module
 * can't be called from a server component.
 */
export type ReportsIndexScope =
  | "all"
  | "institution"
  | "program"
  | "center"
  | "department"
  | "division"
  | "core";

export const REPORTS_INDEX_SCOPES: ReadonlyArray<readonly [ReportsIndexScope, string]> = [
  ["all", "All"],
  ["institution", "Institution-wide"],
  ["program", "Programs"],
  ["center", "Centers"],
  ["department", "Departments"],
  ["division", "Divisions"],
  ["core", "Cores"],
];

export function parseReportsIndexScope(raw: string | undefined): ReportsIndexScope {
  return REPORTS_INDEX_SCOPES.some(([k]) => k === raw) ? (raw as ReportsIndexScope) : "all";
}
