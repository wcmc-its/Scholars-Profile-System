/**
 * UnitFacultyExportCard — the department / division "Members" tab (extends the
 * #1102 roster export to org units without a curated roster).
 *
 * A department / division has no editable roster (its members are ED-derived
 * faculty), so this read-only card just shows the faculty count + an "Export CSV"
 * link to `/edit/{unitType}/{code}/export`. It is only rendered when the
 * roster-export flag is on (the tab is flag-gated), so the link always resolves.
 *
 * Server component — it reads the count directly from `db.read`. The count is the
 * same member set the public unit page shows (ED + manual-roster union for a
 * `source = 'manual'` division), so it matches the exported rows.
 */
import { db } from "@/lib/db";
import { EditPanel } from "@/components/edit/edit-panel";
import {
  countDepartmentRoster,
  countDivisionRoster,
  type FacultyExportClient,
} from "@/lib/edit/unit-faculty-export";

export async function UnitFacultyExportCard({
  unitType,
  code,
  source,
}: {
  unitType: "department" | "division";
  code: string;
  source: string;
}) {
  const client = db.read as unknown as FacultyExportClient;
  const count =
    unitType === "department"
      ? await countDepartmentRoster(client, code)
      : await countDivisionRoster(client, code, source);

  return (
    <EditPanel
      slot="unit-faculty-export-card"
      heading="Members"
      description="The faculty in this unit, as shown on its public page. Export the full list as a CSV."
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm" data-testid="unit-faculty-count">
          <b className="font-medium">{count.toLocaleString()}</b>{" "}
          {count === 1 ? "faculty member" : "faculty members"}
        </p>
        <div>
          <a
            href={`/edit/${unitType}/${encodeURIComponent(code)}/export`}
            className="text-apollo-slate text-sm hover:underline"
            data-testid="unit-faculty-export-link"
          >
            Export CSV
          </a>
        </div>
      </div>
    </EditPanel>
  );
}
