/**
 * The popover props builder, apart from `report-access.ts` so it calls
 * `listReportAccess` through the module boundary (and tests can mock it).
 * Server-only.
 */
import type { ReportAccessPopoverPersonProps } from "@/components/edit/report-access-popover";
import type { EditSession } from "@/lib/auth/superuser";
import { fillDirectoryNames } from "@/lib/edit/directory-names";
import {
  canManageReportAccess,
  listReportAccess,
  REPORT_ACCESS_SCOPE_OPTIONS,
  WHOLE_REPORT_SCOPE_OPTIONS,
} from "@/lib/edit/report-access";

/** The "Who can run this report" popover props for a row-granted report:
 *  its grant rows (`grantedAt` as ISO), its scope options and whether this
 *  session may Add / Remove. ONE builder for the report page and the index
 *  row, so the two never disagree. */
export async function loadReportAccessPopoverProps(
  reportKey: string,
  session: Pick<EditSession, "isSuperuser" | "isCommsSteward">,
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
    scopeOptions: REPORT_ACCESS_SCOPE_OPTIONS[reportKey] ?? WHOLE_REPORT_SCOPE_OPTIONS,
    canManage: canManageReportAccess(session),
    note,
  };
}
