/**
 * #2537 — single source of truth for the "Appointment" role-category chip
 * groups, shared by the CLIENT chip UI (`components/department/role-chip-row.tsx`,
 * driven off this module) and the SERVER-side `?type=` roster filter
 * (`lib/api/unit-members.ts`, `lib/api/centers.ts`, and the
 * `/api/units/[kind]/[code]/members` route).
 *
 * Each group is defined by its DISPLAY labels (the `formatRoleCategory` /
 * `ROLE_DISPLAY` output the chip row already grouped on) — `groupToRawValues`
 * inverts `ROLE_DISPLAY` to recover the underlying `scholar.role_category` raw
 * values a server query can filter on, so the two layers can never drift: add a
 * display label to a group here and both the chip's client-side matcher and the
 * server's `roleCategory: { in: [...] } }` filter pick it up together.
 *
 * Server-safe: no client-only imports (no "use client", no React/Next). Only
 * dependency is `lib/role-display.ts`, itself a plain data module already
 * imported from both server (`lib/api/*.ts`) and client (`person-row.tsx`) code.
 */
import { ROLE_DISPLAY } from "@/lib/role-display";

export type RoleGroupLabel =
  | "All"
  | "Full-time faculty"
  | "Affiliated faculty"
  | "Postdocs & non-faculty"
  | "Doctoral students";

export type RoleGroupDef = {
  label: RoleGroupLabel;
  /**
   * DISPLAY labels (formatRoleCategory output) this group matches. Empty for
   * "All", which matches every row unconditionally — client code must special-case
   * it (never derive a `[]`-valued `IN (...)` filter from it) and the server route
   * rejects `type=All` outright (there is nothing to filter server-side).
   */
  displayLabels: readonly string[];
};

/**
 * The four filterable groups (context: `components/department/role-chip-row.tsx`
 * `ROLE_GROUPS`, verbatim) plus the "All" sentinel. "Full-time faculty" is exact;
 * "Affiliated faculty" folds Voluntary/Adjunct/Courtesy/Faculty-emeritus in;
 * "Postdocs & non-faculty" folds Postdoc/Fellow/Research-staff/Instructor/
 * Lecturer/Non-faculty-academic in; "Doctoral students" is exact "Doctoral
 * student" only — deliberately NOT "MD student" / "PhD student" / "MD-PhD
 * student" (those display labels have never matched this chip and this
 * module preserves that, not widens it).
 */
export const ROLE_GROUPS: readonly RoleGroupDef[] = [
  { label: "All", displayLabels: [] },
  { label: "Full-time faculty", displayLabels: ["Full-time faculty"] },
  {
    label: "Affiliated faculty",
    displayLabels: [
      "Affiliated faculty",
      "Voluntary faculty",
      "Adjunct faculty",
      "Courtesy faculty",
      "Faculty emeritus",
    ],
  },
  {
    label: "Postdocs & non-faculty",
    displayLabels: [
      "Postdoc",
      "Fellow",
      "Research staff",
      "Instructor",
      "Lecturer",
      "Non-faculty academic",
    ],
  },
  { label: "Doctoral students", displayLabels: ["Doctoral student"] },
];

/** Re-derived from `ROLE_GROUPS` — consumed by `role-chip-row.tsx` (deep-link
 *  `?type=` validation) and the server route's `type` validation. */
export const ROLE_CATEGORIES: RoleGroupLabel[] = ROLE_GROUPS.map((g) => g.label);

/** The four labels a server `type=` filter accepts — `ROLE_CATEGORIES` minus the
 *  "All" sentinel, which has no raw-value set to filter on. */
export const FILTERABLE_ROLE_GROUPS: RoleGroupLabel[] = ROLE_GROUPS.filter(
  (g) => g.label !== "All",
).map((g) => g.label);

/**
 * Raw `scholar.role_category` DB values for a group label, for a server-side
 * `roleCategory: { in: groupToRawValues(label) }` filter.
 *
 * Derived by inverting `ROLE_DISPLAY` — every raw key (both the UPPER_SNAKE_CASE
 * DB/ETL spelling and the lower_snake_case fixture spelling) whose mapped value is
 * one of the group's display labels — PLUS the display labels themselves, which
 * covers a raw DB value that happens to already equal its own display form (the
 * unmapped `ROLE_DISPLAY[raw] ?? raw` fallback in `formatRoleCategory`).
 *
 * Returns `[]` for "All" (and any unrecognized label) — callers must treat an
 * empty array as "no group-scoped filter can be built", never as "filter to
 * nothing"; the server route rejects `type=All` before this is ever called for it.
 */
export function groupToRawValues(label: RoleGroupLabel): string[] {
  const group = ROLE_GROUPS.find((g) => g.label === label);
  if (!group || group.displayLabels.length === 0) return [];
  const displaySet = new Set<string>(group.displayLabels);
  const raws = new Set<string>();
  for (const [raw, display] of Object.entries(ROLE_DISPLAY)) {
    if (displaySet.has(display)) raws.add(raw);
  }
  for (const display of group.displayLabels) raws.add(display);
  return [...raws];
}

/** Whether a DISPLAY label (formatRoleCategory output) belongs to a group —
 *  the client-side counterpart of `groupToRawValues`. "All" matches everything. */
export function groupMatchesDisplay(
  label: RoleGroupLabel,
  display: string | null,
): boolean {
  if (label === "All") return true;
  const group = ROLE_GROUPS.find((g) => g.label === label);
  if (!group) return false;
  return group.displayLabels.includes(display ?? "");
}
