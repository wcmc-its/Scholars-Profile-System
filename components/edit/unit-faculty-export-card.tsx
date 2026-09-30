/**
 * UnitFacultyExportCard — the department / division "Members" section (extends
 * the #1102 roster export to org units without a curated roster).
 *
 * A department / division has no editable roster (its members are ED-derived
 * faculty), so this read-only card just shows the faculty count + an "Export CSV"
 * link to `/edit/{unitType}/{code}/export`. It is only rendered when the
 * roster-export flag is on (the section is flag-gated), so the link always
 * resolves. A manual division additionally passes `manageHref` — the way into
 * its editable roster page.
 *
 * Laid out as the Edit Org Unit mockup's Members row (2026-09-25) via the shared
 * `UnitMembersSummary`.
 *
 * Server component — it reads the count directly from `db.read`. The count is the
 * same member set the public unit page shows (ED + manual-roster union for a
 * `source = 'manual'` division), so it matches the exported rows.
 */
import { db } from "@/lib/db";
import { UnitMembersSummary } from "@/components/edit/unit-members-summary";
import {
  countDepartmentRoster,
  countDivisionRoster,
  type FacultyExportClient,
} from "@/lib/edit/unit-faculty-export";

export async function UnitFacultyExportCard({
  unitType,
  code,
  source,
  manageHref,
}: {
  unitType: "department" | "division";
  code: string;
  source: string;
  /** A manual division's editable roster page. */
  manageHref?: string;
}) {
  const client = db.read as unknown as FacultyExportClient;
  const count =
    unitType === "department"
      ? await countDepartmentRoster(client, code)
      : await countDivisionRoster(client, code, source);

  return (
    <div data-slot="unit-faculty-export-card" data-testid="unit-faculty-count">
      <UnitMembersSummary
        description="Faculty in this unit, as shown on its public page. Export the full list as a CSV."
        count={count}
        countLabel="faculty"
        exportHref={`/edit/${unitType}/${encodeURIComponent(code)}/export`}
        manageHref={manageHref}
      />
    </div>
  );
}
