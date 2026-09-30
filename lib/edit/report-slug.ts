/**
 * The report slug rule (`report_meta.slug`, `lib/edit/report-meta.ts`) —
 * on its own so the `"use client"` editor (`report-details-sheet.tsx`) can
 * validate as the user types WITHOUT importing `report-meta.ts`, which reads
 * `@/lib/db` and would drag the mariadb driver into the client bundle (the
 * `manageable-units.ts` trap in CLAUDE.md; broke the Next build on `fs`/`net`
 * on 2026-09-20). No imports here on purpose.
 */

/** Cap on `slug` (the `report_meta.slug` column width). */
export const REPORT_SLUG_MAX = 64;

/** Whether `v` is a storable slug: lowercase letters, digits and single
 *  hyphens (`a-b-c`), 1..`REPORT_SLUG_MAX` chars, and NOT all digits — the
 *  digit namespace is the stable key (`/edit/reports/7` redirects to the
 *  slug), so a numeric slug would shadow it. Validation is shared by the
 *  route and the editor; uniqueness is the table's constraint. */
export function isValidReportSlug(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length <= REPORT_SLUG_MAX &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v) &&
    !/^\d+$/.test(v)
  );
}
