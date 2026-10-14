/**
 * The popover props builder, apart from `report-access.ts` so it calls
 * `listReportAccess` through the module boundary (and tests can mock it).
 * Server-only.
 */
import type { ReportAccessPopoverPersonProps } from "@/components/edit/report-access-popover";
import { loadDataQualityFacets } from "@/lib/api/data-quality";
import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import { fillDirectoryNames } from "@/lib/edit/directory-names";
import {
  canManageReportAccess,
  listReportAccess,
  MENTORED_PUBS_REPORT,
  REPORT_ACCESS_SCOPE_OPTIONS,
  WHOLE_REPORT_SCOPE_OPTIONS,
} from "@/lib/edit/report-access";

/** Report 7's unit scope options (`isUnitScopeKey`): every center, department
 *  and division, labelled by kind — the tail of the grant select and the label
 *  of each unit grant row. */
async function unitScopeOptions(): Promise<Array<readonly [string, string]>> {
  const f = await loadDataQualityFacets(db.read);
  return [
    ...f.centers.map((c) => [c.value, `Center: ${c.label}`] as const),
    ...f.departments.map((d) => [d.value, `Department: ${d.label}`] as const),
    ...f.departments.flatMap((d) => d.divisions).map((d) => [d.value, `Division: ${d.label}`] as const),
  ];
}

/** The "Who can run this report" popover props for a row-granted report:
 *  its grant rows (`grantedAt` as ISO), its scope options and whether this
 *  session may Add / Remove. ONE builder for the report page and the index
 *  row, so the two never disagree. */
export async function loadReportAccessPopoverProps(
  reportKey: string,
  session: Pick<EditSession, "isSuperuser" | "isCommsSteward" | "isContentEditor">,
  note?: string,
): Promise<ReportAccessPopoverPersonProps> {
  // A grantee with no Scholar row and no stored name gets an ED name
  // (one fail-soft lookup; the CWID shows on any directory error).
  const rows = await fillDirectoryNames(
    await listReportAccess(reportKey),
    (r) => r.name,
    (r, name) => ({ ...r, name }),
  );
  return {
    mode: "person",
    reportKey,
    initialRows: rows.map((r) => ({ ...r, grantedAt: r.grantedAt.toISOString() })),
    scopeOptions:
      reportKey === MENTORED_PUBS_REPORT
        ? [...REPORT_ACCESS_SCOPE_OPTIONS[reportKey], ...(await unitScopeOptions())]
        : (REPORT_ACCESS_SCOPE_OPTIONS[reportKey] ?? WHOLE_REPORT_SCOPE_OPTIONS),
    // A content editor reads every report (its synthetic steward grant) but
    // never manages access; the write route refuses it regardless.
    canManage: canManageReportAccess(session) && session.isContentEditor !== true,
    note,
  };
}
